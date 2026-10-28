'use client'

import { assertShopCallPolicy } from '@/lib/shop-call-policy'

import { queuedSafeReviewCall } from '@/lib/safe-queue-review'

import { getAccount } from '@wagmi/core'
import {
  decodeFunctionResult,
  encodeFunctionData,
  isAddressEqual,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
  type TransactionReceipt,
} from 'viem'
import type { JBChainId } from '@bananapus/nana-sdk-core'
import { wagmiConfig } from '@/providers/Providers'
import type { RelayrEntry } from '@bananapus/nana-sdk-core/review/relayr'
import { assertNoViewAs } from '@/lib/viewAs'
import { captureWalletContext } from '@/lib/wallet-context'
import {
  gasWithinCap,
  simulateStateChangingTransaction,
  TRANSACTION_SIMULATION_GAS,
  type ReviewContextRow,
} from '@bananapus/nana-sdk-core/review'
import {
  MULTI_SEND_CALL_ONLY,
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
  safeBatchProposalFor,
  safeExecutionArgs,
  safeExecutionResult,
  safeProposalFor,
  safeTransactionHash,
  safeTransactionHasRefund,
  safeTransactionMatchesCall,
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
import { publicClient } from '@/lib/wallet-core'
import type { TransactionReviewCall, TransactionReviewRequest } from '@/lib/transaction-review'
import { loadReviewEngine, loadReviewedSendDeps } from '@/lib/preload-review'
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

async function fetchSafeInfo(
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

/** Re-prove the original quoted signatures, even if the service added more confirmations. */
export async function simulateFrozenSafeExecution(
  chainId: JBChainId,
  safe: Address,
  nonce: number,
  data: Hex,
  expectedPolicy?: string,
): Promise<string> {
  assertShopCallPolicy(data, safe)
  const before = await readLiveSafeState(chainId, safe)
  const policy = safePolicyFingerprint(before.identity)
  if (before.nonce !== nonce || (expectedPolicy && expectedPolicy !== policy)) {
    throw new Error('The Safe policy or nonce changed. Review the transaction again.')
  }
  const result = await simulateStateChangingTransaction(publicClient(chainId), {
    from: zeroAddress,
    to: safe,
    data,
    gas: SAFE_EXECUTION_WRITE_GAS,
  })
  if (decodeFunctionResult({ abi: SAFE_EXEC_ABI, functionName: 'execTransaction', data: result }) !== true) {
    throw new Error(`Safe transaction #${nonce} would not execute successfully.`)
  }
  assertSafeStateUnchanged(before, await readLiveSafeState(chainId, safe))
  return policy
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
  reverifyAuthority?: () => Promise<void>,
): Promise<Hex> {
  assertShopCallPolicy(tx.data as Hex, tx.to, Number(tx.operation ?? 0))
  const assertWallet = captureWalletContext(wagmiConfig, { account: signer, chainId })
  const viaSafe = isSafeConnection(wagmiConfig)
  const activeAccount = getAccount(wagmiConfig).address
  if (!activeAccount || activeAccount.toLowerCase() !== signer.toLowerCase()) {
    throw new Error('Connected account changed. Review the Safe transaction again.')
  }
  await reverifyAuthority?.()
  const expectedHash = canonicalSafeTxHash(chainId, safe, tx)
  const before = await readLiveSafeState(chainId, safe)
  assertCurrentSafeSigner(before, signer)
  assertSafeTxNonce(before, tx, 'pending')
  // Core reviews the exact SafeTx with its decoded call and signs it; the Safe's live state is rechecked first.
  const { signReviewed } = await loadReviewEngine()
  const reviewedSendDeps = await loadReviewedSendDeps()
  const [signature] = await signReviewed([{ kind: 'safe-tx', chainId, safe, tx }], {
    account: signer,
    title: label ? `Review ${label}` : 'Review Safe transaction',
    description: `Your signature authorizes Safe ${safe} to make this exact call at nonce ${tx.nonce}. It may execute once the Safe has enough approvals.`,
    reverify: async () => {
      await reverifyAuthority?.()
      const after = await readLiveSafeState(chainId, safe)
      assertCurrentSafeSigner(after, signer)
      assertSafeTxNonce(after, tx, 'pending')
      assertSafeStateUnchanged(before, after)
      if (canonicalSafeTxHash(chainId, safe, tx) !== expectedHash) {
        throw new Error('The queued Safe transaction changed during review.')
      }
      assertShopCallPolicy(tx.data as Hex, tx.to, Number(tx.operation ?? 0))
      assertWallet()
      if (isSafeConnection(wagmiConfig) !== viaSafe) throw new Error('Connected wallet changed. Review the Safe transaction again.')
    },
  }, reviewedSendDeps)
  await reverifyAuthority?.()
  const signed = await readLiveSafeState(chainId, safe)
  assertCurrentSafeSigner(signed, signer)
  assertSafeTxNonce(signed, tx, 'pending')
  assertSafeStateUnchanged(before, signed)
  if (canonicalSafeTxHash(chainId, safe, tx) !== expectedHash) {
    throw new Error('The queued Safe transaction changed while signing.')
  }
  assertWallet()
  if (isSafeConnection(wagmiConfig) !== viaSafe) throw new Error('Connected wallet changed. Review the Safe transaction again.')
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
 * MultiSendCallOnly 1.3.0 with a canonical batch, never another DELEGATECALL.
 * A batch is proposed through 1.3.0 (safeBatchProposalFor), so a batch that
 * names another MultiSendCallOnly is refused, not proposed through one it
 * does not name.
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
  const calls = isAddressEqual(to, MULTI_SEND_CALL_ONLY)
    ? multiSendCallsOf({ to, data: call.data, operation: 1 })
    : null
  if (!calls || value !== 0n) {
    throw new Error('A Safe DELEGATECALL must be a MultiSendCallOnly 1.3.0 batch.')
  }
  return safeBatchProposalFor(calls, nonce)
}

async function proposeSafeTx({
  chainId,
  safe,
  signer,
  nonce,
  label,
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
  const signature = await signSafeTx(chainId, safe, tx, signer, label, reverifyAuthority)
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
  label?: string,
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
    label,
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

/** The queued Safe transaction a Safe write executes or approves, as the review shows it. */
function safeContextRows(chainId: JBChainId, safe: Address, context: SafeWriteContext): ReviewContextRow[] {
  const { tx } = context
  return [{
    label: `Safe transaction #${tx.nonce}`,
    value: canonicalSafeTxHash(chainId, safe, tx),
    mono: true,
    lines: [
      `To ${tx.to}`,
      `Value ${tx.value} wei`,
      `Operation ${Number(tx.operation) === 1 ? 'delegatecall' : 'call'}`,
      `Data ${tx.data ?? '0x'}`,
    ],
    note: context.mode === 'approve' ? 'Approving does not execute it yet.' : undefined,
  }]
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
  signal,
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
  /** The flow's: when it aborts, a Safe app's wait for its proposal's execution ends, and the proposal stays submitted. */
  signal: AbortSignal
}): Promise<ConfirmedContractWrite> {
  assertNoViewAs()
  const assertWallet = captureWalletContext(wagmiConfig, { account: expectedAccount, chainId })
  const viaSafe = isSafeConnection(wagmiConfig)
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
  // The cap is a simulation bound, not a price. Sending it would make the
  // wallet reserve cap * maxFeePerGas — 10M gas on Ethereum is a ~0.01 ETH
  // balance requirement for an execution that costs a fraction of it. The
  // limit is measured once, inside the cap, so the review shows the sent gas.
  const gas = viaSafe
    ? undefined
    : ((await gasWithinCap(client, { account: expectedAccount, to: address, data }, gasCap)) ??
      gasCap)
  const label = review?.calls[0]?.label ?? (
    functionName === 'execTransaction'
      ? 'Execute Safe transaction'
      : functionName === 'approveHash'
        ? 'Approve Safe transaction hash'
        : functionName === 'createProxyWithNonce'
          ? 'Deploy Safe on this chain'
          : functionName)
  const before = safeContext
    ? await verifySafeWriteContext(chainId, address, expectedAccount, safeContext)
    : null
  const { sendReviewed, ReviewedReceiptUnverifiedError } = await loadReviewEngine()
  const reviewedSendDeps = await loadReviewedSendDeps()
  let sent: Hex | undefined
  let result
  try {
    // Core reviews and sends the exact call; jbm's Safe checks run before the wallet opens.
    result = await sendReviewed({
      account: expectedAccount,
      calls: [{
        chainId, to: address, data, abi, functionName, args, label,
        contractName: review?.calls[0]?.contractName ?? (functionName === 'createProxyWithNonce' ? 'Safe Proxy Factory' : 'Safe'),
        ...(gas === undefined ? {} : { gas }),
      }],
      title: review?.title ?? 'Review onchain transaction',
      confirmLabel: viaSafe ? 'Agree & continue to Safe' : review?.confirmLabel,
      context: safeContext ? safeContextRows(chainId, address, safeContext) : undefined,
      description: [review?.description, viaSafe ? SAFE_NONCE_GUIDANCE : null].filter(Boolean).join(' ') || undefined,
      guard: assertNoViewAs,
      // The slow checks run first, so the Safe policy and wallet are read last before the send.
      reverify: async () => {
        if (functionName === 'execTransaction') {
          const simulation = await simulateStateChangingTransaction(client, { from: expectedAccount, to: address, data, gas: gasCap })
          let succeeds = false
          try {
            succeeds = decodeFunctionResult({ abi: SAFE_EXEC_ABI, functionName: 'execTransaction', data: simulation })
          } catch {
            // Handled by the fail-closed result check below.
          }
          if (succeeds !== true) throw new Error('Safe simulation reported that the transaction would fail.')
        }
        await reverifyAuthority?.()
        if (safeContext) assertShopCallPolicy(safeContext.tx.data as Hex, safeContext.tx.to, Number(safeContext.tx.operation ?? 0))
        if (safeContext && before) {
          assertSafeStateUnchanged(before, await verifySafeWriteContext(chainId, address, expectedAccount, safeContext))
        }
        assertWallet()
        if (isSafeConnection(wagmiConfig) !== viaSafe) {
          throw new Error('Connected wallet changed. Review the transaction again.')
        }
      },
      onSubmitted: (_call, _step, hash) => { sent = hash },
      // A receipt still confirming is followed before this resolves.
      follow: { signal },
    }, reviewedSendDeps)
  } catch (error) {
    // A sent transaction whose receipt its hold has not verified is submitted, never rejected.
    if (sent && error instanceof ReviewedReceiptUnverifiedError) return { hash: sent, status: 'submitted' }
    throw error
  }
  let hash: Hex
  if (result.status === 'proposed') {
    // A Safe app replies with its proposal; its execution is what lands.
    hash = await waitForSafeExecutionHash(chainId, result.safeTxHash, { signal })
    let receipt
    try {
      receipt = await client.waitForTransactionReceipt({ hash })
    } catch {
      return { hash, status: 'submitted' }
    }
    if (receipt.status !== 'success') {
      throw new Error(`${functionName} reverted onchain (tx ${hash}).`)
    }
    await requireSafeProposalSuccess(
      { client, receipt, safe: expectedAccount, proposalHash: result.safeTxHash, calls: [{ to: address, data }] },
      `${functionName} reverted after Safe execution (tx ${hash}).`,
    )
    assertExecuted(receipt)
  } else {
    const receipt = result.receipts[0]
    hash = receipt.transactionHash
    assertExecuted(receipt)
  }
  return { hash, status: 'confirmed' }

  // An executed Safe transaction is confirmed only by the Safe's own
  // ExecutionSuccess for its exact hash, never by the receipt's status.
  function assertExecuted(receipt: TransactionReceipt) {
    if (
      safeContext?.mode === 'execute' &&
      safeExecutionResult(receipt, address, canonicalSafeTxHash(chainId, address, safeContext.tx)).status !== 'success'
    ) {
      throw new Error(`Safe transaction ${receipt.transactionHash} was mined, but its exact inner call did not execute successfully.`)
    }
  }
}

export async function executeSafeTx(
  chainId: JBChainId,
  safe: Address,
  tx: SafeQueuedTransaction,
  {
    reverifyAuthority,
    signal,
  }: {
    reverifyAuthority?: () => Promise<void>
    /** The flow's: when it aborts, a Safe app's wait for its proposal's execution ends. */
    signal: AbortSignal
  },
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
        'Your wallet will send the outer Safe execTransaction call below. The row above it is the exact inner call the Safe will execute.',
      confirmLabel: 'Agree & execute Safe transaction',
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
          calls: [queuedSafeReviewCall(chainId, verifiedTx)],
        },
      ],
    },
    safeContext: { mode: 'execute', tx: verifiedTx },
    reverifyAuthority,
    expectedAccount,
    signal,
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
  assertShopCallPolicy(tx.data as Hex, tx.to, Number(tx.operation ?? 0))
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
  signal: AbortSignal,
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
        'Your wallet will send approveHash to the Safe. The row above it is the exact queued call this digest authorizes; approval does not execute it yet.',
      confirmLabel: 'Agree & approve Safe hash',
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
    signal,
  })
}

/** Route a set of already-reviewed calls through each controlling Safe. */
export async function runSafeCalls({
  calls,
  signer,
  onProgress,
  signal,
}: {
  calls: SafeCall[]
  signer: Address
  onProgress?: (message: string) => void
  /** The flow's: when it aborts, a Safe app's wait for a proposal's execution ends. */
  signal: AbortSignal
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
            call.label,
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
        signal,
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
    }, { reverifyAuthority: call.reverifyAuthority, signal })
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

/** Whether `log` is `safe`'s result for `safeTxHash`: ExecutionSuccess or ExecutionFailure. */
export function isSafeExecutionLog(
  log: { address: Address; topics: readonly Hex[]; data: Hex },
  safe: Address,
  safeTxHash: Hex,
): boolean {
  const { status } = safeExecutionResult({ status: 'success', logs: [log] }, safe, safeTxHash)
  return status === 'success' || status === 'failed'
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
    signal,
  }: {
    sourceChainId: JBChainId
    reverifyAuthority: () => Promise<void>
    /** The flow's: when it aborts, a Safe app's wait for its proposal's execution ends. */
    signal: AbortSignal
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
    signal,
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
