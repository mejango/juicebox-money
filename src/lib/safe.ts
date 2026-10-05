'use client'

import { getAccount } from '@wagmi/core'
import {
  decodeFunctionResult,
  encodeFunctionData,
  isAddressEqual,
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
  gasWithinCap,
  simulateStateChangingTransaction,
  TRANSACTION_SIMULATION_GAS,
} from '@bananapus/nana-sdk-core/review'
import {
  multiSendCallsOf,
  prepareSafeSameAddressDeployment,
  readAuthorityIdentity,
  readBoundedSafeApprovedHash,
  readBoundedSafeNonce,
  SAFE_CREATE_ABI,
  type SafeAuthorityIdentity,
  type SafeCreation,
  type SafeSameAddressDeploymentRefusal,
} from '@bananapus/nana-sdk-core/safe'
import {
  canonicalSafeTxHash,
  hasSafeService,
  listPendingSafeTransactions,
  nextProposalNonce,
  onchainApprovalStep,
  proposeSafeTransaction,
  SAFE_EXEC_ABI,
  SAFE_TX_TYPES,
  safeBatchProposalFor,
  safeExecutionArgs,
  safeExecutionResult,
  safeProposalFor,
  safeTransactionHash,
  safeTransactionHasRefund,
  safeTransactionMatchesCall,
  safeTransactionMessage,
  submitSafeConfirmation,
  usableSafeConfirmations,
  type SafeConfirmation,
  type SafeQueuedTransaction,
  type SafeServiceOptions,
} from '@bananapus/nana-sdk-core/safe-service'
import {
  readMatchingAuthorityIdentities,
  UnprovenSafeError,
} from '@/lib/cross-chain-authority'
import {
  connectedWallet as connectedWalletCore,
  publicClient,
} from '@/lib/wallet-core'
import {
  requireContractTransactionReview,
  requireTransactionReview,
  type TransactionReviewCall,
  type TransactionReviewRequest,
} from '@/lib/transaction-review'
import {
  isSafeConnection,
  requireSafeProposalSuccess,
  SAFE_NONCE_GUIDANCE,
  waitForSafeExecutionHash,
} from '@/lib/safe-connector'

export type SafeInfo = {
  owners: Address[]
  threshold: number
}

export type SafeCall = {
  chainId: JBChainId
  safe: Address
  target: Address
  data: Hex
  value?: bigint
  /** 0 = CALL (default). 1 = DELEGATECALL, used only for a MultiSendCallOnly batch. */
  operation?: 0 | 1
  label?: string
  abi?: Abi
  functionName?: string
  args?: readonly unknown[]
  contractName?: string
  /** The inner calls of a MultiSend batch, for the review. */
  calls?: readonly TransactionReviewCall[]
  reverifyAuthority?: () => Promise<void>
  onSafePrepared?: (tx: SafeQueuedTransaction) => Promise<void>
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

/** The line a Safe transaction that pays a gas refund is refused with (Ruling R93). */
export const SAFE_REFUND_REFUSAL =
  "This transaction pays a gas refund, so it can't be executed here."

let safeActive = 0
const safeWaiters: (() => void)[] = []
const SAFE_MAX_CONCURRENT = 3
const nonceInflight = new Map<string, Promise<number | null>>()

const SAFE_APPROVAL_WRITE_GAS = 500_000n
export const SAFE_EXECUTION_WRITE_GAS = TRANSACTION_SIMULATION_GAS
const SAFE_DEPLOY_WRITE_GAS = 3_000_000n

type LiveSafeState = {
  identity: SafeAuthorityIdentity
  nonce: number
}

function safeFetchOnce(
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const release = () => {
      safeActive -= 1
      safeWaiters.shift()?.()
    }
    const run = () => {
      safeActive += 1
      fetch(input, init).then(
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

/** The SDK's Safe service calls, at most SAFE_MAX_CONCURRENT at a time. */
export const SAFE_SERVICE: SafeServiceOptions = { fetch: safeFetchOnce }

function connectedWallet(chainId: JBChainId, expected?: Address) {
  return connectedWalletCore(chainId, {
    expected,
    changedError: 'Connected account changed. Review the Safe transaction again.',
  })
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
  // The policy fingerprint snapshots every module address, so only a module
  // set too large to read in one page is left unverifiable.
  if (!identity.modules) {
    throw new Error('Could not verify this Safe onchain.')
  }
  return { identity, nonce }
}

function safePolicyFingerprint(identity: SafeAuthorityIdentity): string {
  return JSON.stringify({
    owners: identity.owners.map(owner => owner.toLowerCase()).sort(),
    threshold: identity.threshold,
    ownersAreEoas: identity.ownersAreEoas,
    modules: identity.modules?.map(module => module.toLowerCase()).sort(),
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

export type SafeExecutionSnapshot = {
  tx: SafeQueuedTransaction
  safeTxHash: Hex
  policyFingerprint: string
  /** The Safe's current owners, whose confirmations sign the execution. */
  owners: Address[]
}

/** Throws SAFE_REFUND_REFUSAL for a transaction that pays its executor a gas refund. */
function refuseRefund(tx: SafeQueuedTransaction): void {
  if (safeTransactionHasRefund(tx)) throw new Error(SAFE_REFUND_REFUSAL)
}

/**
 * An onchain approval: no signature, or Safe's v = 1 form naming the owner.
 * It counts only while `approvedHashes` holds it.
 */
function isApprovedHashConfirmation(confirmation: SafeConfirmation): boolean {
  return (
    !confirmation.signature ||
    confirmation.signature.slice(130, 132).toLowerCase() === '01'
  )
}

function assertSafeTxNonce(
  state: LiveSafeState,
  tx: SafeQueuedTransaction,
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
  tx: SafeQueuedTransaction,
  signer: Address,
  label?: string,
  reviewCall?: Pick<
    SafeCall,
    'abi' | 'functionName' | 'args' | 'contractName' | 'calls'
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
  const message = safeTransactionMessage(tx)
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
        to: message.to,
        value: message.value,
        data: message.data,
        safeTxGas: message.safeTxGas,
        label: label ?? `Safe transaction #${tx.nonce}`,
        abi: reviewCall?.abi,
        functionName: reviewCall?.functionName,
        args: reviewCall?.args,
        contractName: reviewCall?.contractName,
        calls: reviewCall?.calls,
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

/** The Safe's nonce onchain, one read at a time per Safe, or null when it cannot be read. */
export function getSafeNextNonce(
  chainId: JBChainId,
  safe: Address,
): Promise<number | null> {
  const key = `${chainId}:${safe.toLowerCase()}`
  const existing = nonceInflight.get(key)
  if (existing) return existing
  const request = readBoundedSafeNonce(publicClient(chainId), safe).then(
    nonce => {
      const value = nonce === null ? NaN : Number(nonce)
      return Number.isSafeInteger(value) && value >= 0 ? value : null
    },
    () => null,
  )
  nonceInflight.set(key, request)
  request.finally(() => nonceInflight.delete(key))
  return request
}

/**
 * The Safe's onchain nonce and its queued transactions from that nonce on,
 * from its chain's Safe service. Throws on a chain without one
 * (hasSafeService), or when either cannot be read.
 */
export async function readSafeQueue(
  chainId: JBChainId,
  safe: Address,
): Promise<{ nonce: number; pending: SafeQueuedTransaction[] }> {
  const nonce = await getSafeNextNonce(chainId, safe)
  if (nonce === null) throw new Error('Could not read the Safe nonce.')
  return {
    nonce,
    pending: await listPendingSafeTransactions(chainId, safe, nonce, SAFE_SERVICE),
  }
}

/**
 * The zero-refund proposal of `call`: one CALL, or one DELEGATECALL into
 * MultiSendCallOnly with a canonical batch, never another DELEGATECALL.
 */
function proposalFor(
  call: Pick<SafeCall, 'target' | 'data' | 'value' | 'operation'>,
  nonce: number,
): SafeQueuedTransaction {
  const to = call.target
  const value = call.value ?? 0n
  if ((call.operation ?? 0) === 0) {
    return safeProposalFor({ to, data: call.data, value }, nonce)
  }
  const calls = multiSendCallsOf({ to, data: call.data, operation: 1 })
  if (!calls || value !== 0n) {
    throw new Error('A Safe DELEGATECALL must be a MultiSendCallOnly batch.')
  }
  return safeBatchProposalFor(calls, nonce)
}

async function proposeSafeTx({
  chainId,
  safe,
  signer,
  nonce,
  label,
  abi,
  functionName,
  args,
  contractName,
  calls,
  reverifyAuthority,
  onSafePrepared,
  ...call
}: SafeCall & { signer: Address; nonce: number }): Promise<SafeQueuedTransaction & { safeTxHash: Hex }> {
  assertNoViewAs()
  if (!hasSafeService(chainId)) {
    throw new Error('No hosted Safe service is configured for this chain.')
  }
  const tx = proposalFor(call, nonce)
  const safeTxHash = safeTransactionHash(chainId, safe, tx)
  await onSafePrepared?.({ ...tx, safeTxHash })
  const signature = await signSafeTx(chainId, safe, tx, signer, label, {
    abi,
    functionName,
    args,
    contractName,
    calls,
  }, reverifyAuthority)
  await proposeSafeTransaction(
    chainId,
    safe,
    tx,
    { sender: signer, signature, origin: 'Juicebox V6 explorer' },
    SAFE_SERVICE,
  )
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
  tx: SafeQueuedTransaction,
  signer: Address,
  reviewCall?: Pick<
    SafeCall,
    'label' | 'abi' | 'functionName' | 'args' | 'contractName' | 'calls'
  >,
  reverifyAuthority?: () => Promise<void>,
): Promise<void> {
  assertNoViewAs()
  refuseRefund(tx)
  if (!hasSafeService(chainId)) {
    throw new Error('No hosted Safe service is configured for this chain.')
  }
  canonicalSafeTxHash(chainId, safe, tx)
  const signature = await signSafeTx(
    chainId,
    safe,
    tx,
    signer,
    reviewCall?.label,
    reviewCall,
    reverifyAuthority,
  )
  await submitSafeConfirmation(chainId, safe, tx, signature, SAFE_SERVICE)
}

type SafeWriteContext =
  | { mode: 'approve'; tx: SafeQueuedTransaction; hash: Hex }
  | { mode: 'execute'; tx: SafeQueuedTransaction }

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
  const confirmations = usableSafeConfirmations(
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
  const client = publicClient(chainId)
  const data = encodeFunctionData({ abi, functionName, args })
  const gasCap = safeWriteGas(functionName)
  // A Safe app signs the sent gas as safeTxGas; 0 makes a failed call revert.
  const viaSafe = isSafeConnection(wagmiConfig)
  // The cap is a simulation bound, not a price. Sending it would make the
  // wallet reserve cap * maxFeePerGas — 10M gas on Ethereum is a ~0.01 ETH
  // balance requirement for an execution that costs a fraction of it. The
  // limit is measured once, inside the cap, so the review shows the sent gas.
  const gas = viaSafe
    ? 0n
    : ((await gasWithinCap(client, { account: expectedAccount, to: address, data }, gasCap)) ??
      gasCap)
  const sentGas = viaSafe ? { safeTxGas: 0n } : { gas }
  const safeApp = viaSafe
    ? {
        description: [review?.description, SAFE_NONCE_GUIDANCE].filter(Boolean).join(' '),
        confirmLabel: 'Agree & continue to Safe',
      }
    : {}
  if (review) {
    await requireTransactionReview({
      ...review,
      ...safeApp,
      calls: review.calls.map(call => ({
        ...call,
        from: expectedAccount,
        ...sentGas,
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
        ...sentGas,
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
        ...safeApp,
      },
    )
  }
  await reverifyAuthority?.()
  const { wallet, account } = await connectedWallet(chainId, expectedAccount)
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
    gas: gasCap,
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
  if (isSafeConnection(wagmiConfig) !== viaSafe) {
    throw new Error('Connected wallet changed. Review the transaction again.')
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
  // A Safe app replies with its proposal; its execution is what lands.
  const proposal = viaSafe ? hash : null
  if (proposal) hash = await waitForSafeExecutionHash(chainId, proposal)
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
  if (proposal) {
    await requireSafeProposalSuccess(
      {
        client,
        receipt,
        safe: account,
        proposalHash: proposal,
        calls: [{ to: address, data }],
      },
      `${functionName} reverted after Safe execution (tx ${hash}).`,
    )
  }
  // An executed Safe transaction is confirmed only by the Safe's own
  // ExecutionSuccess for its exact hash, never by the receipt's status.
  if (
    safeContext?.mode === 'execute' &&
    safeExecutionResult(
      receipt,
      address,
      canonicalSafeTxHash(chainId, address, safeContext.tx),
    ).status !== 'success'
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
  tx: SafeQueuedTransaction,
  reverifyAuthority?: () => Promise<void>,
): Promise<ConfirmedContractWrite> {
  assertNoViewAs()
  refuseRefund(tx)
  await reverifyAuthority?.()
  const expectedAccount = getAccount(wagmiConfig).address
  if (!expectedAccount) throw new Error('Connect a wallet first.')
  const state = await readLiveSafeState(chainId, safe)
  canonicalSafeTxHash(chainId, safe, tx)
  assertSafeTxNonce(state, tx, 'execute')
  const confirmations = usableSafeConfirmations(tx, state.identity.owners)
  if (confirmations.length < state.identity.threshold) {
    throw new Error(
      `This transaction needs ${state.identity.threshold} current-owner signature${
        state.identity.threshold === 1 ? '' : 's'
      } before it can execute.`,
    )
  }
  const verifiedTx = { ...tx, confirmations }
  const args = safeExecutionArgs(verifiedTx, state.identity.owners)
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
  tx: SafeQueuedTransaction,
  reverifyAuthority?: () => Promise<void>,
): Promise<SafeExecutionSnapshot> {
  refuseRefund(tx)
  await reverifyAuthority?.()
  const state = await readLiveSafeState(chainId, safe)
  const safeTxHash = canonicalSafeTxHash(chainId, safe, tx)
  assertSafeTxNonce(state, tx, 'execute')
  const owners = state.identity.owners
  const confirmations = usableSafeConfirmations(tx, owners)
  if (confirmations.length < state.identity.threshold) {
    throw new Error(
      `Safe transaction #${tx.nonce} has ${confirmations.length}/${state.identity.threshold} current-owner signatures.`,
    )
  }
  const verifiedTx = { ...tx, confirmations }
  // The Safe service represents approveHash confirmations without a signature
  // and safeExecutionSignatures encodes those as v=1 prevalidated signatures. A
  // simulation sent from that owner would pass through msg.sender even after
  // the onchain approval was revoked, while Relayr's executor would revert.
  // Prove every v=1 approval directly (including a service which supplied the
  // 65-byte value explicitly), then simulate from address(0), which Safe
  // forbids as an owner, so the approvedHashes path is always exercised.
  for (const confirmation of confirmations) {
    if (!isApprovedHashConfirmation(confirmation)) continue
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
        args: safeExecutionArgs(verifiedTx, owners),
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
    owners: after.identity.owners,
  }
}

/** The exact `execTransaction` a Relayr bundle sends, signed by `owners`' usable confirmations. */
export function safeExecRelayrEntry(
  chainId: JBChainId,
  safe: Address,
  tx: SafeQueuedTransaction,
  owners: readonly Address[],
): RelayrEntry {
  canonicalSafeTxHash(chainId, safe, tx)
  refuseRefund(tx)
  return {
    chain: chainId,
    target: safe,
    data: encodeFunctionData({
      abi: SAFE_EXEC_ABI,
      functionName: 'execTransaction',
      args: safeExecutionArgs(tx, owners),
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
  tx: SafeQueuedTransaction,
  reverifyAuthority?: () => Promise<void>,
): Promise<ConfirmedContractWrite> {
  const expectedAccount = getAccount(wagmiConfig).address
  if (!expectedAccount) throw new Error('Connect a wallet first.')
  const args = [hash] as const
  const data = encodeFunctionData({
    abi: SAFE_EXEC_ABI,
    functionName: 'approveHash',
    args,
  })
  return sendContractAndConfirm({
    chainId,
    address: safe,
    abi: SAFE_EXEC_ABI,
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
          abi: SAFE_EXEC_ABI,
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
      // makes an outage read as an empty queue, so this proposal lands at the
      // Safe's nonce on top of whatever is really queued, and one of the two is
      // then stranded. If the listing fails, stop.
      const nextNonce = await getSafeNextNonce(call.chainId, call.safe)
      if (nextNonce === null) throw new Error('Could not read the Safe nonce.')
      const pending = await listPendingSafeTransactions(
        call.chainId,
        call.safe,
        nextNonce,
        SAFE_SERVICE,
      ).catch(() => {
        throw new Error(
          `Could not read the pending Safe queue on chain ${call.chainId}. Nothing was proposed. Try again shortly.`,
        )
      })
      const matching = pending.find(tx =>
        safeTransactionMatchesCall(tx, {
          to: call.target,
          data: call.data,
          value: call.value,
          operation: call.operation,
        }),
      )
      if (matching) {
        await call.onSafePrepared?.(matching)
        const matchingHash = canonicalSafeTxHash(
          call.chainId,
          call.safe,
          matching,
        )
        const alreadyConfirmed = usableSafeConfirmations(
          matching,
          info.owners,
        ).some(confirmation => isAddressEqual(confirmation.owner, signer))
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
      const proposed = await proposeSafeTx({
        ...call,
        signer,
        nonce: nextProposalNonce(nextNonce, pending),
      })
      results.push({
        chainId: call.chainId,
        mode: 'service',
        status: 'queued',
        nonce: proposed.nonce,
        safeTxHash: proposed.safeTxHash,
      })
      continue
    }

    onProgress?.(`Checking onchain Safe approvals ${index + 1}/${calls.length}…`)
    const context = await safeOnChainContext(call.chainId, call.safe)
    const safeKey = `${call.chainId}:${call.safe.toLowerCase()}`
    const nonce = Math.max(context.nonce, provisionalNonce.get(safeKey) ?? 0)
    provisionalNonce.set(safeKey, nonce + 1)
    const queued = proposalFor(call, nonce)
    const hash = safeTransactionHash(call.chainId, call.safe, queued)
    await call.onSafePrepared?.({ ...queued, safeTxHash: hash })
    const approvals = await safeApprovalsOf(
      call.chainId,
      call.safe,
      hash,
      context.owners,
    )
    // The owner who completes the threshold executes rather than approving
    // first: Safe counts the executing owner as a signature.
    const step = onchainApprovalStep({
      account: signer,
      approved: approvals,
      threshold: context.threshold,
    })
    if (step.kind === 'approve') {
      onProgress?.(`Approving onchain ${index + 1}/${calls.length}…`)
      const approval = await approveSafeHashOnChain(
        call.chainId,
        call.safe,
        hash,
        queued,
        call.reverifyAuthority,
      )
      results.push({
        chainId: call.chainId,
        mode: 'onchain',
        nonce,
        safeTxHash: hash,
        ...(approval.status === 'submitted'
          ? { status: 'submitted', transactionHash: approval.hash }
          : { status: 'waiting' }),
      })
      continue
    }
    if (step.kind === 'waiting') {
      results.push({
        chainId: call.chainId,
        mode: 'onchain',
        status: 'waiting',
        nonce,
        safeTxHash: hash,
      })
      continue
    }
    onProgress?.(`Executing Safe transaction ${index + 1}/${calls.length}…`)
    const execution = await executeSafeTx(call.chainId, call.safe, {
      ...queued,
      confirmations: step.signers.map(owner => ({ owner })),
    }, call.reverifyAuthority)
    results.push({
      chainId: call.chainId,
      mode: 'onchain',
      status: execution.status === 'confirmed' ? 'executed' : 'submitted',
      nonce,
      safeTxHash: hash,
      transactionHash: execution.hash,
    })
  }
  return results
}

/**
 * Whether `log` is `safe`'s ExecutionSuccess for `safeTxHash`, read as the SDK
 * reads a receipt: a way to find the execution, whose whole receipt is then
 * proved.
 */
export function isSafeExecutionSuccessLog(
  log: { address: Address; topics: readonly Hex[]; data: Hex },
  safe: Address,
  safeTxHash: Hex,
): boolean {
  return (
    safeExecutionResult({ status: 'success', logs: [log] }, safe, safeTxHash)
      .status === 'success'
  )
}

const SAME_ADDRESS_INELIGIBLE =
  'The source Safe, creation initializer, or destination state is no longer eligible for same-address deployment.'

/** Why the SDK refused a same-address deployment, as this app says it. */
function sameAddressRefusal(
  reason: SafeSameAddressDeploymentRefusal,
  safe: Address,
): string {
  switch (reason) {
    case 'rpc-error':
      return 'Could not verify this Safe onchain.'
    case 'address-occupied':
      return `${safe} already has code on this chain. Recheck its Safe policy instead of replaying deployment.`
    case 'factory-unavailable':
    case 'factory-mismatch':
    case 'singleton-unavailable':
    case 'singleton-mismatch':
      return 'The recognized Safe factory or singleton bytecode does not match across source and destination chains.'
    case 'setup-library-mismatch':
      return 'The canonical SafeToL2Setup library is missing or altered on the destination chain.'
    case 'contract-owner':
      return 'A source Safe owner is a contract on the destination chain, so its control policy cannot be replayed safely.'
    case 'fallback-handler-unavailable':
    case 'delegated-fallback-handler':
    case 'fallback-handler-mismatch':
      return 'The Safe fallback handler bytecode does not match across source and destination chains.'
    case 'simulation-failed':
    case 'unexpected-address':
      return `The Safe creation would not deploy ${safe} on this chain.`
    default:
      return SAME_ADDRESS_INELIGIBLE
  }
}

/**
 * Deploy the source chain's Safe at its own address on `chainId`, from its
 * creation record. The SDK proves the deployment before the review and again
 * before the wallet sends it; the deployed Safe must then match the source.
 */
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
  const signer = getAccount(wagmiConfig).address
  if (!signer) throw new Error(`Switch to a current signer of ${expectedSafe}.`)
  const prepare = async () => {
    await reverifyAuthority()
    const [deployment, nonceRaw] = await Promise.all([
      prepareSafeSameAddressDeployment({
        sourceClient,
        destinationClient: client,
        creation,
        safe: expectedSafe,
        from: signer,
      }),
      readBoundedSafeNonce(sourceClient, expectedSafe),
    ])
    if (!deployment.valid) {
      throw new Error(sameAddressRefusal(deployment.reason, expectedSafe))
    }
    const nonce = nonceRaw === null ? NaN : Number(nonceRaw)
    if (!Number.isSafeInteger(nonce) || nonce < 0) {
      throw new Error(SAME_ADDRESS_INELIGIBLE)
    }
    if (!deployment.source.owners.some(owner => isAddressEqual(owner, signer))) {
      throw new Error(`Switch to a current signer of ${expectedSafe}.`)
    }
    return {
      call: deployment.call,
      state: { identity: deployment.source, nonce } satisfies LiveSafeState,
    }
  }
  const before = await prepare()
  const submission = await sendContractAndConfirm({
    chainId,
    address: before.call.target,
    abi: SAFE_CREATE_ABI,
    functionName: before.call.functionName,
    args: before.call.args,
    reverifyAuthority: async () => {
      assertSafeStateUnchanged(before.state, (await prepare()).state)
    },
    expectedAccount: signer,
  })
  for (let attempt = 0; attempt < 6; attempt++) {
    const code = await client.getCode({ address: expectedSafe }).catch(() => null)
    if (code && code !== '0x') {
      await reverifyAuthority()
      const confirmed = await readMatchingAuthorityIdentities({
        sourceChainId,
        sourceClient,
        destinationClient: client,
        authority: expectedSafe,
        service: SAFE_SERVICE,
      })
      if (confirmed?.creationUnproven) throw new UnprovenSafeError(chainId)
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
