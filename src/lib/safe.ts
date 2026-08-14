'use client'

import { getAccount } from '@wagmi/core'
import {
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  hashTypedData,
  isAddressEqual,
  keccak256,
  stringToHex,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem'
import type { JBChainId } from '@bananapus/nana-sdk-core'
import { wagmiConfig } from '@/providers/Providers'
import { TESTNET_CHAINS } from '@/lib/chains'
import type { RelayrEntry } from '@/lib/relayr'
import { assertNoViewAs } from '@/lib/viewAs'
import {
  readBoundedSafeApprovedHash,
  readBoundedSafeNonce,
} from '@/lib/safe-reads'
import {
  isEip7702DelegatedEoaRuntime,
  isDeployableSafeAuthority,
  readAuthorityIdentity,
  readMatchingAuthorityIdentities,
  safeCreationMatchesAuthorityIdentity,
} from '@/lib/cross-chain-authority'
import {
  simulateStateChangingTransaction,
  TRANSACTION_SIMULATION_GAS,
} from '@/lib/transaction-simulation'
import {
  connectedWallet as connectedWalletCore,
  publicClient,
} from '@/lib/wallet-core'
import {
  requireContractTransactionReview,
  requireTransactionReview,
  type TransactionReviewRequest,
} from '@/lib/transaction-review'
import {
  isSafeConnection,
  safeServiceBase,
  SAFE_PREFIX,
  SAFE_SERVICE_PREFIX,
  waitForSafeExecutionHash,
} from '@/lib/safe-connector'

export type SafeInfo = {
  owners: Address[]
  threshold: number
}

type SafeConfirmation = {
  owner: Address
  signature?: Hex | null
}

export type SafeQueuedTx = {
  to: Address
  value: string | number
  data: Hex | null
  operation: number
  safeTxGas: string | number
  baseGas: string | number
  gasPrice: string | number
  gasToken: Address
  refundReceiver: Address
  nonce: number
  safeTxHash?: Hex
  contractTransactionHash?: Hex
  confirmationsRequired?: number
  confirmations?: SafeConfirmation[]
  isExecuted?: boolean
}

export type SafeCall = {
  chainId: JBChainId
  safe: Address
  target: Address
  data: Hex
  value?: bigint
  label?: string
  abi?: Abi
  functionName?: string
  args?: readonly unknown[]
  contractName?: string
  reverifyAuthority?: () => Promise<void>
}

export type SafeCallResult = {
  chainId: JBChainId
  mode: 'service' | 'onchain'
  status: 'queued' | 'approved' | 'executed' | 'waiting' | 'submitted'
  nonce: number
  safeTxHash: Hex
  transactionHash?: Hex
}

export type ConfirmedContractWrite = {
  hash: Hex
  status: 'confirmed' | 'submitted'
}

const SAFE_ABI = [
  {
    type: 'function',
    name: 'getThreshold',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'getOwners',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address[]' }],
  },
  {
    type: 'function',
    name: 'nonce',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
] as const

export const SAFE_EXEC_ABI = [
  {
    type: 'function',
    name: 'execTransaction',
    stateMutability: 'payable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
      { name: 'operation', type: 'uint8' },
      { name: 'safeTxGas', type: 'uint256' },
      { name: 'baseGas', type: 'uint256' },
      { name: 'gasPrice', type: 'uint256' },
      { name: 'gasToken', type: 'address' },
      { name: 'refundReceiver', type: 'address' },
      { name: 'signatures', type: 'bytes' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const

const SAFE_EXECUTION_SUCCESS_TOPIC = keccak256(
  stringToHex('ExecutionSuccess(bytes32,uint256)'),
)

function receiptHasSafeExecutionSuccess(
  receipt: {
    logs?: readonly {
      address: Address
      data: Hex
      topics: readonly Hex[]
    }[]
  },
  safe: Address,
  safeTxHash: Hex,
): boolean {
  const expectedHash = safeTxHash.toLowerCase()
  return receipt.logs?.some(log => {
    if (
      !isAddressEqual(log.address, safe) ||
      log.topics[0]?.toLowerCase() !== SAFE_EXECUTION_SUCCESS_TOPIC.toLowerCase()
    ) {
      return false
    }
    // Safe 1.3 stores txHash in data; Safe 1.4 indexes it.
    if (log.topics.length === 2 && log.data.length === 66) {
      return log.topics[1]?.toLowerCase() === expectedHash
    }
    return (
      log.topics.length === 1 &&
      log.data.length === 130 &&
      `0x${log.data.slice(2, 66)}`.toLowerCase() === expectedHash
    )
  }) ?? false
}

const SAFE_ONCHAIN_ABI = [
  ...SAFE_ABI,
  {
    type: 'function',
    name: 'approveHash',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'hashToApprove', type: 'bytes32' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'approvedHashes',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'hash', type: 'bytes32' },
    ],
    outputs: [{ type: 'uint256' }],
  },
] as const

const PROXY_FACTORY_ABI = [
  {
    type: 'function',
    name: 'createProxyWithNonce',
    stateMutability: 'nonpayable',
    inputs: [
      { name: '_singleton', type: 'address' },
      { name: 'initializer', type: 'bytes' },
      { name: 'saltNonce', type: 'uint256' },
    ],
    outputs: [{ type: 'address' }],
  },
] as const

const SAFE_TX_TYPES = {
  SafeTx: [
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'data', type: 'bytes' },
    { name: 'operation', type: 'uint8' },
    { name: 'safeTxGas', type: 'uint256' },
    { name: 'baseGas', type: 'uint256' },
    { name: 'gasPrice', type: 'uint256' },
    { name: 'gasToken', type: 'address' },
    { name: 'refundReceiver', type: 'address' },
    { name: 'nonce', type: 'uint256' },
  ],
} as const

const SAFE_TX_BASE: Partial<Record<number, string>> = {
  1: 'https://safe-transaction-mainnet.safe.global',
  10: 'https://safe-transaction-optimism.safe.global',
  8453: 'https://safe-transaction-base.safe.global',
  42161: 'https://safe-transaction-arbitrum.safe.global',
  11155111: 'https://safe-transaction-sepolia.safe.global',
}

// `SAFE_SERVICE_PREFIX` (hosted-service chains, the smaller set) and
// `SAFE_PREFIX` (app.safe.global URLs, the wider set) both live in
// safe-connector.ts — the split is deliberate; conflating the two is what
// made service calls fire at chains with none.

let safeActive = 0
const safeWaiters: (() => void)[] = []
const SAFE_MAX_CONCURRENT = 3
const SAFE_PENDING_PAGE_SIZE = 50
const MAX_PENDING_SAFE_TXS = 250
const nonceInflight = new Map<string, Promise<number | null>>()

export const SAFE_APPROVAL_WRITE_GAS = 500_000n
export const SAFE_EXECUTION_WRITE_GAS = TRANSACTION_SIMULATION_GAS
export const SAFE_DEPLOY_WRITE_GAS = 3_000_000n

type LiveSafeIdentity = Extract<
  NonNullable<Awaited<ReturnType<typeof readAuthorityIdentity>>>,
  { kind: 'safe' }
>

type LiveSafeState = {
  identity: LiveSafeIdentity
  nonce: number
}

const txBase = safeServiceBase

function legacyBase(chainId: number): string | null {
  return SAFE_TX_BASE[chainId] ?? null
}

function requestHeaders(json = false): Record<string, string> {
  const headers: Record<string, string> = {}
  if (json) headers['Content-Type'] = 'application/json'
  try {
    const apiKey = window.localStorage.getItem('jb-safe-api-key')
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  } catch {
    // Public Safe endpoints do not require a key.
  }
  return headers
}

function safeFetch(url: string, init?: RequestInit): Promise<Response> {
  return new Promise((resolve, reject) => {
    const release = () => {
      safeActive -= 1
      safeWaiters.shift()?.()
    }
    const run = () => {
      safeActive += 1
      fetch(url, init).then(
        response => {
          release()
          resolve(response)
        },
        error => {
          release()
          reject(error)
        },
      )
    }
    if (safeActive < SAFE_MAX_CONCURRENT) run()
    else safeWaiters.push(run)
  })
}

function connectedWallet(chainId: JBChainId, expected?: Address) {
  return connectedWalletCore(chainId, {
    expected,
    changedError: 'Connected account changed. Review the Safe transaction again.',
  })
}

export function hasSafeService(chainId: number): boolean {
  return !!txBase(chainId)
}

export function safeQueueLink(chainId: number, safe: Address): string | null {
  const prefix = SAFE_PREFIX[chainId]
  return prefix
    ? `https://app.safe.global/transactions/queue?safe=${prefix}:${safe}`
    : null
}

export function safeTxLink(
  chainId: number,
  safe: Address,
  safeTxHash: Hex,
): string | null {
  const prefix = SAFE_PREFIX[chainId]
  return prefix
    ? `https://app.safe.global/transactions/tx?safe=${prefix}:${safe}&id=multisig_${safe}_${safeTxHash}`
    : null
}

/**
 * Every Safe the address signs for on one chain, from the hosted Safe
 * Transaction Service. Chains without a service (and service errors) resolve
 * to an empty list — the account view degrades to EOA-owned projects only.
 */
export async function safesForOwner(
  address: Address,
  chainId: number,
): Promise<Address[]> {
  const base = txBase(chainId)
  if (!base) return []
  try {
    const response = await safeFetch(
      `${base}/api/v1/owners/${getAddress(address)}/safes/`,
      { headers: requestHeaders() },
    )
    if (!response.ok) return []
    const data = (await response.json()) as { safes?: string[] }
    return (data.safes ?? []).flatMap(safe => {
      try {
        return [getAddress(safe)]
      } catch {
        return []
      }
    })
  } catch {
    return []
  }
}

export async function fetchSafeInfo(
  chainId: JBChainId,
  safe: Address,
): Promise<SafeInfo | null> {
  try {
    // Owner/threshold-shaped contracts are not necessarily Safes. Every
    // transaction path which consumes SafeInfo must first prove the canonical
    // proxy runtime, slot-zero singleton, supported implementation, and live
    // policy through the same fail-closed identity reader used by handles.
    const identity = await readAuthorityIdentity(publicClient(chainId), safe)
    if (!identity || identity.kind !== 'safe') return null
    return { threshold: identity.threshold, owners: identity.owners }
  } catch {
    return null
  }
}

async function readLiveSafeState(
  chainId: JBChainId,
  safe: Address,
): Promise<LiveSafeState> {
  const client = publicClient(chainId)
  const [identity, nonceRaw] = await Promise.all([
    readAuthorityIdentity(client, safe),
    readBoundedSafeNonce(client, safe),
  ])
  const nonce = nonceRaw === null ? NaN : Number(nonceRaw)
  if (
    !identity ||
    identity.kind !== 'safe' ||
    !Number.isSafeInteger(nonce) ||
    nonce < 0
  ) {
    throw new Error('Could not verify this Safe onchain.')
  }
  // Module transactions can mutate Safe policy without advancing its nonce.
  // Until the action path snapshots every module address, support only the
  // canonical empty module set and fail closed if one is enabled.
  if (identity.hasModules) {
    throw new Error(
      'Safe actions with enabled modules are not supported. Disable the modules or use the Safe app directly.',
    )
  }
  return { identity, nonce }
}

function safePolicyFingerprint(identity: LiveSafeIdentity): string {
  return JSON.stringify({
    owners: identity.owners.map(owner => owner.toLowerCase()).sort(),
    threshold: identity.threshold,
    ownersAreEoas: identity.ownersAreEoas,
    hasModules: identity.hasModules,
    proxyCodeHash: identity.proxyCodeHash.toLowerCase(),
    singleton: identity.singleton.toLowerCase(),
    singletonCodeHash: identity.singletonCodeHash.toLowerCase(),
    version: identity.version,
    guard: identity.guard.toLowerCase(),
    fallbackHandler: identity.fallbackHandler.toLowerCase(),
    fallbackHandlerCodeHash:
      identity.fallbackHandlerCodeHash?.toLowerCase() ?? null,
  })
}

function assertSafeStateUnchanged(
  before: LiveSafeState,
  after: LiveSafeState,
): void {
  if (
    before.nonce !== after.nonce ||
    safePolicyFingerprint(before.identity) !==
      safePolicyFingerprint(after.identity)
  ) {
    throw new Error(
      'The Safe policy or nonce changed. Review the transaction again.',
    )
  }
}

function assertCurrentSafeSigner(
  state: LiveSafeState,
  signer: Address,
): void {
  if (
    !state.identity.owners.some(
      owner => owner.toLowerCase() === signer.toLowerCase(),
    )
  ) {
    throw new Error(`The connected wallet is not a signer of this Safe.`)
  }
}

function safeMessage(tx: SafeQueuedTx) {
  return {
    to: tx.to,
    value: BigInt(tx.value ?? 0),
    data: tx.data ?? '0x',
    operation: Number(tx.operation ?? 0),
    safeTxGas: BigInt(tx.safeTxGas ?? 0),
    baseGas: BigInt(tx.baseGas ?? 0),
    gasPrice: BigInt(tx.gasPrice ?? 0),
    gasToken: tx.gasToken ?? zeroAddress,
    refundReceiver: tx.refundReceiver ?? zeroAddress,
    nonce: BigInt(tx.nonce),
  }
}

export function safeTxHashOf(
  chainId: number,
  safe: Address,
  tx: SafeQueuedTx,
): Hex {
  return hashTypedData({
    domain: { chainId, verifyingContract: safe },
    types: SAFE_TX_TYPES,
    primaryType: 'SafeTx',
    message: safeMessage(tx),
  })
}

export function canonicalSafeTxHash(
  chainId: JBChainId,
  safe: Address,
  tx: SafeQueuedTx,
): Hex {
  let computed: Hex
  try {
    const nonce = Number(tx.nonce)
    if (!Number.isSafeInteger(nonce) || nonce < 0) {
      throw new Error('Invalid nonce')
    }
    computed = safeTxHashOf(chainId, safe, tx)
  } catch {
    throw new Error('The queued Safe transaction fields are invalid.')
  }
  for (const advertised of [tx.safeTxHash, tx.contractTransactionHash]) {
    if (advertised && advertised.toLowerCase() !== computed.toLowerCase()) {
      throw new Error(
        'The queued Safe transaction hash does not match its exact fields.',
      )
    }
  }
  return computed
}

export type SafeExecutionSnapshot = {
  tx: SafeQueuedTx
  safeTxHash: Hex
  policyFingerprint: string
}

function currentOwnerConfirmations(
  tx: SafeQueuedTx,
  owners: readonly Address[],
): SafeConfirmation[] {
  const ownerSet = new Set(owners.map(owner => owner.toLowerCase()))
  const seen = new Set<string>()
  return usableConfirmations(tx).filter(confirmation => {
    const key = confirmation.owner.toLowerCase()
    if (!ownerSet.has(key) || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function assertSafeTxNonce(
  state: LiveSafeState,
  tx: SafeQueuedTx,
  mode: 'pending' | 'execute',
): void {
  const nonce = Number(tx.nonce)
  const valid =
    Number.isSafeInteger(nonce) &&
    nonce >= 0 &&
    (mode === 'execute' ? nonce === state.nonce : nonce >= state.nonce)
  if (!valid) {
    throw new Error(
      `Safe transaction #${tx.nonce} is stale or does not match the live nonce.`,
    )
  }
}

async function signSafeTx(
  chainId: JBChainId,
  safe: Address,
  tx: SafeQueuedTx,
  signer: Address,
  label?: string,
  reviewCall?: Pick<
    SafeCall,
    'abi' | 'functionName' | 'args' | 'contractName'
  >,
  reverifyAuthority?: () => Promise<void>,
): Promise<Hex> {
  const activeAccount = getAccount(wagmiConfig).address
  if (!activeAccount || activeAccount.toLowerCase() !== signer.toLowerCase()) {
    throw new Error('Connected account changed. Review the Safe transaction again.')
  }
  await reverifyAuthority?.()
  const expectedHash = canonicalSafeTxHash(chainId, safe, tx)
  const before = await readLiveSafeState(chainId, safe)
  assertCurrentSafeSigner(before, signer)
  assertSafeTxNonce(before, tx, 'pending')
  const domain = { chainId, verifyingContract: safe } as const
  const message = safeMessage(tx)
  await requireTransactionReview({
    kind: 'authorization',
    title: 'Review Safe transaction',
    description: `Your signature authorizes Safe ${safe} to make this exact call at nonce ${tx.nonce}. It may execute once the Safe has enough approvals.`,
    confirmLabel: 'Agree & sign Safe transaction',
    authorization: {
      type: 'EIP-712 SafeTx',
      domain,
      primaryType: 'SafeTx',
      message,
      digest: expectedHash,
    },
    calls: [
      {
        chainId,
        from: signer,
        to: tx.to,
        value: BigInt(tx.value ?? 0),
        data: tx.data ?? '0x',
        label: label ?? `Safe transaction #${tx.nonce}`,
        abi: reviewCall?.abi,
        functionName: reviewCall?.functionName,
        args: reviewCall?.args,
        contractName: reviewCall?.contractName,
      },
    ],
  })
  const { wallet, account } = await connectedWallet(chainId, signer)
  if (account.toLowerCase() !== signer.toLowerCase()) {
    throw new Error('Connected account changed. Review the Safe transaction again.')
  }
  await reverifyAuthority?.()
  const after = await readLiveSafeState(chainId, safe)
  assertCurrentSafeSigner(after, signer)
  assertSafeTxNonce(after, tx, 'pending')
  assertSafeStateUnchanged(before, after)
  if (canonicalSafeTxHash(chainId, safe, tx) !== expectedHash) {
    throw new Error('The queued Safe transaction changed during review.')
  }
  const signature = await wallet.signTypedData({
    account: signer,
    domain,
    types: SAFE_TX_TYPES,
    primaryType: 'SafeTx',
    message,
  })
  await reverifyAuthority?.()
  const signed = await readLiveSafeState(chainId, safe)
  assertCurrentSafeSigner(signed, signer)
  assertSafeTxNonce(signed, tx, 'pending')
  assertSafeStateUnchanged(after, signed)
  if (canonicalSafeTxHash(chainId, safe, tx) !== expectedHash) {
    throw new Error('The queued Safe transaction changed while signing.')
  }
  const signedAccount = getAccount(wagmiConfig).address
  if (!signedAccount || signedAccount.toLowerCase() !== signer.toLowerCase()) {
    throw new Error('Connected account changed. Review the Safe transaction again.')
  }
  return signature
}

export function getSafeNextNonce(
  chainId: JBChainId,
  safe: Address,
): Promise<number | null> {
  const key = `${chainId}:${safe.toLowerCase()}`
  const existing = nonceInflight.get(key)
  if (existing) return existing
  const request = (async () => {
    const base = txBase(chainId)
    if (base) {
      try {
        const response = await safeFetch(
          `${base}/api/v1/safes/${getAddress(safe)}/`,
          { headers: requestHeaders() },
        )
        if (response.ok) {
          const data = (await response.json()) as { nonce?: number }
          if (data.nonce !== undefined) return Number(data.nonce)
        }
      } catch {
        // Fall through to the authoritative onchain nonce.
      }
    }
    try {
      const nonce = await readBoundedSafeNonce(publicClient(chainId), safe)
      const value = nonce === null ? NaN : Number(nonce)
      return Number.isSafeInteger(value) && value >= 0 ? value : null
    } catch {
      return null
    }
  })()
  nonceInflight.set(key, request)
  request.finally(() => nonceInflight.delete(key))
  return request
}

export async function listPendingSafeTxs(
  chainId: JBChainId,
  safe: Address,
): Promise<SafeQueuedTx[]> {
  const base = txBase(chainId)
  if (!base) return []
  const current = await getSafeNextNonce(chainId, safe).catch(() => null)
  const path =
    '/api/v1/safes/' + `${getAddress(safe)}/multisig-transactions/`
  const bases = [...new Set([base, legacyBase(chainId)].filter(Boolean))] as string[]
  let lastError: Error | null = null
  for (const candidate of bases) {
    try {
      const rows: SafeQueuedTx[] = []
      for (
        let offset = 0;
        offset < MAX_PENDING_SAFE_TXS;
        offset += SAFE_PENDING_PAGE_SIZE
      ) {
        const query =
          '?executed=false&trusted=true&ordering=nonce' +
          `&limit=${SAFE_PENDING_PAGE_SIZE}&offset=${offset}` +
          (current !== null ? `&nonce__gte=${current}` : '')
        let response: Response | null = null
        for (let attempt = 0; attempt < 2; attempt++) {
          response = await safeFetch(`${candidate}${path}${query}`, {
            headers: requestHeaders(),
          })
          if (response.ok) break
          lastError = new Error(`Safe service ${response.status}`)
          if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 500))
        }
        if (!response?.ok) throw lastError ?? new Error('Safe service unavailable')
        const body = (await response.json()) as {
          next?: string | null
          results?: SafeQueuedTx[]
        }
        const page = Array.isArray(body.results) ? body.results : []
        rows.push(...page)
        if (page.length < SAFE_PENDING_PAGE_SIZE || body.next === null) {
          return current === null
            ? rows
            : rows.filter(tx => Number(tx.nonce) >= current)
        }
      }
      throw new Error(
        `The Safe has more than ${MAX_PENDING_SAFE_TXS} pending transactions. Nothing was proposed; resolve or replace older transactions first.`,
      )
    } catch (error) {
      lastError =
        error instanceof Error ? error : new Error('Safe service unavailable')
    }
  }
  throw lastError ?? new Error('Safe service unavailable')
}

/** Find the exact zero-refund proposal before a Safe-app retry can duplicate it. */
export async function findPendingSafeCall(
  chainId: JBChainId,
  safe: Address,
  call: Pick<SafeCall, 'target' | 'data' | 'value'>,
): Promise<SafeQueuedTx | null> {
  const pending = await listPendingSafeTxs(chainId, safe)
  return pending.find(tx => safeCallMatches(tx, call)) ?? null
}

async function proposeSafeTx({
  chainId,
  safe,
  target,
  data,
  value = 0n,
  signer,
  nonce,
  label,
  abi,
  functionName,
  args,
  contractName,
  reverifyAuthority,
}: SafeCall & { signer: Address; nonce?: number }): Promise<SafeQueuedTx> {
  assertNoViewAs()
  const base = txBase(chainId)
  if (!base) throw new Error('No hosted Safe service is configured for this chain.')
  const selectedNonce = nonce ?? (await getSafeNextNonce(chainId, safe))
  if (selectedNonce === null) throw new Error('Could not read the Safe nonce.')
  const tx: SafeQueuedTx = {
    to: target,
    value: value.toString(),
    data,
    operation: 0,
    safeTxGas: '0',
    baseGas: '0',
    gasPrice: '0',
    gasToken: zeroAddress,
    refundReceiver: zeroAddress,
    nonce: selectedNonce,
    confirmations: [],
  }
  const safeTxHash = safeTxHashOf(chainId, safe, tx)
  const signature = await signSafeTx(chainId, safe, tx, signer, label, {
    abi,
    functionName,
    args,
    contractName,
  }, reverifyAuthority)
  const response = await safeFetch(
    `${base}/api/v1/safes/${getAddress(safe)}/multisig-transactions/`,
    {
      method: 'POST',
      headers: requestHeaders(true),
      body: JSON.stringify({
        to: getAddress(target),
        value: value.toString(),
        data,
        operation: 0,
        safeTxGas: '0',
        baseGas: '0',
        gasPrice: '0',
        gasToken: zeroAddress,
        refundReceiver: zeroAddress,
        nonce: String(selectedNonce),
        contractTransactionHash: safeTxHash,
        sender: getAddress(signer),
        signature,
        origin: 'Juicebox V6 explorer',
      }),
    },
  )
  if (!response.ok && response.status !== 201) {
    const detail = await response.text().catch(() => '')
    throw new Error(
      `Safe service ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`,
    )
  }
  return {
    ...tx,
    safeTxHash,
    contractTransactionHash: safeTxHash,
    confirmations: [{ owner: signer, signature }],
  }
}

export async function confirmSafeTx(
  chainId: JBChainId,
  safe: Address,
  tx: SafeQueuedTx,
  signer: Address,
  reviewCall?: Pick<
    SafeCall,
    'label' | 'abi' | 'functionName' | 'args' | 'contractName'
  >,
  reverifyAuthority?: () => Promise<void>,
): Promise<void> {
  assertNoViewAs()
  const base = txBase(chainId)
  if (!base) throw new Error('No hosted Safe service is configured for this chain.')
  const hash = canonicalSafeTxHash(chainId, safe, tx)
  const signature = await signSafeTx(
    chainId,
    safe,
    tx,
    signer,
    reviewCall?.label,
    reviewCall,
    reverifyAuthority,
  )
  const response = await safeFetch(
    `${base}/api/v1/multisig-transactions/${hash}/confirmations/`,
    {
      method: 'POST',
      headers: requestHeaders(true),
      body: JSON.stringify({ signature }),
    },
  )
  if (!response.ok && response.status !== 201) {
    const detail = await response.text().catch(() => '')
    throw new Error(
      `Safe service ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`,
    )
  }
}

function confirmationBytes(confirmation: SafeConfirmation): string | null {
  const signature = confirmation.signature?.replace(/^0x/, '')
  if (signature) return signature
  if (!confirmation.owner) return null
  return (
    confirmation.owner.replace(/^0x/, '').toLowerCase().padStart(64, '0') +
    '0'.repeat(64) +
    '01'
  )
}

function usableConfirmations(tx: SafeQueuedTx): SafeConfirmation[] {
  return [...(tx.confirmations ?? [])]
    .filter(confirmation => !!confirmation.owner && !!confirmationBytes(confirmation))
    .sort((a, b) =>
      a.owner.toLowerCase() < b.owner.toLowerCase() ? -1 : 1,
    )
}

export function safeUsableConfirmationCount(tx: SafeQueuedTx): number {
  return usableConfirmations(tx).length
}

export function safeExecSignatures(tx: SafeQueuedTx): Hex {
  return `0x${usableConfirmations(tx).map(confirmationBytes).join('')}` as Hex
}

export function safeExecArgs(tx: SafeQueuedTx, signatures: Hex) {
  return [
    getAddress(tx.to),
    BigInt(tx.value ?? 0),
    tx.data ?? '0x',
    Number(tx.operation ?? 0),
    BigInt(tx.safeTxGas ?? 0),
    BigInt(tx.baseGas ?? 0),
    BigInt(tx.gasPrice ?? 0),
    tx.gasToken ?? zeroAddress,
    tx.refundReceiver ?? zeroAddress,
    signatures,
  ] as const
}

type SafeWriteContext =
  | { mode: 'approve'; tx: SafeQueuedTx; hash: Hex }
  | { mode: 'execute'; tx: SafeQueuedTx }

async function verifySafeWriteContext(
  chainId: JBChainId,
  safe: Address,
  account: Address,
  context: SafeWriteContext,
): Promise<LiveSafeState> {
  const state = await readLiveSafeState(chainId, safe)
  const canonicalHash = canonicalSafeTxHash(chainId, safe, context.tx)
  if (context.mode === 'approve') {
    if (canonicalHash.toLowerCase() !== context.hash.toLowerCase()) {
      throw new Error('The Safe approval hash does not match its exact fields.')
    }
    assertCurrentSafeSigner(state, account)
    assertSafeTxNonce(state, context.tx, 'pending')
    return state
  }
  assertSafeTxNonce(state, context.tx, 'execute')
  const confirmations = currentOwnerConfirmations(
    context.tx,
    state.identity.owners,
  )
  if (confirmations.length < state.identity.threshold) {
    throw new Error(
      `This transaction needs ${state.identity.threshold} current-owner signature${
        state.identity.threshold === 1 ? '' : 's'
      } before it can execute.`,
    )
  }
  return state
}

function safeWriteGas(functionName: string): bigint {
  if (functionName === 'approveHash') return SAFE_APPROVAL_WRITE_GAS
  if (functionName === 'createProxyWithNonce') return SAFE_DEPLOY_WRITE_GAS
  return SAFE_EXECUTION_WRITE_GAS
}

async function sendContractAndConfirm({
  chainId,
  address,
  abi,
  functionName,
  args,
  review,
  safeContext,
  reverifyAuthority,
  expectedAccount,
}: {
  chainId: JBChainId
  address: Address
  abi: Abi
  functionName: string
  args: readonly unknown[]
  review?: TransactionReviewRequest
  safeContext?: SafeWriteContext
  reverifyAuthority?: () => Promise<void>
  expectedAccount: Address
}): Promise<ConfirmedContractWrite> {
  assertNoViewAs()
  await reverifyAuthority?.()
  const reviewAccount = getAccount(wagmiConfig).address
  if (
    !reviewAccount ||
    reviewAccount.toLowerCase() !== expectedAccount.toLowerCase()
  ) {
    throw new Error('Connected account changed. Review the transaction again.')
  }
  if (review) {
    await requireTransactionReview({
      ...review,
      calls: review.calls.map(call => ({
        ...call,
        from: expectedAccount,
      })),
    })
  } else {
    await requireContractTransactionReview(
      {
        chainId,
        address,
        abi,
        functionName,
        args,
        account: expectedAccount,
      },
      {
        title: 'Review onchain transaction',
        label:
          functionName === 'execTransaction'
            ? 'Execute Safe transaction'
            : functionName === 'approveHash'
              ? 'Approve Safe transaction hash'
              : functionName === 'createProxyWithNonce'
                ? 'Deploy Safe on this chain'
                : functionName,
        contractName:
          functionName === 'createProxyWithNonce' ? 'Safe Proxy Factory' : 'Safe',
      },
    )
  }
  await reverifyAuthority?.()
  const { wallet, account } = await connectedWallet(chainId, expectedAccount)
  const client = publicClient(chainId)
  const data = encodeFunctionData({ abi, functionName, args })
  const gas = safeWriteGas(functionName)
  const before = safeContext
    ? await verifySafeWriteContext(
        chainId,
        address,
        account,
        safeContext,
      )
    : null
  const simulation = await simulateStateChangingTransaction(client, {
    from: account,
    to: address,
    data,
    gas,
  })
  if (functionName === 'execTransaction') {
    let result = false
    try {
      result = decodeFunctionResult({
        abi: SAFE_EXEC_ABI,
        functionName: 'execTransaction',
        data: simulation,
      })
    } catch {
      // Handled by the fail-closed result check below.
    }
    if (result !== true) {
      throw new Error('Safe simulation reported that the transaction would fail.')
    }
  }
  const live = getAccount(wagmiConfig).address
  if (!live || live.toLowerCase() !== account.toLowerCase()) {
    throw new Error('Connected account changed. Review the transaction again.')
  }
  const fees = await safeFeeOverrides(client)
  await reverifyAuthority?.()
  if (safeContext && before) {
    const after = await verifySafeWriteContext(
      chainId,
      address,
      account,
      safeContext,
    )
    assertSafeStateUnchanged(before, after)
  }
  const finalAccount = getAccount(wagmiConfig).address
  if (!finalAccount || finalAccount.toLowerCase() !== account.toLowerCase()) {
    throw new Error('Connected account changed. Review the transaction again.')
  }
  // Reuse the exact call which just simulated, while setting EIP-1559 fees
  // explicitly instead of spreading a provider-specific transaction fee mode.
  let hash = await wallet.writeContract({
    address,
    abi,
    functionName,
    args,
    account,
    gas,
    ...fees,
    ...('maxFeePerGas' in fees ? { type: 'eip1559' as const } : {}),
  })
  if (isSafeConnection(wagmiConfig)) {
    hash = await waitForSafeExecutionHash(chainId, hash)
  }
  let receipt
  try {
    receipt = await client.waitForTransactionReceipt({ hash })
  } catch {
    // A submitted transaction should not be reported as rejected just because
    // the read RPC timed out.
    return { hash, status: 'submitted' }
  }
  if (receipt.status !== 'success') {
    throw new Error(`${functionName} reverted onchain (tx ${hash}).`)
  }
  if (
    safeContext?.mode === 'execute' &&
    !receiptHasSafeExecutionSuccess(
      receipt as {
        logs?: readonly {
          address: Address
          data: Hex
          topics: readonly Hex[]
        }[]
      },
      address,
      canonicalSafeTxHash(chainId, address, safeContext.tx),
    )
  ) {
    throw new Error(
      `Safe transaction ${hash} was mined, but its exact inner call did not execute successfully.`,
    )
  }
  return { hash, status: 'confirmed' }
}

type SafeFeeOverrides =
  | { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }
  | Record<string, never>

/**
 * Fees for a Safe execution.
 *
 * Asks the node what the network currently wants, because a flat tip is wrong in both
 * directions: 0.05 gwei is far below mainnet's ask under congestion (the transaction just
 * sits unmined) while being needlessly generous on an L2.
 *
 * Every returned cap is derived from a fee value the node actually reported. When neither
 * read succeeds there is no evidence to build one from, so nothing is overridden and the
 * wallet picks — a fabricated cap on an unknown network is how a signed execution ends up
 * rejected or stuck AFTER signing.
 */
async function safeFeeOverrides(client: PublicClient): Promise<SafeFeeOverrides> {
  const tip = 50_000_000n // 0.05 gwei
  const floor = 1_000_000_000n // a cap; actual cost remains base fee + tip
  try {
    const estimated = await client.estimateFeesPerGas()
    if (estimated.maxFeePerGas > 0n && estimated.maxPriorityFeePerGas > 0n) {
      // Never bid BELOW the flat floor — it is the historical known-good value.
      return {
        maxFeePerGas:
          estimated.maxFeePerGas > floor ? estimated.maxFeePerGas : floor,
        maxPriorityFeePerGas:
          estimated.maxPriorityFeePerGas > tip ? estimated.maxPriorityFeePerGas : tip,
      }
    }
  } catch {
    // Fall through to the block-derived estimate below.
  }
  try {
    const block = await client.getBlock()
    // A chain with no base fee is not EIP-1559; there is no 1559 cap to derive.
    if (block?.baseFeePerGas == null) return {}
    const buffered = block.baseFeePerGas * 3n + tip
    return {
      maxFeePerGas: buffered > floor ? buffered : floor,
      maxPriorityFeePerGas: tip,
    }
  } catch {
    return {}
  }
}

export async function executeSafeTx(
  chainId: JBChainId,
  safe: Address,
  tx: SafeQueuedTx,
  reverifyAuthority?: () => Promise<void>,
): Promise<ConfirmedContractWrite> {
  assertNoViewAs()
  await reverifyAuthority?.()
  const expectedAccount = getAccount(wagmiConfig).address
  if (!expectedAccount) throw new Error('Connect a wallet first.')
  const state = await readLiveSafeState(chainId, safe)
  canonicalSafeTxHash(chainId, safe, tx)
  assertSafeTxNonce(state, tx, 'execute')
  const confirmations = currentOwnerConfirmations(tx, state.identity.owners)
  if (confirmations.length < state.identity.threshold) {
    throw new Error(
      `This transaction needs ${state.identity.threshold} current-owner signature${
        state.identity.threshold === 1 ? '' : 's'
      } before it can execute.`,
    )
  }
  const verifiedTx = { ...tx, confirmations }
  const args = safeExecArgs(verifiedTx, safeExecSignatures(verifiedTx))
  const data = encodeFunctionData({
    abi: SAFE_EXEC_ABI,
    functionName: 'execTransaction',
    args,
  })
  return sendContractAndConfirm({
    chainId,
    address: safe,
    abi: SAFE_EXEC_ABI,
    functionName: 'execTransaction',
    args,
    review: {
      kind: 'transaction',
      title: 'Review Safe execution',
      description:
        'Your wallet will send the outer Safe execTransaction call below. The raw context also contains the exact inner destination call the Safe will execute.',
      confirmLabel: 'Agree & execute Safe transaction',
      authorization: {
        type: 'Safe execution context',
        safe,
        safeTxHash: canonicalSafeTxHash(chainId, safe, verifiedTx),
        nonce: verifiedTx.nonce,
        destinationCall: {
          to: tx.to,
          value: tx.value,
          data: tx.data ?? '0x',
          operation: tx.operation,
        },
      },
      calls: [
        {
          chainId,
          from: expectedAccount,
          to: safe,
          value: 0n,
          data,
          abi: SAFE_EXEC_ABI,
          functionName: 'execTransaction',
          args,
          label: `Execute Safe transaction #${tx.nonce}`,
          contractName: 'Safe',
        },
      ],
    },
    safeContext: { mode: 'execute', tx: verifiedTx },
    reverifyAuthority,
    expectedAccount,
  })
}

/**
 * Verify a threshold-complete Safe transaction using the exact exec calldata
 * before asking the user to fund a Relayr bundle.
 */
export async function simulateSafeExecution(
  chainId: JBChainId,
  safe: Address,
  tx: SafeQueuedTx,
  reverifyAuthority?: () => Promise<void>,
): Promise<SafeExecutionSnapshot> {
  await reverifyAuthority?.()
  const state = await readLiveSafeState(chainId, safe)
  const safeTxHash = canonicalSafeTxHash(chainId, safe, tx)
  assertSafeTxNonce(state, tx, 'execute')
  const confirmations = currentOwnerConfirmations(tx, state.identity.owners)
  if (confirmations.length < state.identity.threshold) {
    throw new Error(
      `Safe transaction #${tx.nonce} has ${confirmations.length}/${state.identity.threshold} current-owner signatures.`,
    )
  }
  const verifiedTx = { ...tx, confirmations }
  // The Safe service represents approveHash confirmations without a signature
  // and safeExecSignatures encodes those as v=1 prevalidated signatures. A
  // simulation sent from that owner would pass through msg.sender even after
  // the onchain approval was revoked, while Relayr's executor would revert.
  // Prove every v=1 approval directly (including a service which supplied the
  // 65-byte value explicitly), then simulate from address(0), which Safe
  // forbids as an owner, so the approvedHashes path is always exercised.
  for (const confirmation of confirmations) {
    const encoded = confirmationBytes(confirmation)
    if (!encoded?.endsWith('01')) continue
    const approval = await readBoundedSafeApprovedHash(
      publicClient(chainId),
      safe,
      confirmation.owner,
      safeTxHash,
    )
    if (approval === null || approval === 0n) {
      throw new Error(
        `Safe approval from ${confirmation.owner} is no longer active onchain.`,
      )
    }
  }
  const simulation = await simulateStateChangingTransaction(
    publicClient(chainId),
    {
      // address(0) is forbidden as a Safe owner, so it can never satisfy a
      // v=1 signature through the msg.sender shortcut used by owner callers.
      from: zeroAddress,
      to: safe,
      data: encodeFunctionData({
        abi: SAFE_EXEC_ABI,
        functionName: 'execTransaction',
        args: safeExecArgs(verifiedTx, safeExecSignatures(verifiedTx)),
      }),
      gas: SAFE_EXECUTION_WRITE_GAS,
    },
  )
  let result = false
  try {
    result = decodeFunctionResult({
      abi: SAFE_EXEC_ABI,
      functionName: 'execTransaction',
      data: simulation,
    })
  } catch {
    // Handled by the fail-closed check below.
  }
  if (result !== true) {
    throw new Error(
      `Safe transaction #${tx.nonce} would not execute successfully.`,
    )
  }
  await reverifyAuthority?.()
  const after = await readLiveSafeState(chainId, safe)
  assertSafeTxNonce(after, verifiedTx, 'execute')
  assertSafeStateUnchanged(state, after)
  return {
    tx: verifiedTx,
    safeTxHash,
    policyFingerprint: safePolicyFingerprint(after.identity),
  }
}

export function safeExecRelayrEntry(
  chainId: JBChainId,
  safe: Address,
  tx: SafeQueuedTx,
): RelayrEntry {
  canonicalSafeTxHash(chainId, safe, tx)
  return {
    chain: chainId,
    target: safe,
    data: encodeFunctionData({
      abi: SAFE_EXEC_ABI,
      functionName: 'execTransaction',
      args: safeExecArgs(tx, safeExecSignatures(tx)),
    }),
    value: '0',
  }
}

async function safeOnChainContext(
  chainId: JBChainId,
  safe: Address,
): Promise<{ nonce: number; threshold: number; owners: Address[] }> {
  const state = await readLiveSafeState(chainId, safe)
  return {
    nonce: state.nonce,
    threshold: state.identity.threshold,
    owners: state.identity.owners,
  }
}

async function safeApprovalsOf(
  chainId: JBChainId,
  safe: Address,
  hash: Hex,
  owners: Address[],
): Promise<Address[]> {
  const client = publicClient(chainId)
  const approved = await Promise.all(
    owners.map(owner =>
      readBoundedSafeApprovedHash(client, safe, owner, hash)
        .then(value => value !== null && value > 0n)
        .catch(() => false),
    ),
  )
  return owners.filter((_, index) => approved[index])
}

async function approveSafeHashOnChain(
  chainId: JBChainId,
  safe: Address,
  hash: Hex,
  tx: SafeQueuedTx,
  reverifyAuthority?: () => Promise<void>,
): Promise<ConfirmedContractWrite> {
  const expectedAccount = getAccount(wagmiConfig).address
  if (!expectedAccount) throw new Error('Connect a wallet first.')
  const args = [hash] as const
  const data = encodeFunctionData({
    abi: SAFE_ONCHAIN_ABI,
    functionName: 'approveHash',
    args,
  })
  return sendContractAndConfirm({
    chainId,
    address: safe,
    abi: SAFE_ONCHAIN_ABI,
    functionName: 'approveHash',
    args,
    review: {
      kind: 'transaction',
      title: 'Review Safe hash approval',
      description:
        'Your wallet will send approveHash to the Safe. The raw context identifies the exact queued destination call this digest authorizes; approval does not execute it yet.',
      confirmLabel: 'Agree & approve Safe hash',
      authorization: {
        type: 'Safe approveHash context',
        safe,
        safeTxHash: hash,
        nonce: tx.nonce,
        destinationCall: {
          to: tx.to,
          value: tx.value,
          data: tx.data ?? '0x',
          operation: tx.operation,
        },
      },
      calls: [
        {
          chainId,
          from: expectedAccount,
          to: safe,
          value: 0n,
          data,
          abi: SAFE_ONCHAIN_ABI,
          functionName: 'approveHash',
          args,
          label: `Approve Safe transaction #${tx.nonce}`,
          contractName: 'Safe',
        },
      ],
    },
    safeContext: { mode: 'approve', tx, hash },
    reverifyAuthority,
    expectedAccount,
  })
}

/** Route a set of already-reviewed calls through each controlling Safe. */
export async function runSafeCalls({
  calls,
  signer,
  onProgress,
}: {
  calls: SafeCall[]
  signer: Address
  onProgress?: (message: string) => void
}): Promise<SafeCallResult[]> {
  assertNoViewAs()
  const results: SafeCallResult[] = []
  // No-service path: the on-chain nonce does not advance until a transaction
  // EXECUTES, so a multi-call batch through one threshold>1 Safe would approve
  // hash(nonce=N) for every call — only one could ever execute and the rest
  // would sit as wasted gas reported as "waiting". Hand out sequential
  // provisional nonces per Safe, mirroring what the service path does.
  const provisionalNonce = new Map<string, number>()
  for (let index = 0; index < calls.length; index++) {
    const call = calls[index]
    await call.reverifyAuthority?.()
    const info = await fetchSafeInfo(call.chainId, call.safe)
    if (!info) throw new Error(`The Safe is not deployed on chain ${call.chainId}.`)
    if (!info.owners.some(owner => owner.toLowerCase() === signer.toLowerCase())) {
      throw new Error(`The connected wallet is not a signer of ${call.safe}.`)
    }

    if (hasSafeService(call.chainId)) {
      onProgress?.(`Signing ${index + 1}/${calls.length} Safe proposal…`)
      // The pending list is load-bearing twice over: it dedupes against an
      // existing proposal and it picks a free nonce. Swallowing a failure
      // makes an outage read as an empty queue, so this proposal lands at
      // `nextNonce` on top of whatever is really queued — one of the two is
      // then stranded. The listing already retries across two hosts; if it
      // still fails, stop.
      const [nextNonce, pending] = await Promise.all([
        getSafeNextNonce(call.chainId, call.safe),
        listPendingSafeTxs(call.chainId, call.safe).catch(() => {
          throw new Error(
            `Could not read the pending Safe queue on chain ${call.chainId}. Nothing was proposed — try again shortly.`,
          )
        }),
      ])
      if (nextNonce === null) throw new Error('Could not read the Safe nonce.')
      const matching = pending.find(tx => safeCallMatches(tx, call))
      if (matching) {
        const matchingHash = canonicalSafeTxHash(
          call.chainId,
          call.safe,
          matching,
        )
        const alreadyConfirmed = (matching.confirmations ?? []).some(
          confirmation =>
            confirmation.owner.toLowerCase() === signer.toLowerCase(),
        )
        if (!alreadyConfirmed) {
          onProgress?.(`Signing existing Safe proposal ${index + 1}/${calls.length}…`)
          await confirmSafeTx(
            call.chainId,
            call.safe,
            matching,
            signer,
            call,
            call.reverifyAuthority,
          )
        }
        results.push({
          chainId: call.chainId,
          mode: 'service',
          status: 'queued',
          nonce: matching.nonce,
          safeTxHash: matchingHash,
        })
        continue
      }
      const highest = pending.reduce(
        (value, tx) => Math.max(value, Number(tx.nonce)),
        nextNonce - 1,
      )
      const proposed = await proposeSafeTx({
        ...call,
        signer,
        nonce: Math.max(nextNonce, highest + 1),
      })
      results.push({
        chainId: call.chainId,
        mode: 'service',
        status: 'queued',
        nonce: proposed.nonce,
        safeTxHash: proposed.safeTxHash!,
      })
      continue
    }

    onProgress?.(`Checking onchain Safe approvals ${index + 1}/${calls.length}…`)
    const context = await safeOnChainContext(call.chainId, call.safe)
    const safeKey = `${call.chainId}:${call.safe.toLowerCase()}`
    const nonce = Math.max(context.nonce, provisionalNonce.get(safeKey) ?? 0)
    provisionalNonce.set(safeKey, nonce + 1)
    const queued: SafeQueuedTx = {
      to: call.target,
      value: (call.value ?? 0n).toString(),
      data: call.data,
      operation: 0,
      safeTxGas: '0',
      baseGas: '0',
      gasPrice: '0',
      gasToken: zeroAddress,
      refundReceiver: zeroAddress,
      nonce,
    }
    const hash = safeTxHashOf(call.chainId, call.safe, queued)
    let approvals = await safeApprovalsOf(
      call.chainId,
      call.safe,
      hash,
      context.owners,
    )
    if (!approvals.some(owner => owner.toLowerCase() === signer.toLowerCase())) {
      onProgress?.(`Approving onchain ${index + 1}/${calls.length}…`)
      const approval = await approveSafeHashOnChain(
        call.chainId,
        call.safe,
        hash,
        queued,
        call.reverifyAuthority,
      )
      if (approval.status === 'submitted') {
        results.push({
          chainId: call.chainId,
          mode: 'onchain',
          status: 'submitted',
          nonce,
          safeTxHash: hash,
          transactionHash: approval.hash,
        })
        continue
      }
      approvals = [...approvals, signer]
    }
    if (approvals.length >= context.threshold) {
      onProgress?.(`Executing Safe transaction ${index + 1}/${calls.length}…`)
      const execution = await executeSafeTx(call.chainId, call.safe, {
        ...queued,
        confirmations: approvals.map(owner => ({ owner })),
      }, call.reverifyAuthority)
      results.push({
        chainId: call.chainId,
        mode: 'onchain',
        status:
          execution.status === 'confirmed' ? 'executed' : 'submitted',
        nonce,
        safeTxHash: hash,
        transactionHash: execution.hash,
      })
    } else {
      results.push({
        chainId: call.chainId,
        mode: 'onchain',
        status: 'waiting',
        nonce,
        safeTxHash: hash,
      })
    }
  }
  return results
}

function safeCallMatches(
  tx: SafeQueuedTx,
  call: Pick<SafeCall, 'target' | 'data' | 'value'>,
): boolean {
  try {
    return (
      getAddress(tx.to) === getAddress(call.target) &&
      BigInt(tx.value ?? 0) === (call.value ?? 0n) &&
      (tx.data ?? '0x').toLowerCase() === call.data.toLowerCase() &&
      Number(tx.operation ?? 0) === 0 &&
      BigInt(tx.safeTxGas ?? 0) === 0n &&
      BigInt(tx.baseGas ?? 0) === 0n &&
      BigInt(tx.gasPrice ?? 0) === 0n &&
      isAddressEqual(tx.gasToken ?? zeroAddress, zeroAddress) &&
      isAddressEqual(tx.refundReceiver ?? zeroAddress, zeroAddress)
    )
  } catch {
    return false
  }
}

export type SafeCreation = {
  factory: Address
  singleton: Address
  initializer: Hex
  saltNonce: bigint
}

export async function fetchSafeCreation(
  safe: Address,
  sourceChainId?: number,
): Promise<SafeCreation | null> {
  // Derived from SAFE_TX_BASE rather than restated: a hard-coded list silently skips any
  // chain added to the service map. Testnet first — a Safe being looked up during
  // development is far more likely to live there.
  const isTestnet = (chainId: number) =>
    TESTNET_CHAINS.some(chain => chain.id === chainId)
  const availableChains = Object.keys(SAFE_SERVICE_PREFIX)
    .map(Number)
    .sort((a, b) => Number(isTestnet(b)) - Number(isTestnet(a)))
  // A cross-chain replay must use the creation of the exact source Safe, not
  // a same-address record selected from another transaction service.
  const searchOrder = sourceChainId === undefined
    ? availableChains
    : availableChains.includes(sourceChainId)
      ? [sourceChainId]
      : []
  for (const chainId of searchOrder) {
    const base = txBase(chainId)
    if (!base) continue
    try {
      const response = await safeFetch(
        `${base}/api/v1/safes/${getAddress(safe)}/creation/`,
        { headers: requestHeaders() },
      )
      if (!response.ok) continue
      const data = (await response.json()) as {
        factoryAddress?: Address
        masterCopy?: Address
        setupData?: Hex
        saltNonce?: string
      }
      if (data.factoryAddress && data.masterCopy && data.setupData) {
        return {
          factory: getAddress(data.factoryAddress),
          singleton: getAddress(data.masterCopy),
          initializer: data.setupData,
          saltNonce: BigInt(data.saltNonce ?? 0),
        }
      }
    } catch {
      // Try the next known service.
    }
  }
  return null
}

export async function deploySafeSameAddress(
  chainId: JBChainId,
  creation: SafeCreation,
  expectedSafe: Address,
  {
    sourceChainId,
    reverifyAuthority,
  }: {
    sourceChainId: JBChainId
    reverifyAuthority: () => Promise<void>
  },
): Promise<Hex> {
  const client = publicClient(chainId)
  const sourceClient = publicClient(sourceChainId)
  const verifyDeploymentState = async (): Promise<LiveSafeState> => {
    await reverifyAuthority()
    const [source, destination, nonceRaw] = await Promise.all([
      readAuthorityIdentity(sourceClient, expectedSafe),
      readAuthorityIdentity(client, expectedSafe),
      readBoundedSafeNonce(sourceClient, expectedSafe),
    ])
    const nonce = nonceRaw === null ? NaN : Number(nonceRaw)
    if (
      !source ||
      !isDeployableSafeAuthority(source) ||
      !safeCreationMatchesAuthorityIdentity(creation, source) ||
      !destination ||
      destination.kind !== 'eoa' ||
      !Number.isSafeInteger(nonce) ||
      nonce < 0
    ) {
      throw new Error(
        'The source Safe, creation initializer, or destination state is no longer eligible for same-address deployment.',
      )
    }
    const signer = getAccount(wagmiConfig).address
    if (
      !signer ||
      !source.owners.some(
        owner => owner.toLowerCase() === signer.toLowerCase(),
      )
    ) {
      throw new Error(`Switch to a current signer of ${expectedSafe}.`)
    }
    // The deterministic initializer reuses these exact owner and handler
    // addresses. Prove their destination-chain control surface before CREATE2
    // makes the deployment irreversible.
    const destinationPolicyCodes = await Promise.all([
      ...source.owners.map(owner => client.getBytecode({ address: owner })),
      ...(!isAddressEqual(source.fallbackHandler, zeroAddress)
        ? [client.getBytecode({ address: source.fallbackHandler })]
        : []),
    ])
    if (
      destinationPolicyCodes
        .slice(0, source.owners.length)
        .some(
          code =>
            code && code !== '0x' && !isEip7702DelegatedEoaRuntime(code),
        )
    ) {
      throw new Error(
        'A source Safe owner is a contract on the destination chain, so its control policy cannot be replayed safely.',
      )
    }
    if (!isAddressEqual(source.fallbackHandler, zeroAddress)) {
      const destinationFallbackCode = destinationPolicyCodes.at(-1)
      if (
        !destinationFallbackCode ||
        destinationFallbackCode === '0x' ||
        isEip7702DelegatedEoaRuntime(destinationFallbackCode) ||
        !source.fallbackHandlerCodeHash ||
        keccak256(destinationFallbackCode).toLowerCase() !==
          source.fallbackHandlerCodeHash.toLowerCase()
      ) {
        throw new Error(
          'The Safe fallback handler bytecode does not match across source and destination chains.',
        )
      }
    }
    return { identity: source, nonce }
  }
  const sourceBefore = await verifyDeploymentState()
  const [
    existingCode,
    factoryCode,
    singletonCode,
    sourceFactoryCode,
    sourceSingletonCode,
  ] = await Promise.all([
    client.getBytecode({ address: expectedSafe }),
    client.getBytecode({ address: creation.factory }),
    client.getBytecode({ address: creation.singleton }),
    sourceClient.getBytecode({ address: creation.factory }),
    sourceClient.getBytecode({ address: creation.singleton }),
  ])
  if (existingCode && existingCode !== '0x') {
    throw new Error(
      `${expectedSafe} already has code on this chain. Recheck its Safe policy instead of replaying deployment.`,
    )
  }
  if (
    !factoryCode ||
    factoryCode === '0x' ||
    !singletonCode ||
    singletonCode === '0x' ||
    !sourceFactoryCode ||
    sourceFactoryCode === '0x' ||
    !sourceSingletonCode ||
    sourceSingletonCode === '0x' ||
    sourceFactoryCode.toLowerCase() !== factoryCode.toLowerCase() ||
    sourceSingletonCode.toLowerCase() !== singletonCode.toLowerCase()
  ) {
    throw new Error(
      'The recognized Safe factory or singleton bytecode does not match across source and destination chains.',
    )
  }
  const args = [
    creation.singleton,
    creation.initializer,
    creation.saltNonce,
  ] as const
  const signer = getAccount(wagmiConfig).address!
  const rawResult = await simulateStateChangingTransaction(client, {
    from: signer,
    to: creation.factory,
    data: encodeFunctionData({
      abi: PROXY_FACTORY_ABI,
      functionName: 'createProxyWithNonce',
      args,
    }),
    gas: SAFE_DEPLOY_WRITE_GAS,
  })
  let predicted: Address | null = null
  try {
    predicted = decodeFunctionResult({
      abi: PROXY_FACTORY_ABI,
      functionName: 'createProxyWithNonce',
      data: rawResult,
    })
  } catch {
    // Handled by the exact-address check below.
  }
  if (!predicted || !isAddressEqual(predicted, expectedSafe)) {
    throw new Error(
      `The Safe creation would deploy ${predicted ?? 'an unreadable address'}, not the expected project authority ${expectedSafe}.`,
    )
  }
  const reverifyDeployment = async () => {
    const current = await verifyDeploymentState()
    assertSafeStateUnchanged(sourceBefore, current)
  }
  const submission = await sendContractAndConfirm({
    chainId,
    address: creation.factory,
    abi: PROXY_FACTORY_ABI,
    functionName: 'createProxyWithNonce',
    args,
    reverifyAuthority: reverifyDeployment,
    expectedAccount: signer,
  })
  for (let attempt = 0; attempt < 6; attempt++) {
    const code = await client.getBytecode({ address: expectedSafe }).catch(() => null)
    if (code && code !== '0x') {
      await reverifyAuthority()
      const confirmed = await readMatchingAuthorityIdentities({
        sourceClient,
        destinationClient: client,
        authority: expectedSafe,
      })
      if (!confirmed?.matches) {
        throw new Error(
          'The Safe deployed, but its destination policy does not match the live source Safe.',
        )
      }
      return submission.hash
    }
    await new Promise(resolve => setTimeout(resolve, 1_500))
  }
  throw new Error(
    `The deployment was submitted as ${submission.hash}, but ${expectedSafe} is not readable on this chain yet. Check that transaction before trying again.`,
  )
}
