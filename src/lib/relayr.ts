'use client'

import { getAccount } from '@wagmi/core'
import {
  JBCoreContracts,
  erc2771ForwarderAbi,
  jbContractAddress,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import {
  encodeFunctionData,
  formatEther,
  isAddress,
  keccak256,
  stringToHex,
  type Abi,
  type Address,
  type Hex,
} from 'viem'
import { SUPPORTED_CHAINS, wagmiConfig } from '@/providers/Providers'
import { requireTransactionReview } from '@/lib/transaction-review'
import { assertNoViewAs } from '@/lib/viewAs'
import {
  isSafeConnection,
  SAFE_NONCE_GUIDANCE,
  waitForSafeExecutionHash,
} from '@/lib/safe-connector'
import {
  connectedWallet as connectedWalletCore,
  publicClient,
} from '@/lib/wallet-core'

const RELAYR_API = 'https://api.relayr.ba5ed.com'
const RELAYR_PENDING_PREFIX = 'jb-relayr-pending-v1:'
const RELAYR_QUOTE_TIMEOUT_MS = 45_000
const RELAYR_STATUS_REQUEST_TIMEOUT_MS = 15_000

export type RelayrEntry = {
  chain: number
  target: Address
  data: Hex
  value: string
  virtual_nonce?: number
}

export type RelayrCall = {
  chainId: JBChainId
  target: Address
  data: Hex
  value?: bigint
  gas?: bigint
  label?: string
  abi?: Abi
  functionName?: string
  args?: readonly unknown[]
  contractName?: string
}

/** Stable storage key for a particular set of authority calls. */
export function relayrCallsScope(calls: RelayrCall[]): string {
  const stableCalls = calls.map(call => [
    Number(call.chainId),
    call.target.toLowerCase(),
    call.data.toLowerCase(),
    (call.value ?? 0n).toString(),
  ])

  return `authority:${keccak256(stringToHex(JSON.stringify(stableCalls)))}`
}

export type RelayrPayment = {
  chain: number
  amount: string
  calldata: Hex
  target: Address
  token?: Address
  payment_deadline?: number
}

export type RelayrTransactionStatus = {
  state?: string
  data?: {
    hash?: Hex
    transaction?: { hash?: Hex }
  }
}

export type RelayrTransactionRecord = {
  chain?: number
  status?: RelayrTransactionStatus
}

export type RelayrQuote = {
  bundle_uuid: string
  payment_info: RelayrPayment[]
  transactions?: RelayrTransactionRecord[]
}

export type RelayrProgressSummary = {
  confirmed: number
  failed: number
  pending: number
  total: number
}

export type RelayrPendingSession = {
  bundleUuid: string
  paymentHash: Hex | null
  paymentChainId: number | null
  paymentStatus: 'submitted' | 'confirmed'
  chainIds: number[]
  expectedCount: number
  records: RelayrTransactionRecord[]
  itemCount: number
  account: string | null
  createdAt: number
}

export type RelayrExecutionErrorCode = 'RELAYR_FAILED' | 'RELAYR_TIMEOUT'

export class RelayrExecutionError extends Error {
  readonly name = 'RelayrExecutionError'

  constructor(
    message: string,
    readonly code: RelayrExecutionErrorCode,
    readonly bundleUuid: string,
    readonly records: RelayrTransactionRecord[],
    readonly retryable: boolean,
  ) {
    super(message)
  }
}

/**
 * The Relayr payment has a real transaction hash, but its receipt could not be
 * read. This is an unknown submitted outcome, never a failed/no-op outcome.
 */
export class RelayrPaymentSubmittedError extends Error {
  readonly name = 'RelayrPaymentSubmittedError'

  constructor(
    readonly hash: Hex,
    readonly chainId: number,
  ) {
    super(
      `Relayr payment ${hash} was submitted on chain ${chainId}, but confirmation is not available yet. Do not pay again; resume the saved bundle instead.`,
    )
  }
}

export function relayrStateIsSuccess(state?: string): boolean {
  const normalized = state?.trim().toLowerCase()
  return normalized === 'success' || normalized === 'completed'
}

export function relayrStateIsFailed(state?: string): boolean {
  return state?.trim().toLowerCase() === 'failed'
}

export function relayrProgress(
  records: RelayrTransactionRecord[],
  expectedCount = records.length,
): RelayrProgressSummary {
  const total = Math.max(expectedCount, records.length)
  const confirmed = records.filter(record =>
    relayrStateIsSuccess(record.status?.state),
  ).length
  const failed = records.filter(record =>
    relayrStateIsFailed(record.status?.state),
  ).length

  return {
    confirmed,
    failed,
    pending: Math.max(total - confirmed - failed, 0),
    total,
  }
}

/** A timeout means Relayr may still execute a paid bundle. Do not submit it again blindly. */
export function relayrErrorIsUncertain(error: unknown): boolean {
  return (
    error instanceof RelayrPaymentSubmittedError ||
    (error instanceof RelayrExecutionError && error.code === 'RELAYR_TIMEOUT')
  )
}

class RelayrHttpTimeoutError extends Error {
  readonly name = 'RelayrHttpTimeoutError'
}

async function relayrFetch(
  url: string,
  init: RequestInit | undefined,
  timeoutMs: number,
): Promise<Response> {
  try {
    return await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      throw new RelayrHttpTimeoutError('Relayr did not respond in time.')
    }
    throw error
  }
}

function relayrRecordSnapshot(
  record: RelayrTransactionRecord,
): RelayrTransactionRecord {
  const hash = relayrDestinationHash(record)
  return {
    ...(typeof record.chain === 'number' ? { chain: record.chain } : {}),
    status: {
      ...(typeof record.status?.state === 'string'
        ? { state: record.status.state }
        : {}),
      ...(hash ? { data: { hash } } : {}),
    },
  }
}

/** Persist only the receipt/status data needed to resume polling a paid bundle. */
export function saveRelayrPendingSession(
  scope: string,
  session: RelayrPendingSession,
): RelayrPendingSession {
  const safeSession: RelayrPendingSession = {
    bundleUuid: session.bundleUuid,
    paymentHash: session.paymentHash,
    paymentChainId: session.paymentChainId,
    paymentStatus: session.paymentStatus,
    chainIds: session.chainIds.filter(
      chainId => Number.isSafeInteger(chainId) && chainId > 0,
    ),
    expectedCount: session.expectedCount,
    records: session.records.map(relayrRecordSnapshot),
    itemCount: session.itemCount,
    account: session.account,
    createdAt: session.createdAt,
  }
  if (typeof window === 'undefined') return safeSession
  try {
    window.localStorage.setItem(
      `${RELAYR_PENDING_PREFIX}${scope}`,
      JSON.stringify(safeSession),
    )
  } catch {
    // Storage may be unavailable; the in-memory session still drives the flow.
  }
  return safeSession
}

export function loadRelayrPendingSession(
  scope: string,
): RelayrPendingSession | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(`${RELAYR_PENDING_PREFIX}${scope}`)
    if (!raw) return null
    const value = JSON.parse(raw) as Partial<RelayrPendingSession>
    if (
      typeof value.bundleUuid !== 'string' ||
      !value.bundleUuid ||
      typeof value.expectedCount !== 'number' ||
      !Number.isSafeInteger(value.expectedCount) ||
      value.expectedCount < 1 ||
      typeof value.itemCount !== 'number' ||
      !Number.isSafeInteger(value.itemCount) ||
      value.itemCount < 1 ||
      typeof value.createdAt !== 'number' ||
      !Array.isArray(value.records)
    ) {
      return null
    }
    return saveRelayrPendingSession(scope, {
      bundleUuid: value.bundleUuid,
      paymentHash:
        typeof value.paymentHash === 'string' && /^0x[0-9a-fA-F]+$/.test(value.paymentHash)
          ? (value.paymentHash as Hex)
          : null,
      paymentChainId:
        typeof value.paymentChainId === 'number' ? value.paymentChainId : null,
      paymentStatus:
        value.paymentStatus === 'submitted' ? 'submitted' : 'confirmed',
      chainIds: Array.isArray(value.chainIds)
        ? value.chainIds.filter(
            (chainId): chainId is number =>
              typeof chainId === 'number' &&
              Number.isSafeInteger(chainId) &&
              chainId > 0,
          )
        : value.records
            .map(record => record.chain)
            .filter((chainId): chainId is number => typeof chainId === 'number'),
      expectedCount: value.expectedCount,
      records: value.records,
      itemCount: value.itemCount,
      account: typeof value.account === 'string' ? value.account : null,
      createdAt: value.createdAt,
    })
  } catch {
    return null
  }
}

/** Scopes of every persisted pending-bundle session on this device. */
export function listRelayrPendingScopes(): string[] {
  if (typeof window === 'undefined') return []
  try {
    const scopes: string[] = []
    for (let index = 0; index < window.localStorage.length; index++) {
      const key = window.localStorage.key(index)
      if (key?.startsWith(RELAYR_PENDING_PREFIX)) {
        scopes.push(key.slice(RELAYR_PENDING_PREFIX.length))
      }
    }
    return scopes
  } catch {
    return []
  }
}

// Relayr is expected to ship a query-by-account API soon. When it does,
// replace this localStorage scan with a fetch against that endpoint so
// any viewer (and any device) sees the account's Relayr history/state.
export async function fetchRelayrBundlesByAccount(
  address: string,
): Promise<{ scope: string; session: RelayrPendingSession }[]> {
  const wanted = address.toLowerCase()
  return listRelayrPendingScopes()
    .map(scope => ({ scope, session: loadRelayrPendingSession(scope) }))
    .filter(
      (entry): entry is { scope: string; session: RelayrPendingSession } =>
        entry.session?.account?.toLowerCase() === wanted,
    )
    .sort((a, b) => b.session.createdAt - a.session.createdAt)
}

export function clearRelayrPendingSession(scope: string): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(`${RELAYR_PENDING_PREFIX}${scope}`)
  } catch {
    // Storage may be unavailable. There is no sensitive payload to clean up.
  }
}

export type RelayrProgress =
  | { phase: 'signing'; current: number; total: number; chainId: number }
  | { phase: 'quoting' }
  | { phase: 'paying'; payment: RelayrPayment }
  | {
      phase: 'payment-submitted'
      payment: RelayrPayment
      paymentHash: Hex
      bundleUuid: string
    }
  | {
      phase: 'payment-confirmed'
      payment: RelayrPayment
      paymentHash: Hex
      bundleUuid: string
    }
  | {
      phase: 'executing'
      done: number
      total: number
      records: RelayrTransactionRecord[]
      bundleUuid: string
      paymentHash: Hex | null
    }

const FORWARD_REQUEST_TYPES = {
  ForwardRequest: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'gas', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint48' },
    { name: 'data', type: 'bytes' },
  ],
} as const

function connectedWallet(chainId: JBChainId) {
  return connectedWalletCore(chainId, {
    requireUnchanged: true,
    changedError: 'Connected account changed. Review the cross-chain request again.',
  })
}

/** Sign one EIP-2771 request for a Relayr destination transaction. */
async function buildForwardedTx(
  call: RelayrCall,
  expectedAccount: Address,
): Promise<RelayrEntry> {
  const forwarder = jbContractAddress['6'][JBCoreContracts.ERC2771Forwarder][
    call.chainId
  ] as Address | undefined
  if (!forwarder) throw new Error(`No ERC-2771 forwarder on chain ${call.chainId}.`)

  const client = publicClient(call.chainId)
  const activeAccount = getAccount(wagmiConfig).address
  if (!activeAccount || activeAccount.toLowerCase() !== expectedAccount.toLowerCase()) {
    throw new Error('Connected account changed. Review the cross-chain request again.')
  }

  const [domain, nonce] = await Promise.all([
    client.readContract({
      address: forwarder,
      abi: erc2771ForwarderAbi,
      functionName: 'eip712Domain',
    }),
    client.readContract({
      address: forwarder,
      abi: erc2771ForwarderAbi,
      functionName: 'nonces',
      args: [expectedAccount],
    }),
  ])

  const value = call.value ?? 0n
  const request = {
    from: expectedAccount,
    to: call.target,
    value,
    gas: call.gas ?? 500_000n,
    nonce,
    deadline: Math.floor(Date.now() / 1000) + 47 * 60 * 60,
    data: call.data,
  }
  const typedDomain = {
    name: domain[1],
    version: domain[2],
    chainId: BigInt(call.chainId),
    verifyingContract: forwarder,
  } as const
  await requireTransactionReview({
    kind: 'authorization',
    title: 'Review relayed transaction',
    description:
      'Your signature authorizes Relayr to submit this exact destination call onchain. The Raw view includes the full ERC-2771 request. The separate Relayr payment is reviewed before it is sent.',
    confirmLabel: 'Agree & sign relay request',
    authorization: {
      type: 'EIP-712 ForwardRequest',
      domain: typedDomain,
      primaryType: 'ForwardRequest',
      message: request,
    },
    calls: [
      {
        chainId: call.chainId,
        from: expectedAccount,
        to: call.target,
        value,
        data: call.data,
        label: call.label ?? 'Relayed Juicebox transaction',
        abi: call.abi,
        functionName: call.functionName,
        args: call.args,
        contractName: call.contractName,
      },
    ],
  })
  const { wallet, account } = await connectedWallet(call.chainId)
  if (account.toLowerCase() !== expectedAccount.toLowerCase()) {
    throw new Error('Connected account changed. Review the cross-chain request again.')
  }
  const signature = await wallet.signTypedData({
    account: expectedAccount,
    domain: typedDomain,
    types: FORWARD_REQUEST_TYPES,
    primaryType: 'ForwardRequest',
    message: request,
  })

  const live = getAccount(wagmiConfig).address
  if (!live || live.toLowerCase() !== expectedAccount.toLowerCase()) {
    throw new Error('Connected account changed. Review the cross-chain request again.')
  }

  return {
    chain: call.chainId,
    target: forwarder,
    data: encodeFunctionData({
      abi: erc2771ForwarderAbi,
      functionName: 'execute',
      args: [{
        from: request.from,
        to: request.to,
        value: request.value,
        gas: request.gas,
        deadline: request.deadline,
        data: request.data,
        signature,
      }],
    }),
    value: value.toString(),
  }
}

export async function relayrPostBundle(
  transactions: RelayrEntry[],
): Promise<RelayrQuote> {
  const nextNonce = new Map<number, number>()
  const ordered = transactions.map(transaction => {
    const nonce = nextNonce.get(transaction.chain) ?? 0
    nextNonce.set(transaction.chain, nonce + 1)
    return { ...transaction, virtual_nonce: nonce }
  })
  let response: Response
  try {
    response = await relayrFetch(
      `${RELAYR_API}/v1/bundle/prepaid`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transactions: ordered,
          virtual_nonce_mode: 'ChainIndependent',
        }),
      },
      RELAYR_QUOTE_TIMEOUT_MS,
    )
  } catch (error) {
    if (error instanceof RelayrHttpTimeoutError) {
      throw new Error(
        'Relayr did not return a quote in time. Nothing was paid; it is safe to try again.',
      )
    }
    throw error
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(
      `Relayr HTTP ${response.status}${detail ? `: ${detail.slice(0, 240)}` : ''}`,
    )
  }
  return (await response.json()) as RelayrQuote
}

export function relayrPaymentLabel(payment: RelayrPayment): string {
  const chain = SUPPORTED_CHAINS.find(item => item.id === Number(payment.chain))
  const amount = Number(formatEther(BigInt(payment.amount)))
  return `${chain?.name ?? `Chain ${payment.chain}`} — ~${amount.toFixed(5)} ETH`
}

export async function relayrPay(
  payment: RelayrPayment,
  expectedAccount: Address,
  onSubmitted?: (hash: Hex) => void,
): Promise<Hex> {
  assertNoViewAs()
  const chainId = Number(payment.chain) as JBChainId
  if (!SUPPORTED_CHAINS.some(chain => chain.id === chainId)) {
    throw new Error('Relayr returned an unsupported payment chain.')
  }
  if (!isAddress(payment.target)) {
    throw new Error('Relayr returned an invalid payment target.')
  }
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(payment.calldata ?? '')) {
    throw new Error('Relayr returned invalid payment calldata.')
  }
  const value = BigInt(payment.amount)
  if (value < 0n) throw new Error('Relayr returned an invalid payment amount.')
  if (
    payment.payment_deadline &&
    payment.payment_deadline <= Math.floor(Date.now() / 1000) + 15
  ) {
    throw new Error('This Relayr quote expired. Review the action again for a new quote.')
  }

  await requireTransactionReview({
    title: 'Review Relayr payment',
    description:
      'This payment funds the Relayr bundle. Review its exact chain, destination, native value, and calldata before opening your wallet.' +
      (isSafeConnection(wagmiConfig) ? ` ${SAFE_NONCE_GUIDANCE}` : ''),
    confirmLabel: isSafeConnection(wagmiConfig)
      ? 'Agree & continue to Safe'
      : 'Agree & pay Relayr',
    calls: [
      {
        chainId,
        from: expectedAccount,
        to: payment.target,
        value,
        data: payment.calldata,
        label: 'Pay for relayed transactions',
        contractName: 'Relayr payment contract',
      },
    ],
  })

  const { wallet, account } = await connectedWallet(chainId)
  if (account.toLowerCase() !== expectedAccount.toLowerCase()) {
    throw new Error('Connected account changed. Review the Relayr payment again.')
  }
  const client = publicClient(chainId)
  await client.estimateGas({
    account,
    to: payment.target,
    value,
    data: payment.calldata,
  })
  const live = getAccount(wagmiConfig).address
  if (!live || live.toLowerCase() !== expectedAccount.toLowerCase()) {
    throw new Error('Connected account changed. Review the Relayr payment again.')
  }
  let hash = await wallet.sendTransaction({
    account,
    to: payment.target,
    value,
    data: payment.calldata,
  })
  onSubmitted?.(hash)
  if (isSafeConnection(wagmiConfig)) {
    hash = await waitForSafeExecutionHash(chainId, hash)
  }
  let receipt
  try {
    receipt = await client.waitForTransactionReceipt({ hash })
  } catch {
    throw new RelayrPaymentSubmittedError(hash, chainId)
  }
  if (receipt.status !== 'success') throw new Error('Relayr payment reverted onchain.')
  return hash
}

export async function relayrPoll(
  uuid: string,
  onUpdate?: (records: RelayrTransactionRecord[]) => void,
  intervalMs = 2_500,
  timeoutMs = 5 * 60_000,
): Promise<RelayrTransactionRecord[]> {
  const started = Date.now()
  let lastRecords: RelayrTransactionRecord[] = []
  for (;;) {
    try {
      const elapsed = Date.now() - started
      const response = await relayrFetch(
        `${RELAYR_API}/v1/bundle/${uuid}`,
        undefined,
        Math.min(RELAYR_STATUS_REQUEST_TIMEOUT_MS, Math.max(timeoutMs - elapsed, 1)),
      )
      if (response.ok) {
        const body = (await response.json()) as {
          transactions?: RelayrTransactionRecord[]
        }
        const records = body.transactions ?? []
        lastRecords = records
        onUpdate?.(records)
        if (
          records.length > 0 &&
          records.every(record => relayrStateIsSuccess(record.status?.state))
        ) {
          return records
        }
        const progress = relayrProgress(records)
        if (progress.failed) {
          throw new RelayrExecutionError(
            `Could not execute on ${progress.failed} chain${progress.failed === 1 ? '' : 's'}.`,
            'RELAYR_FAILED',
            uuid,
            records,
            false,
          )
        }
      }
    } catch (error) {
      if (error instanceof RelayrExecutionError) throw error
    }
    if (Date.now() - started > timeoutMs) {
      throw new RelayrExecutionError(
        `Relayr is still processing paid bundle ${uuid}. Do not submit this action again; check the original bundle later.`,
        'RELAYR_TIMEOUT',
        uuid,
        lastRecords,
        true,
      )
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
}

export function relayrDestinationHash(
  record: RelayrTransactionRecord,
): Hex | null {
  return record.status?.data?.hash ?? record.status?.data?.transaction?.hash ?? null
}

function relayrSessionFinished(
  records: RelayrTransactionRecord[],
  expectedCount: number,
): boolean {
  const progress = relayrProgress(records, expectedCount)
  return progress.confirmed === progress.total
}

function relayrSessionFullyFailed(
  records: RelayrTransactionRecord[],
  expectedCount: number,
): boolean {
  const progress = relayrProgress(records, expectedCount)
  return progress.failed === progress.total && progress.confirmed === 0
}

/** Resume a persisted, already-paid bundle: report progress, poll to done. */
async function resumeSavedRelayrSession(
  pendingScope: string,
  saved: RelayrPendingSession,
  onProgress?: (progress: RelayrProgress) => void,
): Promise<{
  quote: RelayrQuote
  paymentHash: Hex | null
  records: RelayrTransactionRecord[]
}> {
  const reportProgress = (records: RelayrTransactionRecord[]) => {
    const progress = relayrProgress(records, saved.expectedCount)
    onProgress?.({
      phase: 'executing',
      done: progress.confirmed,
      total: progress.total,
      records,
      bundleUuid: saved.bundleUuid,
      paymentHash: saved.paymentHash,
    })
  }
  reportProgress(saved.records)

  if (relayrSessionFinished(saved.records, saved.expectedCount)) {
    clearRelayrPendingSession(pendingScope)
    return {
      quote: {
        bundle_uuid: saved.bundleUuid,
        payment_info: [],
        transactions: saved.records,
      },
      paymentHash: saved.paymentHash,
      records: saved.records,
    }
  }
  if (relayrSessionFullyFailed(saved.records, saved.expectedCount)) {
    clearRelayrPendingSession(pendingScope)
    throw new RelayrExecutionError(
      'Relayr could not execute this action on any selected chain.',
      'RELAYR_FAILED',
      saved.bundleUuid,
      saved.records,
      false,
    )
  }

  try {
    const records = await relayrPoll(saved.bundleUuid, next => {
      saveRelayrPendingSession(pendingScope, { ...saved, records: next })
      reportProgress(next)
    })
    clearRelayrPendingSession(pendingScope)
    return {
      quote: {
        bundle_uuid: saved.bundleUuid,
        payment_info: [],
        transactions: records,
      },
      paymentHash: saved.paymentHash,
      records,
    }
  } catch (error) {
    const records =
      error instanceof RelayrExecutionError ? error.records : saved.records
    if (relayrSessionFullyFailed(records, saved.expectedCount)) {
      clearRelayrPendingSession(pendingScope)
    }
    throw error
  }
}

function requireSessionAccount(
  saved: RelayrPendingSession,
  account: Address,
): void {
  if (saved.account?.toLowerCase() !== account.toLowerCase()) {
    throw new Error(
      `Switch back to ${saved.account ?? 'the wallet that submitted this action'} to resume its pending Relayr bundle.`,
    )
  }
}

/**
 * Resume one persisted session by its storage scope — the account view's
 * in-flight cards re-enter the exact saved-bundle path runRelayrCalls uses,
 * without needing the original call set.
 */
export async function resumeRelayrSession({
  scope,
  account,
  onProgress,
}: {
  scope: string
  account: Address
  onProgress?: (progress: RelayrProgress) => void
}): Promise<{
  quote: RelayrQuote
  paymentHash: Hex | null
  records: RelayrTransactionRecord[]
}> {
  const saved = loadRelayrPendingSession(scope)
  if (!saved) {
    throw new Error('No pending Relayr bundle is saved for this action.')
  }
  requireSessionAccount(saved, account)
  return resumeSavedRelayrSession(scope, saved, onProgress)
}

/**
 * Complete EOA authority path: sign every chain, pay once, then wait until
 * every destination transaction has succeeded.
 */
export async function runRelayrCalls({
  calls,
  account,
  paymentChainId,
  pendingScope,
  onProgress,
}: {
  calls: RelayrCall[]
  account: Address
  paymentChainId?: number
  pendingScope?: string
  onProgress?: (progress: RelayrProgress) => void
}): Promise<{
  quote: RelayrQuote
  paymentHash: Hex | null
  records: RelayrTransactionRecord[]
}> {
  assertNoViewAs()
  if (!calls.length) throw new Error('Choose at least one chain.')

  const saved = pendingScope ? loadRelayrPendingSession(pendingScope) : null
  if (saved && pendingScope) {
    requireSessionAccount(saved, account)
    return resumeSavedRelayrSession(pendingScope, saved, onProgress)
  }

  const entries: RelayrEntry[] = []
  for (let index = 0; index < calls.length; index++) {
    onProgress?.({
      phase: 'signing',
      current: index + 1,
      total: calls.length,
      chainId: calls[index].chainId,
    })
    entries.push(await buildForwardedTx(calls[index], account))
  }
  onProgress?.({ phase: 'quoting' })
  const quote = await relayrPostBundle(entries)
  const payments = [...(quote.payment_info ?? [])].sort((a, b) =>
    BigInt(a.amount) < BigInt(b.amount) ? -1 : 1,
  )
  if (!payments.length) throw new Error('Relayr returned no payment option.')
  const activeChain = paymentChainId ?? getAccount(wagmiConfig).chainId
  const payment = payments.find(option => option.chain === activeChain) ?? payments[0]
  onProgress?.({ phase: 'paying', payment })
  let session: RelayrPendingSession | null = null
  const paymentHash = await relayrPay(payment, account, hash => {
    if (pendingScope) {
      session = saveRelayrPendingSession(pendingScope, {
        bundleUuid: quote.bundle_uuid,
        paymentHash: hash,
        paymentChainId: payment.chain,
        paymentStatus: 'submitted',
        chainIds: calls.map(call => call.chainId),
        expectedCount: calls.length,
        records: quote.transactions ?? [],
        itemCount: calls.length,
        account,
        createdAt: Date.now(),
      })
    }
    onProgress?.({
      phase: 'payment-submitted',
      payment,
      paymentHash: hash,
      bundleUuid: quote.bundle_uuid,
    })
  })
  if (pendingScope) {
    session = saveRelayrPendingSession(pendingScope, {
      bundleUuid: quote.bundle_uuid,
      paymentHash,
      paymentChainId: payment.chain,
      paymentStatus: 'confirmed',
      chainIds: calls.map(call => call.chainId),
      expectedCount: calls.length,
      records: quote.transactions ?? [],
      itemCount: calls.length,
      account,
      createdAt: Date.now(),
    })
  }
  onProgress?.({
    phase: 'payment-confirmed',
    payment,
    paymentHash,
    bundleUuid: quote.bundle_uuid,
  })

  try {
    const records = await relayrPoll(quote.bundle_uuid, next => {
      if (pendingScope && session) {
        saveRelayrPendingSession(pendingScope, { ...session, records: next })
      }
      const progress = relayrProgress(next, calls.length)
      onProgress?.({
        phase: 'executing',
        done: progress.confirmed,
        total: progress.total,
        records: next,
        bundleUuid: quote.bundle_uuid,
        paymentHash,
      })
    })
    if (pendingScope) clearRelayrPendingSession(pendingScope)
    return { quote, paymentHash, records }
  } catch (error) {
    const records =
      error instanceof RelayrExecutionError
        ? error.records
        : (quote.transactions ?? [])
    if (pendingScope && relayrSessionFullyFailed(records, calls.length)) {
      clearRelayrPendingSession(pendingScope)
    }
    throw error
  }
}
