'use client'

import { getAccount } from '@wagmi/core'
import {
  encodeFunctionData,
  getAddress,
  hashTypedData,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem'
import type { JBChainId } from '@bananapus/nana-sdk-core'
import { wagmiConfig } from '@/providers/Providers'
import type { RelayrEntry } from '@/lib/relayr'
import { assertNoViewAs } from '@/lib/viewAs'
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
  waitForSafeExecutionHash,
} from '@/lib/safe-connector'

export type SafeInfo = {
  owners: Address[]
  threshold: number
}

export type SafeConfirmation = {
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

export const SAFE_ABI = [
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

export const SAFE_PREFIX: Partial<Record<number, string>> = {
  1: 'eth',
  10: 'oeth',
  8453: 'base',
  42161: 'arb1',
  11155111: 'sep',
}

let safeActive = 0
const safeWaiters: (() => void)[] = []
const SAFE_MAX_CONCURRENT = 3
const nonceInflight = new Map<string, Promise<number | null>>()

function txBase(chainId: number): string | null {
  try {
    const custom = JSON.parse(
      window.localStorage.getItem('jb-safe-tx-base') ?? 'null',
    ) as Record<string, string> | null
    if (custom?.[chainId]) return custom[chainId].replace(/\/$/, '')
  } catch {
    // Local overrides are optional.
  }
  const prefix = SAFE_PREFIX[chainId]
  return prefix
    ? `https://api.safe.global/tx-service/${prefix}`
    : null
}

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
    const client = publicClient(chainId)
    const [threshold, owners] = await Promise.all([
      client.readContract({
        address: safe,
        abi: SAFE_ABI,
        functionName: 'getThreshold',
      }),
      client.readContract({
        address: safe,
        abi: SAFE_ABI,
        functionName: 'getOwners',
      }),
    ])
    if (BigInt(threshold) <= 0n || !owners.length) return null
    return { threshold: Number(threshold), owners: owners as Address[] }
  } catch {
    return null
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
): Promise<Hex> {
  const activeAccount = getAccount(wagmiConfig).address
  if (!activeAccount || activeAccount.toLowerCase() !== signer.toLowerCase()) {
    throw new Error('Connected account changed. Review the Safe transaction again.')
  }
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
      digest: safeTxHashOf(chainId, safe, tx),
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
  return wallet.signTypedData({
    account: signer,
    domain,
    types: SAFE_TX_TYPES,
    primaryType: 'SafeTx',
    message,
  })
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
      const nonce = await publicClient(chainId).readContract({
        address: safe,
        abi: SAFE_ABI,
        functionName: 'nonce',
      })
      return Number(nonce)
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
  const query =
    '/api/v1/safes/' +
    `${getAddress(safe)}/multisig-transactions/` +
    '?executed=false&trusted=true&ordering=nonce&limit=50' +
    (current !== null ? `&nonce__gte=${current}` : '')
  const bases = [...new Set([base, legacyBase(chainId)].filter(Boolean))] as string[]
  let lastError: Error | null = null
  for (const candidate of bases) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await safeFetch(`${candidate}${query}`, {
          headers: requestHeaders(),
        })
        if (response.ok) {
          const body = (await response.json()) as { results?: SafeQueuedTx[] }
          const rows = body.results ?? []
          return current === null
            ? rows
            : rows.filter(tx => Number(tx.nonce) >= current)
        }
        lastError = new Error(`Safe service ${response.status}`)
      } catch (error) {
        lastError = error instanceof Error ? error : new Error('Safe service unavailable')
      }
      if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 500))
    }
  }
  throw lastError ?? new Error('Safe service unavailable')
}

export async function proposeSafeTx({
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
  })
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
): Promise<void> {
  assertNoViewAs()
  const base = txBase(chainId)
  if (!base) throw new Error('No hosted Safe service is configured for this chain.')
  const hash = tx.safeTxHash ?? tx.contractTransactionHash
  if (!hash) throw new Error('The queued transaction has no Safe transaction hash.')
  const signature = await signSafeTx(
    chainId,
    safe,
    tx,
    signer,
    reviewCall?.label,
    reviewCall,
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

async function sendContractAndConfirm({
  chainId,
  address,
  abi,
  functionName,
  args,
  review,
}: {
  chainId: JBChainId
  address: Address
  abi: Abi
  functionName: string
  args: readonly unknown[]
  review?: TransactionReviewRequest
}): Promise<ConfirmedContractWrite> {
  assertNoViewAs()
  const reviewAccount = getAccount(wagmiConfig).address
  if (!reviewAccount) throw new Error('Connect a wallet first.')
  if (review) {
    await requireTransactionReview(review)
  } else {
    await requireContractTransactionReview(
      {
        chainId,
        address,
        abi,
        functionName,
        args,
        account: reviewAccount,
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
  const { wallet, account } = await connectedWallet(chainId, reviewAccount)
  const client = publicClient(chainId)
  const simulation = await client.simulateContract({
    address,
    abi,
    functionName,
    args,
    account,
  })
  if (functionName === 'execTransaction' && simulation.result !== true) {
    throw new Error('Safe simulation reported that the transaction would fail.')
  }
  const live = getAccount(wagmiConfig).address
  if (!live || live.toLowerCase() !== account.toLowerCase()) {
    throw new Error('Connected account changed. Review the transaction again.')
  }
  const fees = await safeFeeOverrides(client)
  // Reuse the exact call which just simulated, while setting EIP-1559 fees
  // explicitly instead of spreading a provider-specific transaction fee mode.
  let hash = await wallet.writeContract({
    address,
    abi,
    functionName,
    args,
    account,
    ...fees,
    type: 'eip1559',
  })
  if (isSafeConnection(wagmiConfig)) {
    hash = await waitForSafeExecutionHash(chainId, hash)
  }
  try {
    const receipt = await client.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success') {
      throw new Error(`${functionName} reverted onchain (tx ${hash}).`)
    }
  } catch (receiptError) {
    // A submitted transaction should not be reported as rejected just because
    // the read RPC timed out. Genuine onchain reverts remain hard failures.
    if (
      receiptError instanceof Error &&
      /reverted onchain/.test(receiptError.message)
    ) {
      throw receiptError
    }
    return { hash, status: 'submitted' }
  }
  return { hash, status: 'confirmed' }
}

async function safeFeeOverrides(
  client: PublicClient,
): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
  const tip = 50_000_000n // 0.05 gwei
  const floor = 1_000_000_000n // a cap; actual cost remains base fee + tip
  try {
    const block = await client.getBlock()
    const base = block.baseFeePerGas ?? 0n
    const buffered = base * 3n + tip
    return {
      maxFeePerGas: buffered > floor ? buffered : floor,
      maxPriorityFeePerGas: tip,
    }
  } catch {
    return { maxFeePerGas: floor, maxPriorityFeePerGas: tip }
  }
}

export async function executeSafeTx(
  chainId: JBChainId,
  safe: Address,
  tx: SafeQueuedTx,
): Promise<ConfirmedContractWrite> {
  assertNoViewAs()
  const info = await fetchSafeInfo(chainId, safe)
  if (!info) throw new Error('Could not verify this Safe onchain.')
  if (safeUsableConfirmationCount(tx) < info.threshold) {
    throw new Error(
      `This transaction needs ${info.threshold} usable signature${
        info.threshold === 1 ? '' : 's'
      } before it can execute.`,
    )
  }
  const args = safeExecArgs(tx, safeExecSignatures(tx))
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
        safeTxHash: safeTxHashOf(chainId, safe, tx),
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
          from: getAccount(wagmiConfig).address,
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
  caller: Address,
): Promise<void> {
  const info = await fetchSafeInfo(chainId, safe)
  if (!info) throw new Error('Could not verify this Safe onchain.')
  const confirmations = safeUsableConfirmationCount(tx)
  if (confirmations < info.threshold) {
    throw new Error(
      `Safe transaction #${tx.nonce} has ${confirmations}/${info.threshold} usable signatures.`,
    )
  }
  const simulation = await publicClient(chainId).simulateContract({
    account: caller,
    address: safe,
    abi: SAFE_EXEC_ABI,
    functionName: 'execTransaction',
    args: safeExecArgs(tx, safeExecSignatures(tx)),
  })
  if (simulation.result !== true) {
    throw new Error(`Safe transaction #${tx.nonce} would not execute successfully.`)
  }
}

export function safeExecRelayrEntry(
  chainId: JBChainId,
  safe: Address,
  tx: SafeQueuedTx,
): RelayrEntry {
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

export async function safeOnChainContext(
  chainId: JBChainId,
  safe: Address,
): Promise<{ nonce: number; threshold: number; owners: Address[] }> {
  const client = publicClient(chainId)
  const [nonce, threshold, owners] = await Promise.all([
    client.readContract({ address: safe, abi: SAFE_ABI, functionName: 'nonce' }),
    client.readContract({
      address: safe,
      abi: SAFE_ABI,
      functionName: 'getThreshold',
    }),
    client.readContract({ address: safe, abi: SAFE_ABI, functionName: 'getOwners' }),
  ])
  return {
    nonce: Number(nonce),
    threshold: Number(threshold),
    owners: owners as Address[],
  }
}

export async function safeApprovalsOf(
  chainId: JBChainId,
  safe: Address,
  hash: Hex,
  owners: Address[],
): Promise<Address[]> {
  const client = publicClient(chainId)
  const approved = await Promise.all(
    owners.map(owner =>
      client
        .readContract({
          address: safe,
          abi: SAFE_ONCHAIN_ABI,
          functionName: 'approvedHashes',
          args: [owner, hash],
        })
        .then(value => BigInt(value) > 0n)
        .catch(() => false),
    ),
  )
  return owners.filter((_, index) => approved[index])
}

export async function approveSafeHashOnChain(
  chainId: JBChainId,
  safe: Address,
  hash: Hex,
  tx: SafeQueuedTx,
): Promise<ConfirmedContractWrite> {
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
          from: getAccount(wagmiConfig).address,
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
  for (let index = 0; index < calls.length; index++) {
    const call = calls[index]
    const info = await fetchSafeInfo(call.chainId, call.safe)
    if (!info) throw new Error(`The Safe is not deployed on chain ${call.chainId}.`)
    if (!info.owners.some(owner => owner.toLowerCase() === signer.toLowerCase())) {
      throw new Error(`The connected wallet is not a signer of ${call.safe}.`)
    }

    if (hasSafeService(call.chainId)) {
      onProgress?.(`Signing ${index + 1}/${calls.length} Safe proposal…`)
      const [nextNonce, pending] = await Promise.all([
        getSafeNextNonce(call.chainId, call.safe),
        listPendingSafeTxs(call.chainId, call.safe).catch(() => []),
      ])
      if (nextNonce === null) throw new Error('Could not read the Safe nonce.')
      const matching = pending.find(tx => safeCallMatches(tx, call))
      if (matching) {
        const alreadyConfirmed = (matching.confirmations ?? []).some(
          confirmation =>
            confirmation.owner.toLowerCase() === signer.toLowerCase(),
        )
        if (!alreadyConfirmed) {
          onProgress?.(`Signing existing Safe proposal ${index + 1}/${calls.length}…`)
          await confirmSafeTx(call.chainId, call.safe, matching, signer, call)
        }
        results.push({
          chainId: call.chainId,
          mode: 'service',
          status: 'queued',
          nonce: matching.nonce,
          safeTxHash:
            matching.safeTxHash ??
            matching.contractTransactionHash ??
            safeTxHashOf(call.chainId, call.safe, matching),
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
      nonce: context.nonce,
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
      )
      if (approval.status === 'submitted') {
        results.push({
          chainId: call.chainId,
          mode: 'onchain',
          status: 'submitted',
          nonce: context.nonce,
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
      })
      results.push({
        chainId: call.chainId,
        mode: 'onchain',
        status:
          execution.status === 'confirmed' ? 'executed' : 'submitted',
        nonce: context.nonce,
        safeTxHash: hash,
        transactionHash: execution.hash,
      })
    } else {
      results.push({
        chainId: call.chainId,
        mode: 'onchain',
        status: 'waiting',
        nonce: context.nonce,
        safeTxHash: hash,
      })
    }
  }
  return results
}

function safeCallMatches(tx: SafeQueuedTx, call: SafeCall): boolean {
  try {
    return (
      getAddress(tx.to) === getAddress(call.target) &&
      BigInt(tx.value ?? 0) === (call.value ?? 0n) &&
      (tx.data ?? '0x').toLowerCase() === call.data.toLowerCase() &&
      Number(tx.operation ?? 0) === 0
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

export async function fetchSafeCreation(safe: Address): Promise<SafeCreation | null> {
  for (const chainId of [11155111, 1, 42161, 8453, 10]) {
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
): Promise<Hex> {
  const submission = await sendContractAndConfirm({
    chainId,
    address: creation.factory,
    abi: PROXY_FACTORY_ABI,
    functionName: 'createProxyWithNonce',
    args: [creation.singleton, creation.initializer, creation.saltNonce],
  })
  const client = publicClient(chainId)
  for (let attempt = 0; attempt < 6; attempt++) {
    const code = await client.getBytecode({ address: expectedSafe }).catch(() => null)
    if (code && code !== '0x') return submission.hash
    await new Promise(resolve => setTimeout(resolve, 1_500))
  }
  throw new Error(
    `The deployment was submitted as ${submission.hash}, but ${expectedSafe} is not readable on this chain yet. Check that transaction before trying again.`,
  )
}
