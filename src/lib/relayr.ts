'use client'

import { getAccount } from '@wagmi/core'
import {
  JBCoreContracts,
  erc2771ForwarderAbi,
  jbContractAddress,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import {
  decodeFunctionResult,
  encodeFunctionData,
  isAddress,
  isAddressEqual,
  isHash,
  keccak256,
  stringToHex,
  type Abi,
  type Address,
  type Hex,
  type TransactionReceipt,
} from 'viem'
import { SUPPORTED_CHAINS, wagmiConfig } from '@/providers/Providers'
import { fundingChainLabel, requireFundingChainSelection, requireTransactionReview, type TransactionReviewCall } from '@/lib/transaction-review'
import { isDefiniteWalletRejection, simulateStateChangingTransaction } from '@bananapus/nana-sdk-core/review'
import { assertNoViewAs } from '@/lib/viewAs'
import { withForwarderAuthorizationLock } from '@/lib/forwarder-authorization'
import {
  FORWARD_REQUEST_TYPES,
  RELAYR_API,
  RELAYR_FORWARDER_DEADLINE_SECONDS,
  RELAYR_PAYMENT_GAS,
  RelayrPaymentRevertedError,
  RelayrProofError,
  TRUSTED_FORWARDER_ABI,
  bindRelayrQuote,
  relayrBundleRequest,
  relayrDestinationHash,
  relayrForwardRequest,
  relayrPaymentChains,
  relayrPaymentDetails as authenticateRelayrPayment,
  relayrPaymentOptions as authenticatedRelayrPaymentOptions,
  relayrProgress,
  relayrRecordChain,
  relayrStateIsSuccess,
  relayrSupportsChain,
  requireRelayrPaymentRetry,
  requireRelayrPaymentRuntime,
  simulateRelayrPayment,
  verifyRelayrDestinations,
  verifyRelayrPayment,
  type RelayrEntry,
  type RelayrPayment,
  type RelayrPaymentDetails,
  type RelayrQuote,
  type RelayrTransactionRecord,
} from '@bananapus/nana-sdk-core/review/relayr'
import {
  MAX_RELAYR_SENT_PAYMENTS,
  RELAYR_UUID_RE,
  relayrSentPaymentsSnapshot,
  sentRelayrPayment,
  type RelayrSentPayment,
} from '@/lib/relayr-payments'
import { isSafeConnection } from '@/lib/safe-connector'
import { formatDateTime } from '@/lib/format'
import {
  connectedWallet as connectedWalletCore,
  publicClient,
} from '@/lib/wallet-core'

const RELAYR_PENDING_PREFIX = 'jb-relayr-pending-v1:'
const RELAYR_QUOTE_TIMEOUT_MS = 45_000
const RELAYR_STATUS_REQUEST_TIMEOUT_MS = 15_000
/** Consecutive 404s that prove the uuid was never Relayr's, not a blip. */
const RELAYR_NOT_FOUND_ATTEMPTS = 3

const activeRelayrScopes = new Set<string>()

/** Serialize payment and recovery for one saved action across tabs as well as components. */
export async function withRelayrScopeLock<T>(scope: string, execute: () => Promise<T>): Promise<T> {
  if (activeRelayrScopes.has(scope)) throw new Error('This Relayr action is already being processed.')
  activeRelayrScopes.add(scope)
  try {
    if (typeof navigator !== 'undefined' && navigator.locks) {
      return await navigator.locks.request(`jb-relayr:${scope}`, { ifAvailable: true }, async lock => {
        if (!lock) throw new Error('This Relayr action is already being processed in another tab.')
        return execute()
      })
    }
    return await execute()
  } finally { activeRelayrScopes.delete(scope) }
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

/**
 * Why a saved session can only be discarded (ruling R114): every request it
 * published is dead at a canonical finalized block, and one may have run
 * (`ran`: a nonce moved, or the session saved none), or none ran and the
 * action's own recheck refuses it (`changed`).
 */
export type RelayrDiscardReason = 'ran' | 'changed'

const RELAYR_DISCARD_LINES: Record<RelayrDiscardReason, string> = {
  ran: 'This action\'s earlier signature may already have run. Check the project, then discard it to review it again.',
  changed: 'The project changed since this review.',
}

/** The one line a discardable session shows, and the error its action throws until it is discarded. */
export function relayrDiscardLine(reason: RelayrDiscardReason): string {
  return RELAYR_DISCARD_LINES[reason]
}

function relayrDiscardReason(value: unknown): value is RelayrDiscardReason {
  return value === 'ran' || value === 'changed'
}

/** A saved session none of whose requests can run again: only Discard ends it. */
export class RelayrDiscardError extends Error {
  readonly name = 'RelayrDiscardError'

  constructor(
    readonly scope: string,
    readonly reason: RelayrDiscardReason,
  ) {
    super(RELAYR_DISCARD_LINES[reason])
  }
}

/**
 * The line a session shows while one of its old requests can still run:
 * until `until` (seconds), or, once the clock is past it, until a finalized
 * block is.
 */
export function relayrHeldMessage(until: number, nowMs = Date.now()): string {
  return until * 1_000 > nowMs
    ? `This action's earlier signature can still run until ${formatDateTime(until)}. Try again after that.`
    : 'This action\'s earlier signature may still run. Try again in a few minutes.'
}

const RELAYR_UNCONFIRMED = 'Relayr has not confirmed that this quote is unpaid and that none of its calls ran. Keep it pending; try again later.'

export type RelayrPendingSession = {
  bundleUuid: string
  paymentHash: Hex | null
  paymentChainId: number | null
  /** `reverted`: the latest payment canonically reverted; only the SDK's retry rule lets the quote be paid again. */
  paymentStatus: 'unpaid' | 'sending' | 'submitted' | 'confirmed' | 'reverted'
  chainIds: number[]
  expectedCount: number
  records: RelayrTransactionRecord[]
  itemCount: number
  account: string | null
  createdAt: number
  /** Exact outer calls paid for by a SafeQueue Relayr bundle. */
  expectedEntries?: RelayrEntry[]
  /** Safe postconditions which must be proven before that bundle is cleared. */
  expectedSafeExecutions?: RelayrSafeExecutionProof[]
  /** Exact signed calls and quote-bound IDs, independent of status API claims. */
  expectedTransactions?: RelayrQuote['expectedTransactions']
  /** Preserve published signatures even when the quote response is lost or payment is canceled. */
  publishedEntries?: RelayrEntry[]
  /** The forwarder nonce each published request was signed with, in order, in decimal. */
  publishedNonces?: string[]
  /** Every payment sent for this bundle, as relayrPaymentDetails authenticated it, under the hash it was mined. */
  payments?: RelayrSentPayment[]
  /**
   * Every option of the quote that relayrPaymentDetails accepts before it
   * expires, several on one chain included, authenticated again whenever one
   * is used. Empty when the quote offered none.
   */
  paymentOptions?: RelayrPayment[]
  /** A reverted quote nothing can fund any more (ruling R104): its action quotes its calls again. */
  released?: true
  /**
   * Every request it published is dead at a canonical finalized block, and
   * why (ruling R114). Only discardRelayrSession ends it, and it reserves no
   * forwarder nonce. Its action classifies it again on every run.
   */
  discardable?: RelayrDiscardReason
}

/**
 * Whether a saved session waits on a payment, unpaid or after its payment
 * reverted, so that only its original action, which re-proves its calls, may
 * continue it.
 */
export function relayrSessionAwaitsPayment(session: Pick<RelayrPendingSession, 'paymentStatus'>): boolean {
  return session.paymentStatus === 'unpaid' || session.paymentStatus === 'reverted'
}

/**
 * An unpaid quote stops reserving its calls once nothing can fund it: none of
 * its saved payment options passes relayrPaymentDetails any more (the SDK
 * expires a quote 15 seconds before its deadline, and a quote may offer no
 * option it accepts at all), or every request it
 * published is past its deadline, which also releases a publication whose
 * quote response was lost. A quote whose payments reverted is released only
 * once revertedRelayrQuote proved it (ruling R104).
 */
export function relayrQuoteReleased(session: RelayrPendingSession, nowMs = Date.now()): boolean {
  if (session.paymentStatus === 'reverted') return session.released === true
  if (session.paymentStatus !== 'unpaid' || session.payments?.length) return false
  const nowSeconds = nowMs / 1_000
  const requests = (session.publishedEntries ?? []).map(entry => relayrForwardRequest(entry))
  if (requests.length && requests.every(request => request && request.deadline <= nowSeconds)) return true
  return !!session.paymentOptions && !relayrPaymentOptions(
    { bundle_uuid: session.bundleUuid, payment_info: session.paymentOptions }, session.chainIds, nowSeconds).length
}

export type RelayrSafeExecutionProof = {
  chainId: number
  safe: Address
  nonce: number
  safeTxHash: Hex
  txUuid: string
}

export type RelayrExecutionErrorCode =
  | 'RELAYR_FAILED'
  | 'RELAYR_TIMEOUT'
  | 'RELAYR_NOT_FOUND'

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

export class RelayrPaymentSendingError extends Error {
  readonly name = 'RelayrPaymentSendingError'
  constructor() {
    super('Your wallet may have sent the Relayr payment without returning its hash. Check the saved bundle and wallet activity; do not pay again.')
  }
}

const relayrPendingMemory = new Map<string, RelayrPendingSession>()
/** Prevent a failed localStorage removal from resurrecting a cleared bundle. */
const relayrClearedMemory = new Set<string>()
/** Scopes whose newest write exists only in memory after storage failed. */
const relayrMemoryAuthoritative = new Set<string>()
const MAX_RELAYR_SESSION_ENTRIES = 16
const MAX_RELAYR_SESSION_ENTRY_DATA_BYTES = 16_384
const MAX_UINT256 = (1n << 256n) - 1n

/**
 * True once a session's signed ForwardRequests can no longer be executed.
 *
 * `createdAt` is stored in MILLISECONDS (`Date.now()`), while the on-chain deadline is in
 * seconds — mixing the two would mark every session either permanently live or instantly
 * expired, so both arguments here are milliseconds.
 */
export function relayrSessionExpired(
  session: { createdAt: number },
  nowMs: number = Date.now(),
): boolean {
  return nowMs >= relayrSessionExpiresAt(session)
}

/**
 * When a session's signatures stop being executable, in milliseconds. Pending
 * sessions persist in localStorage indefinitely, so a bundle resumed days later
 * would fail at the forwarder; the resume UI says so instead.
 */
export function relayrSessionExpiresAt(session: { createdAt: number }): number {
  return session.createdAt + RELAYR_FORWARDER_DEADLINE_SECONDS * 1000
}

/** A timeout means Relayr may still execute a paid bundle. Do not submit it again blindly. */
export function relayrErrorIsUncertain(error: unknown): boolean {
  return (
    error instanceof RelayrPaymentSubmittedError ||
    error instanceof RelayrPaymentSendingError ||
    (error instanceof RelayrExecutionError && error.code !== 'RELAYR_FAILED')
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
  const request = record.request ? relayrEntrySnapshot(record.request) : null
  const chain = relayrRecordChain(record)
  return {
    ...(chain !== null ? { chain } : {}),
    ...(request
      ? {
          request: {
            ...request,
            ...(Number.isSafeInteger(record.request?.virtual_nonce) &&
            Number(record.request?.virtual_nonce) >= 0
              ? { virtual_nonce: Number(record.request?.virtual_nonce) }
              : {}),
          },
        }
      : {}),
    ...(typeof record.tx_uuid === 'string' && record.tx_uuid.length <= 128
      ? { tx_uuid: record.tx_uuid }
      : {}),
    status: {
      ...(typeof record.status?.state === 'string'
        ? { state: record.status.state }
        : {}),
      ...(hash ? { data: { hash } } : {}),
    },
  }
}

function relayrEntrySnapshot(entry: RelayrEntry): RelayrEntry | null {
  if (
    !entry ||
    typeof entry !== 'object' ||
    !Number.isSafeInteger(entry.chain) ||
    entry.chain < 1 ||
    !isAddress(entry.target) ||
    typeof entry.data !== 'string' ||
    !/^0x(?:[0-9a-fA-F]{2})*$/u.test(entry.data) ||
    (entry.data.length - 2) / 2 > MAX_RELAYR_SESSION_ENTRY_DATA_BYTES
  ) {
    return null
  }
  let value: bigint
  try {
    value = BigInt(entry.value)
  } catch {
    return null
  }
  if (value < 0n || value > MAX_UINT256) return null
  return {
    chain: entry.chain,
    target: entry.target,
    data: entry.data,
    value: value.toString(),
    ...(Number.isSafeInteger(entry.virtual_nonce) &&
    Number(entry.virtual_nonce) >= 0
      ? { virtual_nonce: Number(entry.virtual_nonce) }
      : {}),
  }
}

function relayrSafeExecutionSnapshot(
  proof: RelayrSafeExecutionProof,
): RelayrSafeExecutionProof | null {
  if (
    !proof ||
    typeof proof !== 'object' ||
    !Number.isSafeInteger(proof.chainId) ||
    proof.chainId < 1 ||
    !isAddress(proof.safe) ||
    !Number.isSafeInteger(proof.nonce) ||
    proof.nonce < 0 ||
    typeof proof.safeTxHash !== 'string' ||
    !/^0x[0-9a-fA-F]{64}$/u.test(proof.safeTxHash) ||
    typeof proof.txUuid !== 'string' ||
    !RELAYR_UUID_RE.test(proof.txUuid.toLowerCase())
  ) {
    return null
  }
  return {
    chainId: proof.chainId,
    safe: proof.safe,
    nonce: proof.nonce,
    safeTxHash: proof.safeTxHash,
    txUuid: proof.txUuid.toLowerCase(),
  }
}

function exactSnapshots<T>(
  values: readonly T[] | undefined,
  snapshot: (value: T) => T | null,
): T[] | undefined {
  if (
    !Array.isArray(values) ||
    values.length < 1 ||
    values.length > MAX_RELAYR_SESSION_ENTRIES
  ) {
    return undefined
  }
  const snapshots = values.map(snapshot)
  return snapshots.every((value): value is T => value !== null)
    ? snapshots
    : undefined
}

function relayrNonceSnapshot(nonce: string): string | null {
  return typeof nonce === 'string' && /^\d{1,78}$/u.test(nonce) ? nonce : null
}

function relayrPaymentOptionSnapshot(payment: RelayrPayment): RelayrPayment | null {
  if (!payment || typeof payment !== 'object' || !Number.isSafeInteger(payment.chain) ||
      typeof payment.amount !== 'string' || typeof payment.calldata !== 'string' || typeof payment.target !== 'string' ||
      (payment.token !== undefined && typeof payment.token !== 'string') ||
      (payment.payment_deadline !== undefined && typeof payment.payment_deadline !== 'number' &&
        typeof payment.payment_deadline !== 'string')) {
    return null
  }
  return {
    chain: payment.chain,
    amount: payment.amount,
    calldata: payment.calldata,
    target: payment.target,
    ...(payment.token !== undefined ? { token: payment.token } : {}),
    ...(payment.payment_deadline !== undefined ? { payment_deadline: payment.payment_deadline } : {}),
  }
}

function relayrBindingSnapshot(
  binding: NonNullable<RelayrQuote['expectedTransactions']>[number],
): NonNullable<RelayrQuote['expectedTransactions']>[number] | null {
  const entry = binding && relayrEntrySnapshot(binding.entry)
  if (!entry || binding.chain !== entry.chain ||
      typeof binding.txUuid !== 'string' || !RELAYR_UUID_RE.test(binding.txUuid.toLowerCase())) return null
  return { chain: entry.chain, txUuid: binding.txUuid.toLowerCase(), entry }
}

/** Persist only the receipt/status data needed to resume polling a paid bundle. */
export function saveRelayrPendingSession(
  scope: string,
  session: RelayrPendingSession,
): RelayrPendingSession {
  const expectedEntries = exactSnapshots(
    session.expectedEntries,
    relayrEntrySnapshot,
  )
  const expectedSafeExecutions = exactSnapshots(
    session.expectedSafeExecutions,
    relayrSafeExecutionSnapshot,
  )
  const expectedTransactions = exactSnapshots(session.expectedTransactions, relayrBindingSnapshot)
  const publishedEntries = exactSnapshots(session.publishedEntries, relayrEntrySnapshot)
  const publishedNonces = exactSnapshots(session.publishedNonces, relayrNonceSnapshot)
  // The retry rule and the release read these, so either is kept exactly or the save fails.
  const payments = session.payments?.length ? relayrSentPaymentsSnapshot(session.payments) : undefined
  if (payments === null) {
    throw new Error('The payments sent for this Relayr quote cannot be saved exactly. Keep it pending; do not pay again.')
  }
  const paymentOptions = session.paymentOptions === undefined ? undefined
    : Array.isArray(session.paymentOptions) && !session.paymentOptions.length ? []
      : exactSnapshots(session.paymentOptions, relayrPaymentOptionSnapshot) ?? null
  if (paymentOptions === null) {
    throw new Error('The payment options of this Relayr quote cannot be saved exactly. Keep it pending; do not pay again.')
  }
  const safeSession: RelayrPendingSession = {
    bundleUuid: session.bundleUuid,
    paymentHash: session.paymentHash,
    paymentChainId: session.paymentChainId,
    paymentStatus: session.paymentStatus,
    chainIds: session.chainIds.filter(
      chainId => Number.isSafeInteger(chainId) && chainId > 0,
    ),
    expectedCount: session.expectedCount,
    records: (Array.isArray(session.records) ? session.records : [])
      .filter(
        (record): record is RelayrTransactionRecord =>
          !!record && typeof record === 'object',
      )
      .map(relayrRecordSnapshot),
    itemCount: session.itemCount,
    account: session.account,
    createdAt: session.createdAt,
    ...(expectedEntries ? { expectedEntries } : {}),
    ...(expectedSafeExecutions ? { expectedSafeExecutions } : {}),
    ...(expectedTransactions ? { expectedTransactions } : {}),
    ...(publishedEntries ? { publishedEntries } : {}),
    ...(publishedNonces ? { publishedNonces } : {}),
    ...(payments ? { payments } : {}),
    ...(paymentOptions ? { paymentOptions } : {}),
    ...(session.released === true && session.paymentStatus === 'reverted' ? { released: true as const } : {}),
    ...(relayrDiscardReason(session.discardable) && relayrSessionAwaitsPayment(session) ? { discardable: session.discardable } : {}),
  }
  relayrClearedMemory.delete(scope)
  relayrPendingMemory.set(scope, safeSession)
  if (typeof window === 'undefined') {
    relayrMemoryAuthoritative.add(scope)
    return safeSession
  }
  try {
    window.localStorage.setItem(
      `${RELAYR_PENDING_PREFIX}${scope}`,
      JSON.stringify(safeSession),
    )
    relayrMemoryAuthoritative.delete(scope)
  } catch {
    // Storage may be unavailable; the in-memory session still drives the flow.
    relayrMemoryAuthoritative.add(scope)
  }
  return safeSession
}

/** Require a durable journal before publishing signatures or opening the payment wallet. */
export function saveRelayrPendingSessionDurably(scope: string, session: RelayrPendingSession): RelayrPendingSession {
  const previous = loadRelayrPendingSession(scope)
  const saved = saveRelayrPendingSession(scope, session)
  if (typeof window !== 'undefined') {
    try {
      if (window.localStorage.getItem(`${RELAYR_PENDING_PREFIX}${scope}`) !== JSON.stringify(saved)) throw new Error()
    } catch {
      // No external action has happened yet. Preserve the prior recoverable state
      // instead of stranding a fake payment attempt when storage is unavailable.
      if (previous) saveRelayrPendingSession(scope, previous)
      else clearRelayrPendingSession(scope)
      throw new Error('Enable browser storage before publishing relay authorizations or sending their payment.')
    }
  }
  return saved
}

function persistRelayrPublication(scope: string, session: RelayrPendingSession): RelayrPendingSession {
  const saved = saveRelayrPendingSessionDurably(scope, session)
  if (saved.publishedEntries?.length !== saved.expectedCount ||
      (session.publishedNonces && saved.publishedNonces?.length !== saved.expectedCount) ||
      (session.expectedTransactions && saved.expectedTransactions?.length !== saved.expectedCount)) {
    throw new Error('This Relayr action is too large to save its exact recovery information. No further transaction was sent.')
  }
  return saved
}

export function loadRelayrPendingSession(
  scope: string,
): RelayrPendingSession | null {
  if (relayrClearedMemory.has(scope)) return null
  const memory = relayrPendingMemory.get(scope)
  if (relayrMemoryAuthoritative.has(scope) && memory) return memory
  if (typeof window === 'undefined') return memory ?? null
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
      return relayrPendingMemory.get(scope) ?? null
    }
    const restored: RelayrPendingSession = {
      bundleUuid: value.bundleUuid,
      paymentHash:
        typeof value.paymentHash === 'string' && /^0x[0-9a-fA-F]+$/.test(value.paymentHash)
          ? (value.paymentHash as Hex)
          : null,
      paymentChainId:
        typeof value.paymentChainId === 'number' ? value.paymentChainId : null,
      paymentStatus:
        value.paymentStatus === 'unpaid' ? 'unpaid' : value.paymentStatus === 'sending' ? 'sending' :
          value.paymentStatus === 'submitted' ? 'submitted' : value.paymentStatus === 'reverted' ? 'reverted' : 'confirmed',
      chainIds: Array.isArray(value.chainIds)
        ? value.chainIds.filter(
            (chainId): chainId is number =>
              typeof chainId === 'number' &&
              Number.isSafeInteger(chainId) &&
              chainId > 0,
          )
        : value.records
            .map(relayrRecordChain)
            .filter((chainId): chainId is number => typeof chainId === 'number'),
      expectedCount: value.expectedCount,
      records: value.records,
      itemCount: value.itemCount,
      account: typeof value.account === 'string' ? value.account : null,
      createdAt: value.createdAt,
      expectedEntries: Array.isArray(value.expectedEntries)
        ? (value.expectedEntries as RelayrEntry[])
        : undefined,
      expectedSafeExecutions: Array.isArray(value.expectedSafeExecutions)
        ? (value.expectedSafeExecutions as RelayrSafeExecutionProof[])
        : undefined,
      expectedTransactions: Array.isArray(value.expectedTransactions)
        ? value.expectedTransactions
        : undefined,
      publishedEntries: Array.isArray(value.publishedEntries) ? value.publishedEntries : undefined,
      publishedNonces: Array.isArray(value.publishedNonces) ? value.publishedNonces : undefined,
      payments: Array.isArray(value.payments) ? value.payments : undefined,
      paymentOptions: Array.isArray(value.paymentOptions) ? value.paymentOptions : undefined,
      ...(value.released === true && value.paymentStatus === 'reverted' ? { released: true as const } : {}),
      ...(relayrDiscardReason(value.discardable) && (value.paymentStatus === 'unpaid' || value.paymentStatus === 'reverted')
        ? { discardable: value.discardable } : {}),
    }
    // Reading a tolerant UI view must not erase malformed durable evidence before
    // the authorization path can inspect the original record strictly.
    relayrPendingMemory.set(scope, restored)
    return restored
  } catch {
    return relayrPendingMemory.get(scope) ?? null
  }
}

/** Scopes of every persisted pending-bundle session on this device. */
export function listRelayrPendingScopes(): string[] {
  if (typeof window === 'undefined') return [...relayrPendingMemory.keys()]
  try {
    const scopes = new Set<string>(relayrPendingMemory.keys())
    for (let index = 0; index < window.localStorage.length; index++) {
      const key = window.localStorage.key(index)
      if (key?.startsWith(RELAYR_PENDING_PREFIX)) {
        scopes.add(key.slice(RELAYR_PENDING_PREFIX.length))
      }
    }
    return [...scopes].filter(scope => !relayrClearedMemory.has(scope))
  } catch {
    return [...relayrPendingMemory.keys()]
  }
}

/**
 * The saved sessions that reserve the wallet's forwarder nonce. Unlike UI
 * reads, this scan never reads unreadable storage as empty.
 */
export function readRelayrPendingSessionsForAuthorization(): { scope: string; session: RelayrPendingSession }[] {
  try {
    if (typeof window === 'undefined') throw new Error()
    const storage = window.localStorage
    const length = storage.length
    if (!Number.isSafeInteger(length) || length < 0) throw new Error()
    const scopes = new Set([...relayrPendingMemory.keys()].filter(scope => !relayrClearedMemory.has(scope)))
    for (let index = 0; index < length; index++) {
      const key = storage.key(index)
      if (typeof key !== 'string') throw new Error()
      if (key.startsWith(RELAYR_PENDING_PREFIX)) scopes.add(key.slice(RELAYR_PENDING_PREFIX.length))
    }
    return [...scopes].flatMap(scope => {
      const raw = storage.getItem(`${RELAYR_PENDING_PREFIX}${scope}`)
      const value = (raw === null ? relayrPendingMemory.get(scope) : JSON.parse(raw)) as RelayrPendingSession | undefined
      if (!value) { if (raw !== null) throw new Error(); return [] }
      if (typeof value !== 'object' || typeof value.bundleUuid !== 'string' || !value.bundleUuid ||
          !Number.isSafeInteger(value.expectedCount) || value.expectedCount < 1 ||
          !Number.isSafeInteger(value.itemCount) || value.itemCount < 1 || !Number.isFinite(value.createdAt) ||
          !Array.isArray(value.records) || !value.records.every(record => record && typeof record === 'object') ||
          !Array.isArray(value.chainIds) || !value.chainIds.length || !value.chainIds.every(chain => Number.isSafeInteger(chain) && chain > 0) ||
          (value.account !== null && !isAddress(value.account)) ||
          !['unpaid', 'sending', 'submitted', 'confirmed', 'reverted'].includes(value.paymentStatus) ||
          (value.paymentHash !== null && !/^0x[0-9a-fA-F]{64}$/u.test(value.paymentHash)) ||
          (value.paymentChainId !== null && (!Number.isSafeInteger(value.paymentChainId) || value.paymentChainId < 1)) ||
          (value.released !== undefined && (value.released !== true || value.paymentStatus !== 'reverted')) ||
          (value.discardable !== undefined && (!relayrDiscardReason(value.discardable) || !relayrSessionAwaitsPayment(value)))) throw new Error()
      for (const entries of [value.publishedEntries, value.expectedEntries]) {
        if (entries !== undefined && (!Array.isArray(entries) || entries.length !== value.expectedCount ||
            !entries.every(entry => relayrEntrySnapshot(entry) && value.chainIds.includes(entry.chain)))) throw new Error()
      }
      if (value.publishedNonces !== undefined && (!Array.isArray(value.publishedNonces) ||
          value.publishedNonces.length !== value.expectedCount || !value.publishedNonces.every(relayrNonceSnapshot))) throw new Error()
      if (value.expectedTransactions !== undefined && (!Array.isArray(value.expectedTransactions) ||
          value.expectedTransactions.length !== value.expectedCount || !value.expectedTransactions.every(binding => relayrBindingSnapshot(binding) && value.chainIds.includes(binding.chain)))) throw new Error()
      if (value.expectedSafeExecutions !== undefined && (!Array.isArray(value.expectedSafeExecutions) ||
          value.expectedSafeExecutions.length !== value.expectedCount || !value.expectedSafeExecutions.every(relayrSafeExecutionSnapshot))) throw new Error()
      if ((value.payments !== undefined && !relayrSentPaymentsSnapshot(value.payments)) ||
          (value.paymentOptions !== undefined && !(Array.isArray(value.paymentOptions) && !value.paymentOptions.length) &&
            !exactSnapshots(value.paymentOptions, relayrPaymentOptionSnapshot))) throw new Error()
      // A quote nothing can fund, or one whose requests are all dead, reserves no forwarder nonce.
      return relayrQuoteReleased(value) || value.discardable ? [] : [{ scope, session: value }]
    })
  } catch {
    throw new Error('Saved Relayr authorization records could not be read completely. Restore browser storage and recover the original actions before signing or paying for another.')
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

/**
 * Discard a session whose requests are all dead (see `discardable`), so its
 * action can be reviewed afresh. Only the session goes; what the action saved
 * stays. A fresh review signs at the live nonces, which no old request can
 * use. Every other session is refused.
 */
export async function discardRelayrSession(scope: string): Promise<void> {
  return withRelayrScopeLock(scope, async () => {
    const saved = loadRelayrPendingSession(scope)
    if (!saved?.discardable || !relayrSessionAwaitsPayment(saved)) {
      throw new Error('Only an action whose earlier signatures can no longer run can be discarded.')
    }
    clearRelayrPendingSession(scope)
  })
}

export function clearRelayrPendingSession(scope: string): void {
  relayrClearedMemory.add(scope)
  relayrMemoryAuthoritative.delete(scope)
  relayrPendingMemory.delete(scope)
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(`${RELAYR_PENDING_PREFIX}${scope}`)
    relayrClearedMemory.delete(scope)
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

function connectedWallet(chainId: JBChainId) {
  return connectedWalletCore(chainId, {
    requireUnchanged: true,
    changedError: 'Connected account changed. Review the cross-chain request again.',
  })
}

/** A relayed call must preserve the real sender through the canonical forwarder. */
export async function relayrTargetSupportsForwarder(call: RelayrCall): Promise<boolean> {
  if (!relayrSupportsChain(call.chainId)) return false
  const forwarder = jbContractAddress['6'][JBCoreContracts.ERC2771Forwarder][call.chainId]
  if (!forwarder) return false
  try {
    const data = await simulateStateChangingTransaction(publicClient(call.chainId), {
      from: forwarder,
      to: call.target,
      data: encodeFunctionData({ abi: TRUSTED_FORWARDER_ABI, functionName: 'isTrustedForwarder', args: [forwarder] }),
      gas: 100_000n,
    })
    return decodeFunctionResult({ abi: TRUSTED_FORWARDER_ABI, functionName: 'isTrustedForwarder', data })
  } catch { return false }
}

async function verifyForwardedEntries(entries: RelayrEntry[], account: Address): Promise<void> {
  for (const entry of entries) {
    const request = relayrForwardRequest(entry)
    if (!request) throw new Error('Invalid relay authorization.')
    const client = publicClient(entry.chain as JBChainId)
    if (!isAddressEqual(request.from, account) ||
        request.value !== BigInt(entry.value) ||
        request.deadline <= Math.floor(Date.now() / 1000) + 120 ||
        !await relayrTargetSupportsForwarder({ chainId: entry.chain as JBChainId, target: request.to, data: request.data }) ||
        !await client.readContract({ address: entry.target, abi: erc2771ForwarderAbi, functionName: 'verify', args: [request] })) {
      throw new Error('The relay authorization or trusted forwarder changed. Review the original action again.')
    }
    await simulateStateChangingTransaction(client, {
      from: account,
      to: entry.target,
      data: entry.data,
      value: request.value,
      gas: request.gas + request.gas / 63n + 100_000n,
    })
  }
}

/** Sign one EIP-2771 request for a Relayr destination transaction. */
export async function buildForwardedTx(...args: Parameters<typeof signForwardedRequest>): Promise<RelayrEntry> {
  return (await signForwardedRequest(...args)).entry
}

/** Sign one EIP-2771 request for a Relayr destination transaction, with the forwarder nonce it was signed with. */
async function signForwardedRequest(
  call: RelayrCall,
  expectedAccount: Address,
  expectedNonce?: bigint,
  context?: { description: string; calls: readonly TransactionReviewCall[] },
): Promise<{ entry: RelayrEntry; nonce: bigint }> {
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
  if (expectedNonce !== undefined && nonce !== expectedNonce) {
    throw new Error('The previous relay authorization may have executed. Check its original bundle before signing again.')
  }

  const value = call.value ?? 0n
  const request = {
    from: expectedAccount,
    to: call.target,
    value,
    gas: call.gas ?? 500_000n,
    nonce,
    deadline: Math.floor(Date.now() / 1000) + RELAYR_FORWARDER_DEADLINE_SECONDS,
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
    description: [
      context?.description,
      'Your signature authorizes Relayr to submit this exact destination call onchain. The Raw view includes the full ERC-2771 request. The separate Relayr payment is reviewed before it is sent.',
    ].filter(Boolean).join('\n\n'),
    confirmLabel: 'Agree & sign relay request',
    authorization: {
      type: 'EIP-712 ForwardRequest',
      domain: typedDomain,
      primaryType: 'ForwardRequest',
      message: request,
    },
    calls: [
      ...(context?.calls ?? []),
      {
        chainId: call.chainId,
        from: expectedAccount,
        to: call.target,
        value,
        gas: request.gas,
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
    entry: {
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
    },
    nonce,
  }
}

/**
 * Post the signed calls and bind Relayr's quote to them with the SDK: each call
 * takes the one quoted ID whose record carries its exact request, and the
 * bundle's records are exactly the quoted IDs. Throws, with nothing paid,
 * otherwise.
 */
export async function relayrPostBundle(
  transactions: RelayrEntry[],
): Promise<RelayrQuote> {
  const request = relayrBundleRequest(transactions)
  let response: Response
  try {
    response = await relayrFetch(
      `${RELAYR_API}/v1/bundle/prepaid`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
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
  return bindRelayrQuote(response, request)
}

/**
 * The SDK's authentication of one of a quote's payment options. It also
 * refuses a target or token whose mixed-case spelling fails its checksum,
 * which the SDK accepts.
 */
export function relayrPaymentDetails(
  payment: RelayrPayment,
  options: { bundleUuid: string; destinationChainIds: readonly number[]; nowSeconds?: number },
): RelayrPaymentDetails {
  if (typeof payment?.target === 'string' && !isAddress(payment.target)) {
    throw new Error('Relayr returned an unrecognized payment contract.')
  }
  if (typeof payment?.token === 'string' && !isAddress(payment.token)) {
    throw new Error('Relayr returned an unsupported payment token.')
  }
  return authenticateRelayrPayment(payment, options)
}

export function relayrPaymentLabel(payment: RelayrPayment): string {
  const chain = SUPPORTED_CHAINS.find(item => item.id === Number(payment.chain))
  return fundingChainLabel(chain?.name ?? `Chain ${payment.chain}`, BigInt(payment.amount))
}

/** The SDK's payment options for a quote, each of which passes relayrPaymentDetails. */
export function relayrPaymentOptions(
  quote: Pick<RelayrQuote, 'bundle_uuid' | 'payment_info'>,
  destinationChainIds: readonly number[],
  nowSeconds?: number,
): RelayrPayment[] {
  return authenticatedRelayrPaymentOptions(quote, destinationChainIds, nowSeconds)
    .filter(option => isAddress(option.target) && isAddress(option.token ?? ''))
}

/**
 * Clear a quote that was paid before for one more payment, with the SDK's
 * retry rule for each payment sent: every one of them canonically reverted,
 * the quote is still open, and Relayr reports the bundle unpaid with every
 * call pending.
 */
async function requireRelayrRetry(sent: readonly RelayrSentPayment[], account: Address, bundleUuid: string): Promise<void> {
  if (sent.some(payment => payment.bundleUuid !== bundleUuid)) {
    throw new Error('A saved Relayr payment belongs to another bundle. Do not pay again; check the original bundle.')
  }
  const byPayment = new Map<string, { payment: RelayrSentPayment; hashes: Hex[] }>()
  for (const payment of sent) {
    const key = `${payment.chainId}:${payment.calldata.toLowerCase()}:${payment.amount}`
    const group = byPayment.get(key) ?? { payment, hashes: [] }
    group.hashes.push(payment.hash)
    byPayment.set(key, group)
  }
  for (const { payment, hashes } of byPayment.values()) {
    await requireRelayrPaymentRetry(publicClient(payment.chainId as JBChainId), { hashes, from: account, payment })
  }
}

/**
 * The saved option a quote paid before is paid again with: exactly the one
 * its latest payment used, on its chain with its calldata and amount.
 */
export function relayrRetryOption(
  payments: readonly RelayrSentPayment[] | undefined,
  options: readonly RelayrPayment[] | undefined,
): RelayrPayment {
  const latest = payments?.at(-1)
  const sameAmount = (amount: unknown) => {
    try { return typeof amount === 'string' && !!latest && BigInt(amount) === BigInt(latest.amount) } catch { return false }
  }
  const option = latest && options?.find(item => item.chain === latest.chainId &&
    typeof item.calldata === 'string' && item.calldata.toLowerCase() === latest.calldata.toLowerCase() && sameAmount(item.amount))
  if (!option) throw new Error('This Relayr quote cannot be paid again from its saved record. Keep it pending; do not pay again.')
  return option
}

/**
 * Prove a saved session's latest payment when it resumes. Resolves true once
 * it succeeded and false while the proof is unavailable. A canonical revert
 * runs `onReverted` and is thrown, as is any other RelayrProofError: the
 * quote then waits on the SDK's retry rule.
 */
export async function proveSavedRelayrPayment(
  payments: readonly RelayrSentPayment[] | undefined,
  account: string | null | undefined,
  onReverted: () => void,
): Promise<boolean> {
  const latest = payments?.at(-1)
  if (!latest || !account || !isAddress(account)) return false
  try {
    await verifyRelayrPayment(publicClient(latest.chainId as JBChainId), { hash: latest.hash, from: account, payment: latest })
    return true
  } catch (error) {
    if (error instanceof RelayrPaymentRevertedError) onReverted()
    if (error instanceof RelayrProofError) throw error
    return false
  }
}

/**
 * Where a failed payment attempt leaves its quote: 'reverted' when the
 * payment reverted onchain, or when the wallet declined to pay a quote paid
 * before, which stays on the retry rule; 'unpaid' when the wallet declined
 * its first payment; null when nothing is known, and the journal stays as it
 * is. `sending` is whether the wallet held the payment.
 */
export function relayrPaymentAttemptOutcome(
  error: unknown,
  { sending, paid }: { sending: boolean; paid: boolean },
): 'reverted' | 'unpaid' | null {
  if (error instanceof RelayrPaymentRevertedError) return 'reverted'
  if (sending && isDefiniteWalletRejection(error)) return paid ? 'reverted' : 'unpaid'
  return null
}

/**
 * `read` at the chain's finalized block, with that block's timestamp, once
 * the block is still canonical after the read. Null while any of it cannot be
 * read. The one home for chain state at a canonical finalized block.
 */
async function atCanonicalFinalizedBlock<T>(
  chainId: number,
  read: (client: ReturnType<typeof publicClient>, blockNumber: bigint) => Promise<T>,
): Promise<{ value: T; timestamp: bigint } | null> {
  try {
    const client = publicClient(chainId as JBChainId)
    const block = await client.getBlock({ blockTag: 'finalized' })
    const value = await read(client, block.number)
    const canonical = await client.getBlock({ blockNumber: block.number })
    return canonical.hash === block.hash ? { value, timestamp: block.timestamp } : null
  } catch { return null }
}

/**
 * The nonce the forwarder expects next from `account` at the chain's finalized
 * block, still canonical, with that block's timestamp. Null while that cannot
 * be read.
 */
async function finalizedForwarderNonce(chainId: number, account: Address): Promise<{ nonce: bigint; timestamp: bigint } | null> {
  const forwarder = jbContractAddress['6'][JBCoreContracts.ERC2771Forwarder][chainId as JBChainId]
  if (!forwarder) return null
  const finalized = await atCanonicalFinalizedBlock(chainId, (client, blockNumber) => client.readContract({
    address: forwarder, abi: erc2771ForwarderAbi, functionName: 'nonces', args: [account], blockNumber }))
  return finalized && { nonce: finalized.value, timestamp: finalized.timestamp }
}

/**
 * A signed forward request as the forwarder sees it at a canonical finalized
 * block on its chain (ruling R114). It is dead once the forwarder's nonce for
 * its signer moved past the nonce it was signed with, when it may have run,
 * or once its deadline is strictly earlier than that block's timestamp, since
 * the forwarder runs a request only while its deadline is at least the
 * block's timestamp. `unused`: the nonce still equals the saved one. Anything
 * unknown is live: a failed read, no finalized block, a block no longer
 * canonical, and a request saved without its nonce until its deadline passes.
 */
export type RelayrRequestState =
  | { live: true; deadline: number }
  | { live: false; mayHaveRun: boolean; unused: boolean }

/**
 * The one classification of signed forward requests (ruling R114): each one
 * at one canonical finalized block on its chain, read once per chain.
 */
export async function relayrRequestStates(
  account: Address,
  requests: readonly { chainId: number; deadline: number | bigint; nonce?: string | bigint }[],
): Promise<RelayrRequestState[]> {
  const finalized = new Map<number, ReturnType<typeof finalizedForwarderNonce>>()
  return Promise.all(requests.map(async ({ chainId, deadline, nonce }): Promise<RelayrRequestState> => {
    if (!finalized.has(chainId)) finalized.set(chainId, finalizedForwarderNonce(chainId, account))
    const block = await finalized.get(chainId)
    try {
      const saved = nonce === undefined ? null : BigInt(nonce)
      if (block && saved !== null && block.nonce > saved) return { live: false, mayHaveRun: true, unused: false }
      if (block && BigInt(deadline) < block.timestamp) {
        return { live: false, mayHaveRun: saved === null, unused: block.nonce === saved }
      }
    } catch { /* An unreadable nonce or deadline is unknown. */ }
    return { live: true, deadline: Number(deadline) }
  }))
}

/**
 * What a set of requests allows together (ruling R114). While any one is
 * live the set holds until `until`, the deadline of its last live request,
 * and `spent` says whether another one is already dead. Once every one is
 * dead, `mayHaveRun` says whether a nonce moved or was never saved, and
 * `unused` whether every nonce still equals the saved one.
 */
export type RelayrRequestsVerdict =
  | { live: true; until: number; spent: boolean }
  | { live: false; mayHaveRun: boolean; unused: boolean }

export function relayrRequestsVerdict(states: readonly RelayrRequestState[]): RelayrRequestsVerdict {
  const deadlines = states.flatMap(state => state.live ? [state.deadline] : [])
  if (deadlines.length) return { live: true, until: Math.max(...deadlines), spent: deadlines.length < states.length }
  return {
    live: false,
    mayHaveRun: states.some(state => !state.live && state.mayHaveRun),
    unused: states.every(state => !state.live && state.unused),
  }
}

/**
 * Whether a signed forward request can no longer run and never ran: at a
 * canonical finalized block its deadline has passed and the forwarder still
 * expects its nonce. Wall-clock expiry alone proves neither. False while that
 * cannot be read.
 */
export async function relayrRequestExpiredUnused({ chainId, account, nonce, deadline }: {
  chainId: number
  account: Address
  nonce: string | bigint
  deadline: number | bigint
}): Promise<boolean> {
  const [state] = await relayrRequestStates(account, [{ chainId, nonce, deadline }])
  return !state.live && state.unused
}

/** Whether the chain's finalized block, still canonical, is past `deadline` (seconds). False while that is unknown. */
export async function relayrDeadlinePassed(chainId: number, deadline: string | bigint): Promise<boolean> {
  const finalized = await atCanonicalFinalizedBlock(chainId, async () => undefined)
  try {
    return !!finalized && finalized.timestamp > BigInt(deadline)
  } catch { return false }
}

/**
 * Review, simulate and send one payment for a quote from the account it was
 * reviewed for, then prove it from the chain with the SDK. The option is read
 * through relayrPaymentDetails before the review, after it and right before
 * sending, and must not change in between. A quote that was paid before is
 * paid again only when the SDK's retry rule clears every payment `sent` for
 * it, right before the wallet opens. Resolves with the hash the payment was
 * mined under and every payment sent for the quote.
 */
export async function relayrPay({
  payment,
  account: expectedAccount,
  bundleUuid,
  destinationChainIds,
  sent = [],
  reverify,
  reverifyBeforeSendOnly = false,
  onSending,
  onSent,
}: {
  /** One of the quote's payment options, as Relayr returned it. */
  payment: RelayrPayment
  /** The account the payment was reviewed for. */
  account: Address
  bundleUuid: string
  destinationChainIds: readonly number[]
  /** Every payment this session already sent for the quote, each under the hash it was mined. */
  sent?: readonly RelayrSentPayment[]
  /** Re-prove the bundle's calls before the review, after it and right before sending. */
  reverify?: () => Promise<void>
  /** Run `reverify` only right before sending, for callers that already checked when the quote was made. */
  reverifyBeforeSendOnly?: boolean
  /** Save the payment attempt before the wallet opens. */
  onSending?: (details: RelayrPaymentDetails) => void
  /** Save every payment sent for the quote, again when this one is mined under another hash. */
  onSent?: (payments: RelayrSentPayment[]) => void
}): Promise<{ hash: Hex; payments: RelayrSentPayment[] }> {
  assertNoViewAs()
  // A Safe pays through its own execution, which no proof can read as this payment.
  if (isSafeConnection(wagmiConfig)) {
    throw new Error('Pay for relayed transactions from an ordinary wallet. Nothing was sent.')
  }
  if (sent.length >= MAX_RELAYR_SENT_PAYMENTS) {
    throw new Error('This Relayr quote was paid too many times to pay again. Keep it pending; do not pay again.')
  }
  const reviewed = relayrPaymentDetails(payment, { bundleUuid, destinationChainIds })
  const readReviewed = () => {
    const current = relayrPaymentDetails(payment, { bundleUuid, destinationChainIds })
    if (current.chainId !== reviewed.chainId || current.amount !== reviewed.amount || current.calldata !== reviewed.calldata) {
      throw new Error('The Relayr payment changed. Review the original funding choice again.')
    }
    return current
  }
  if (!reverifyBeforeSendOnly) await reverify?.()
  const chainId = reviewed.chainId as JBChainId
  const client = publicClient(chainId)
  await requireRelayrPaymentRuntime(client)

  await requireTransactionReview({
    title: 'Review Relayr payment',
    description:
      'This payment funds the Relayr bundle. Review its exact chain, destination, native value, and calldata before opening your wallet.',
    confirmLabel: 'Agree & pay Relayr',
    calls: [
      {
        chainId,
        from: expectedAccount,
        to: reviewed.target,
        value: reviewed.amount,
        gas: RELAYR_PAYMENT_GAS,
        data: reviewed.calldata,
        label: 'Pay for relayed transactions',
        contractName: 'Relayr prepaid payment',
      },
    ],
  })

  readReviewed()
  if (!reverifyBeforeSendOnly) await reverify?.()
  const { wallet, account } = await connectedWallet(chainId)
  if (account.toLowerCase() !== expectedAccount.toLowerCase()) {
    throw new Error('Connected account changed. Review the Relayr payment again.')
  }
  await requireRelayrPaymentRuntime(client)
  await simulateRelayrPayment(client, { from: account, payment: reviewed })
  const live = getAccount(wagmiConfig).address
  if (!live || live.toLowerCase() !== expectedAccount.toLowerCase()) {
    throw new Error('Connected account changed. Review the Relayr payment again.')
  }
  // Review and wallet preparation are open-ended. Re-authenticate the exact
  // quote immediately before the fixed-gas write.
  const details = readReviewed()
  await reverify?.()
  if (sent.length) await requireRelayrRetry(sent, account, details.bundleUuid)
  onSending?.(details)
  let hash: Hex
  try {
    hash = await wallet.sendTransaction({
      account,
      to: details.target,
      value: details.amount,
      data: details.calldata,
      gas: RELAYR_PAYMENT_GAS,
    })
  } catch (error) {
    if (isDefiniteWalletRejection(error)) throw error
    throw new RelayrPaymentSendingError()
  }
  // Once the wallet returns a hash, a storage, receipt or proof failure is an
  // uncertain submitted outcome, never permission to quote and pay again.
  let payments = [...sent, sentRelayrPayment(details, hash)]
  try {
    onSent?.(payments)
  } catch {
    throw new RelayrPaymentSubmittedError(hash, chainId)
  }
  let receipt: TransactionReceipt
  try {
    receipt = await client.waitForTransactionReceipt({ hash })
  } catch {
    throw new RelayrPaymentSubmittedError(hash, chainId)
  }
  // A wallet that sped the payment up mined it under another hash; that
  // transaction is the payment to prove and to remember.
  const mined = receipt.transactionHash
  if (typeof mined !== 'string' || !isHash(mined)) throw new RelayrPaymentSubmittedError(hash, chainId)
  if (mined.toLowerCase() !== hash.toLowerCase()) {
    payments = [...sent, sentRelayrPayment(details, mined)]
    try {
      onSent?.(payments)
    } catch {
      throw new RelayrPaymentSubmittedError(mined, chainId)
    }
  }
  try {
    await verifyRelayrPayment(client, { hash: mined, from: account, payment: details })
  } catch (error) {
    // A proof error is final: the payment reverted, or the mined transaction is another one.
    if (error instanceof RelayrProofError) throw error
    throw new RelayrPaymentSubmittedError(mined, chainId)
  }
  return { hash: mined, payments }
}

type RelayrBundleRead = { paymentReceived: unknown; records: RelayrTransactionRecord[] }

/**
 * One read of Relayr's bundle, never from a cache: a cached answer could hide
 * a payment or a destination result. Resolves with what Relayr reports when
 * the answer names exactly this bundle, null when it does not, and
 * 'not-found' on a 404. Throws while Relayr is unreachable.
 */
async function readRelayrBundle(
  uuid: string,
  timeoutMs = RELAYR_STATUS_REQUEST_TIMEOUT_MS,
): Promise<RelayrBundleRead | 'not-found' | null> {
  const response = await relayrFetch(`${RELAYR_API}/v1/bundle/${uuid}`, { cache: 'no-store' }, timeoutMs)
  if (response.status === 404) return 'not-found'
  if (!response.ok) return null
  const { bundle_uuid: echoed, transactions, payment_received: paymentReceived } =
    ((await response.json()) ?? {}) as { bundle_uuid?: unknown; transactions?: unknown; payment_received?: unknown }
  return typeof echoed === 'string' && echoed.toLowerCase() === uuid.toLowerCase() && Array.isArray(transactions)
    ? { paymentReceived, records: transactions as RelayrTransactionRecord[] }
    : null
}

/** One read of the bundle, or null when Relayr cannot be read or does not name exactly this bundle. */
async function readRelayrBundleIfNamed(uuid: string): Promise<RelayrBundleRead | null> {
  try {
    const read = await readRelayrBundle(uuid)
    return read === 'not-found' ? null : read
  } catch {
    return null
  }
}

/** Relayr has not run the call: `pending` in any case, with no destination hash. */
function relayrRecordPending(record: RelayrTransactionRecord): boolean {
  const state = record?.status?.state
  return relayrDestinationHash(record) === null && typeof state === 'string' && state.trim().toLowerCase() === 'pending'
}

/** Relayr reports a payment for the bundle, or a call running or run. */
function relayrBundleFunded(read: RelayrBundleRead): boolean {
  return read.paymentReceived === true || read.records.some(record => !relayrRecordPending(record))
}

/** Relayr reports the bundle unpaid, with every call pending and no destination hash. */
function relayrBundleUnrun(read: RelayrBundleRead): boolean {
  return read.paymentReceived === false && read.records.length > 0 && read.records.every(relayrRecordPending)
}

/**
 * One uncached, echo-checked read of the bundle must report a released quote
 * unpaid with every call pending and no destination hash before its calls are
 * signed or quoted again.
 */
export async function requireRelayrBundleUnrun(bundleUuid: string): Promise<void> {
  const bundle = await readRelayrBundleIfNamed(bundleUuid)
  if (!bundle || !relayrBundleUnrun(bundle)) throw new Error(RELAYR_UNCONFIRMED)
}

/**
 * Ruling R114 for a saved session: the requests it published, each at a
 * canonical finalized block on its chain, with the nonces it saved. Null
 * when one of them is not a forwarder request it can read.
 */
async function savedRequestsVerdict(saved: RelayrPendingSession, account: Address): Promise<RelayrRequestsVerdict | null> {
  const published = saved.publishedEntries ?? []
  const nonces = saved.publishedNonces?.length === published.length ? saved.publishedNonces : undefined
  const requests = published.flatMap((entry, index) => {
    const request = relayrForwardRequest(entry)
    return request ? [{ chainId: entry.chain, deadline: request.deadline, nonce: nonces?.[index] }] : []
  })
  if (!published.length || requests.length !== published.length) return null
  return relayrRequestsVerdict(await relayrRequestStates(account, requests))
}

/** Mark a session for Discard (ruling R114), and the error its action throws until it is discarded. */
function discardableSession(scope: string, saved: RelayrPendingSession, reason: RelayrDiscardReason): RelayrDiscardError {
  saveRelayrPendingSession(scope, { ...saved, discardable: reason })
  return new RelayrDiscardError(scope, reason)
}

/**
 * Ruling R114 where the action and its recheck are not at hand, as in the
 * account view: a session whose requests are all dead, one of which may have
 * run, ends with Discard. One whose requests expired unused waits for its
 * action, which rechecks the project before signing again.
 */
async function endSpentSession(scope: string, saved: RelayrPendingSession): Promise<void> {
  if (!saved.account || !isAddress(saved.account)) return
  const verdict = await savedRequestsVerdict(saved, saved.account)
  if (verdict && !verdict.live && verdict.mayHaveRun) throw discardableSession(scope, saved, 'ran')
}

/**
 * Whether the quote a session paid can still be paid by the clock: its
 * latest payment's deadline is more than 15 seconds away, as the SDK's retry
 * rule requires.
 */
export function relayrPaidQuoteOpen(payments: readonly RelayrSentPayment[] | undefined, nowMs = Date.now()): boolean {
  const latest = payments?.at(-1)
  try {
    return !!latest && BigInt(latest.deadline) > BigInt(Math.floor(nowMs / 1_000)) + 15n
  } catch {
    return false
  }
}

/** Every option of a quote that relayrPaymentDetails accepts before it expires, several on one chain included. */
function relayrQuotedOptions(
  quote: Pick<RelayrQuote, 'bundle_uuid' | 'payment_info'>,
  destinationChainIds: readonly number[],
): { option: RelayrPayment; details: RelayrPaymentDetails }[] {
  return (Array.isArray(quote.payment_info) ? quote.payment_info : []).flatMap(option => {
    try {
      return [{ option, details: relayrPaymentDetails(option, { bundleUuid: quote.bundle_uuid, destinationChainIds, nowSeconds: 0 }) }]
    } catch {
      return []
    }
  })
}

/**
 * Nothing can fund the quote any more: every payment it sent is proven
 * canonically reverted, and the deadline of each of those payments, and of
 * each option relayrPaymentDetails accepts for the quote before it expires,
 * has passed at a canonical block on its chain.
 */
async function relayrQuoteUnfundable({ payments, options, bundleUuid, destinationChainIds, account }: {
  payments: readonly RelayrSentPayment[]
  options: readonly RelayrPayment[]
  bundleUuid: string
  destinationChainIds: readonly number[]
  account: string
}): Promise<boolean> {
  if (!payments.length || !isAddress(account)) return false
  for (const payment of payments) {
    try {
      await verifyRelayrPayment(publicClient(payment.chainId as JBChainId), { hash: payment.hash, from: account, payment })
      return false
    } catch (error) {
      if (!(error instanceof RelayrPaymentRevertedError)) return false
    }
  }
  const deadlines = new Map<string, { chainId: number; deadline: string }>(
    payments.map(payment => [`${payment.chainId}:${payment.deadline}`, payment]))
  // An option no flow here can authenticate is never paid from it.
  for (const { details } of relayrQuotedOptions({ bundle_uuid: bundleUuid, payment_info: [...options] }, destinationChainIds)) {
    deadlines.set(`${details.chainId}:${details.deadline}`, { chainId: details.chainId, deadline: details.deadline.toString() })
  }
  for (const { chainId, deadline } of deadlines.values()) {
    if (!await relayrDeadlinePassed(chainId, deadline)) return false
  }
  return true
}

/**
 * What a quote whose own payments reverted allows, from one read of its
 * bundle:
 * - 'funded' when Relayr reports a payment or a call running or run: another
 *   payment funded it, so its destinations are proven, never paid again;
 * - 'payable' while the quote is open, for the SDK's retry rule;
 * - 'released' (ruling R104) once nothing can fund it: every payment it sent
 *   is proven canonically reverted, its deadlines passed at a canonical
 *   block, and Relayr reports it unpaid with every call pending and no
 *   destination hash. Its action then quotes its calls again.
 * Throws while an expired quote's release is unproven. Resolves with the
 * records Relayr reported, or null when the bundle could not be read.
 */
export async function revertedRelayrQuote(quote: {
  bundleUuid: string
  payments: readonly RelayrSentPayment[]
  /** The quote's payment options. */
  options: readonly RelayrPayment[]
  destinationChainIds: readonly number[]
  account: string
}): Promise<{ state: 'funded' | 'payable' | 'released'; records: RelayrTransactionRecord[] | null }> {
  const bundle = await readRelayrBundleIfNamed(quote.bundleUuid)
  const records = bundle?.records ?? null
  if (bundle && relayrBundleFunded(bundle)) return { state: 'funded', records }
  if (relayrPaidQuoteOpen(quote.payments)) return { state: 'payable', records }
  if (bundle && relayrBundleUnrun(bundle) && await relayrQuoteUnfundable(quote)) return { state: 'released', records }
  throw new Error('This Relayr quote expired after its payment reverted. A new quote needs its deadline final onchain and Relayr to report nothing ran; try again in a few minutes.')
}

export async function relayrPoll(
  uuid: string,
  expectedCount: number,
  onUpdate?: (records: RelayrTransactionRecord[]) => void,
  intervalMs = 2_500,
  timeoutMs = 5 * 60_000,
): Promise<RelayrTransactionRecord[]> {
  if (!Number.isSafeInteger(expectedCount) || expectedCount < 1) {
    throw new Error('Relayr polling requires the exact destination count.')
  }
  const started = Date.now()
  let lastRecords: RelayrTransactionRecord[] = []
  // A bundle Relayr never had 404s forever. Reporting that as the "still
  // processing, do not submit again" timeout tells the user to wait on
  // something that does not exist.
  let consecutiveNotFound = 0
  for (;;) {
    try {
      const elapsed = Date.now() - started
      const read = await readRelayrBundle(uuid, Math.min(RELAYR_STATUS_REQUEST_TIMEOUT_MS, Math.max(timeoutMs - elapsed, 1)))
      if (read === 'not-found') {
        consecutiveNotFound += 1
        if (consecutiveNotFound >= RELAYR_NOT_FOUND_ATTEMPTS) {
          throw new RelayrExecutionError(
            `Relayr cannot find bundle ${uuid}. Its payment and destination outcomes remain unresolved. Check the original bundle; do not pay again.`,
            'RELAYR_NOT_FOUND',
            uuid,
            lastRecords,
            false,
          )
        }
      } else {
        consecutiveNotFound = 0
      }
      const records = read && read !== 'not-found' ? read.records : null
      if (records) {
        lastRecords = records
        onUpdate?.(records)
        if (
          records.length === expectedCount &&
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

function relayrSessionFinished(
  records: RelayrTransactionRecord[],
  expectedCount: number,
): boolean {
  return (
    records.length === expectedCount &&
    records.every(record => relayrStateIsSuccess(record.status?.state))
  )
}

/**
 * Prove the exact signed outer transaction on every destination with the SDK,
 * independent of API labels. A forwarded bundle carries one call per chain,
 * so a saved session with two bindings on one chain is not this app's.
 */
async function verifySavedRelayrDestinations(
  saved: RelayrPendingSession,
  records: RelayrTransactionRecord[],
): Promise<void> {
  const bindings = saved.expectedTransactions
  if (!bindings || bindings.length !== saved.expectedCount ||
      new Set(bindings.map(binding => binding.chain)).size !== saved.expectedCount ||
      !saved.account || !isAddress(saved.account)) {
    throw new Error('This saved Relayr bundle lacks exact destination proof. Keep it pending and verify the original transactions; do not pay again.')
  }
  await verifyRelayrDestinations(chainId => publicClient(chainId as JBChainId), {
    bindings, records, account: saved.account,
  })
}

/**
 * Resume a persisted payment attempt using only its original quote and exact
 * receipts. `reverted` is a read of a reverted session's bundle already made.
 */
async function resumeSavedRelayrSession(
  pendingScope: string,
  saved: RelayrPendingSession,
  onProgress?: (progress: RelayrProgress) => void,
  onComplete?: (records: RelayrTransactionRecord[]) => Promise<void>,
  reverted?: Awaited<ReturnType<typeof revertedRelayrQuote>>,
): Promise<{
  quote: RelayrQuote
  paymentHash: Hex | null
  records: RelayrTransactionRecord[]
}> {
  if (pendingScope.startsWith('safe-queue:') || saved.expectedEntries || saved.expectedSafeExecutions) {
    throw new Error(
      'Resume this paid Safe bundle from the project Owner/Operator queue so its exact onchain executions can be verified.',
    )
  }
  const reportProgress = (records: RelayrTransactionRecord[]) => {
    const progress = relayrProgress(records, saved.expectedCount)
    onProgress?.({ phase: 'executing', done: progress.confirmed, total: progress.total,
      records, bundleUuid: saved.bundleUuid, paymentHash: saved.paymentHash })
  }
  reportProgress(saved.records)
  if (saved.paymentStatus === 'unpaid') {
    await endSpentSession(pendingScope, saved)
    throw new Error('The original signatures are saved and no payment was attempted. Reopen the original action to continue with those exact authorizations.')
  }
  const expectedTransactions = saved.expectedTransactions
  if (!expectedTransactions) {
    throw new Error('This saved Relayr bundle lacks exact destination proof. Keep it pending and verify the original transactions; do not pay again.')
  }
  if (saved.paymentStatus === 'submitted') {
    const submitted = saved
    // A success confirms the payment; a canonical revert leaves the quote to
    // the retry rule; while the proof is unavailable it stays submitted.
    if (await proveSavedRelayrPayment(submitted.payments, submitted.account,
      () => saveRelayrPendingSession(pendingScope, { ...submitted, paymentStatus: 'reverted' }))) {
      saved = saveRelayrPendingSession(pendingScope, { ...submitted, paymentStatus: 'confirmed' })
    }
  }
  let records = saved.records
  let verified = false
  if (relayrSessionFinished(records, saved.expectedCount)) {
    try { await verifySavedRelayrDestinations(saved, records); verified = true } catch { /* Refresh stale provider records. */ }
  }
  if (!verified && saved.paymentStatus === 'reverted') {
    // A quote whose payment reverted ran only if another payment funded it,
    // which one read of its bundle shows. Its original action pays it again.
    const read = reverted ?? await revertedRelayrQuote({ bundleUuid: saved.bundleUuid, payments: saved.payments ?? [],
      options: saved.paymentOptions ?? [], destinationChainIds: saved.chainIds, account: saved.account ?? '' })
    if (read.records) {
      records = read.records
      const current = saveRelayrPendingSession(pendingScope, { ...saved, records, ...(read.state === 'released' ? { released: true } : {}) })
      reportProgress(records)
      // Relayr reports nothing funded it; its own requests may still have run outside Relayr.
      if (read.state !== 'funded') await endSpentSession(pendingScope, current)
    }
    if (read.state === 'released') {
      throw new Error('This Relayr quote expired after its payment reverted, and nothing ran. Review the action again for a new quote.')
    }
    if (read.state === 'payable') {
      throw new Error('This Relayr payment reverted onchain. Reopen the original action to pay the same quote again.')
    }
    try {
      await verifySavedRelayrDestinations(saved, records)
    } catch (error) {
      if (error instanceof RelayrProofError) throw error
      throw new Error('Another payment funded this Relayr quote. Check again once its calls have run; do not pay again.')
    }
    verified = true
  }
  if (!verified) {
    try {
      records = await relayrPoll(saved.bundleUuid, saved.expectedCount, next => {
        records = next
        saveRelayrPendingSession(pendingScope, { ...saved, records: next })
        reportProgress(next)
      }, 2_500, 15_000)
    } catch (error) {
      if (error instanceof RelayrExecutionError && error.records.length) records = error.records
      // A provider failure or missing bundle never proves that signed calls cannot execute.
      // Receipts can nevertheless prove completion even if the provider's label is wrong.
    }
    await verifySavedRelayrDestinations(saved, records)
  }
  await onComplete?.(records)
  clearRelayrPendingSession(pendingScope)
  return { quote: { bundle_uuid: saved.bundleUuid, payment_info: [], transactions: records,
    expectedTransactions }, paymentHash: saved.paymentHash, records }
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
  onComplete,
}: {
  scope: string
  account: Address
  onProgress?: (progress: RelayrProgress) => void
  onComplete?: (records: RelayrTransactionRecord[]) => Promise<void>
}): Promise<{
  quote: RelayrQuote
  paymentHash: Hex | null
  records: RelayrTransactionRecord[]
}> {
  if (scope.startsWith('project-batch:') && !onComplete) {
    throw new Error('Resume this bundle from its original project action so completed calls are recorded before its payment journal is cleared.')
  }
  return withRelayrScopeLock(scope, async () => {
    const saved = loadRelayrPendingSession(scope)
    if (!saved) throw new Error('No pending Relayr bundle is saved for this action.')
    requireSessionAccount(saved, account)
    return resumeSavedRelayrSession(scope, saved, onProgress, onComplete)
  })
}

/**
 * Complete EOA authority path: sign every chain, pay once, then wait until
 * every destination transaction has succeeded.
 */
export async function runRelayrCalls(options: Parameters<typeof executeRelayrCalls>[0]) {
  const pendingScope = options.pendingScope ?? relayrCallsScope(options.calls)
  return withRelayrScopeLock(pendingScope, () => withForwarderAuthorizationLock({
    account: options.account, chainIds: options.calls.map(call => call.chainId), owner: `relayr:${pendingScope}`,
    pendingSessions: readRelayrPendingSessionsForAuthorization,
    execute: assertAvailable => executeRelayrCalls({ ...options, pendingScope }, assertAvailable),
  }))
}

async function executeRelayrCalls({
  calls,
  account,
  paymentChainId,
  preferredPaymentChainId = getAccount(wagmiConfig).chainId,
  pendingScope,
  onProgress,
  reverify,
  onComplete,
}: {
  calls: RelayrCall[]
  account: Address
  paymentChainId?: number
  /** Preselected in the funding choice when quoted. Pass the wallet's chain from before the flow switched chains. */
  preferredPaymentChainId?: number
  pendingScope?: string
  onProgress?: (progress: RelayrProgress) => void
  /** Re-prove every mutable project call around signatures and payment. */
  reverify?: () => Promise<void>
  /** Commit application completion before removing the original payment journal. */
  onComplete?: (records: RelayrTransactionRecord[]) => Promise<void>
}, assertAuthorizationAvailable: () => void): Promise<{
  quote: RelayrQuote
  paymentHash: Hex | null
  records: RelayrTransactionRecord[]
}> {
  assertNoViewAs()
  if (!calls.length) throw new Error('Choose at least one chain.')

  let saved = pendingScope ? loadRelayrPendingSession(pendingScope) : null
  /** Relayr cannot be read while another payment could still fund the reverted quote: that counts as live (ruling R114). */
  let fundable = false
  if (saved && pendingScope) {
    requireSessionAccount(saved, account)
    if (!relayrSessionAwaitsPayment(saved)) return resumeSavedRelayrSession(pendingScope, saved, onProgress, onComplete)
    if (saved.paymentStatus === 'reverted' && !saved.released) {
      // Another payment may have funded the quote: what Relayr ran is proven, never paid again.
      const reverted = await revertedRelayrQuote({ bundleUuid: saved.bundleUuid, payments: saved.payments ?? [],
        options: saved.paymentOptions ?? [], destinationChainIds: saved.chainIds, account })
      if (reverted.state === 'funded') return resumeSavedRelayrSession(pendingScope, saved, onProgress, onComplete, reverted)
      if (reverted.state === 'released') saved = saveRelayrPendingSession(pendingScope, { ...saved, released: true })
      fundable = reverted.state === 'payable' && !reverted.records
    }
  }

  if (isSafeConnection(wagmiConfig) || calls.some(call => !relayrSupportsChain(call.chainId))) {
    throw new Error('Relayed authority actions require an ordinary wallet and supported destinations.')
  }
  if (new Set(calls.map(call => call.chainId)).size !== calls.length) {
    throw new Error('Relayr can authorize one independent call per destination chain. Complete dependent calls in sequence.')
  }
  const destinations = calls.map(call => call.chainId)
  const fundingChains = relayrPaymentChains(destinations)
  if (!fundingChains.length) {
    throw new Error('Choose supported destinations from one network family: mainnets or testnets.')
  }
  if (paymentChainId !== undefined && !fundingChains.includes(paymentChainId)) {
    throw new Error('Choose a supported Relayr funding chain in the same network family as these destinations.')
  }
  assertAuthorizationAvailable()
  const entries: RelayrEntry[] = []
  /** The forwarder nonce each request in `entries` was signed with, when known. */
  let nonces: string[] | undefined = []
  /** The requests a session published and signs again with their own nonce and gas (ruling R104). */
  let resigning: { nonce: string; gas: bigint }[] | undefined
  if (saved && pendingScope) {
    const published = saved.publishedEntries ?? []
    if (published.length !== calls.length) throw new Error('The saved relay publication is incomplete. Keep the original action pending.')
    const requests: NonNullable<ReturnType<typeof relayrForwardRequest>>[] = []
    for (let index = 0; index < calls.length; index++) {
      const request = relayrForwardRequest(published[index])
      if (!request || published[index].chain !== calls[index].chainId ||
          !isAddressEqual(request.from, account) || !isAddressEqual(request.to, calls[index].target) ||
          request.data !== calls[index].data || request.value !== (calls[index].value ?? 0n)) {
        throw new Error('The original published Relayr calls changed. Keep the original action pending.')
      }
      requests.push(request)
    }
    // Ruling R114: the requests it published are classified, each at a
    // canonical finalized block on its chain, before the action's own recheck,
    // which a request that ran would make refuse.
    const verdict = await savedRequestsVerdict(saved, account)
    if (!verdict) throw new Error('The original published Relayr calls changed. Keep the original action pending.')
    if (verdict.live || fundable) {
      // An old request can still run, or Relayr cannot say another payment did
      // not fund the quote: no new signature and no Discard. Its own requests
      // may be quoted or paid again while every one still verifies, since
      // their nonces let at most one bundle run.
      if (!verdict.live) throw new Error(RELAYR_UNCONFIRMED)
      if (verdict.spent) throw new Error(relayrHeldMessage(verdict.until))
      try {
        await reverify?.()
        await verifyForwardedEntries(published, account)
      } catch (error) {
        throw new Error(relayrHeldMessage(verdict.until), { cause: error })
      }
      entries.push(...published)
      nonces = saved.publishedNonces
    } else if (verdict.mayHaveRun) {
      // A nonce moved, so another action used it or anyone holding the signed
      // request ran it outside Relayr, and the app cannot tell which.
      throw discardableSession(pendingScope, saved, 'ran')
    } else {
      // Every request expired unused, so none ran and none can.
      try {
        await reverify?.()
      } catch {
        throw discardableSession(pendingScope, saved, 'changed')
      }
      // Ruling R104: signed again with the nonces they were signed with, after
      // one uncached read reports the old bundle unpaid with every call
      // pending. A publication whose quote never arrived has no bundle to read.
      const savedNonces = saved.publishedNonces
      if (!verdict.unused || !savedNonces) throw new Error(relayrHeldMessage(0))
      if (RELAYR_UUID_RE.test(saved.bundleUuid)) await requireRelayrBundleUnrun(saved.bundleUuid)
      resigning = savedNonces.map((nonce, index) => ({ nonce, gas: requests[index].gas }))
    }
  }
  if (entries.length < calls.length) {
    for (const call of calls) {
      if (!await relayrTargetSupportsForwarder(call)) {
        throw new Error(`The target on chain ${call.chainId} does not trust the canonical forwarder. Send this action directly.`)
      }
    }
  }
  // The ForwardRequest deadlines start at SIGNING, not at payment — stamping
  // the session when the payment lands would report a bundle as still valid
  // for however long the wallet sat on the signatures, and a "not yet expired"
  // resume would then die at the forwarder. Taken before the first signature,
  // so it can only understate the remaining validity.
  const signedAt = saved && entries.length ? saved.createdAt : Date.now()
  for (let index = entries.length; index < calls.length; index++) {
    assertAuthorizationAvailable()
    onProgress?.({
      phase: 'signing',
      current: index + 1,
      total: calls.length,
      chainId: calls[index].chainId,
    })
    await reverify?.()
    const again = resigning?.[index]
    const signed = again
      ? await signForwardedRequest({ ...calls[index], gas: again.gas }, account, BigInt(again.nonce))
      : await signForwardedRequest(calls[index], account)
    entries.push(signed.entry)
    nonces?.push(signed.nonce.toString())
    await reverify?.()
  }
  const repaying = saved?.paymentStatus === 'reverted' && !saved.released ? saved : null
  let session: RelayrPendingSession
  let quote: RelayrQuote
  let payment: RelayrPayment
  if (repaying) {
    // A quote that was paid before is never replaced: it is paid again, with
    // exactly the option it used, and only when the SDK's retry rule clears it.
    payment = relayrRetryOption(repaying.payments, repaying.paymentOptions)
    if (!repaying.paymentOptions || !repaying.expectedTransactions) {
      throw new Error('This Relayr quote cannot be paid again from its saved record. Keep it pending; do not pay again.')
    }
    session = repaying
    quote = { bundle_uuid: repaying.bundleUuid, payment_info: repaying.paymentOptions,
      transactions: repaying.records, expectedTransactions: repaying.expectedTransactions }
  } else {
    session = {
      bundleUuid: 'publication-pending', paymentHash: null, paymentChainId: null, paymentStatus: 'unpaid',
      chainIds: calls.map(call => call.chainId), expectedCount: calls.length, records: [], itemCount: calls.length,
      account, createdAt: signedAt, publishedEntries: entries,
      ...(nonces?.length === entries.length ? { publishedNonces: nonces } : {}),
    }
    // Posting exposes executable signatures, even when the server's response never arrives.
    assertAuthorizationAvailable()
    if (pendingScope) session = persistRelayrPublication(pendingScope, session)
    onProgress?.({ phase: 'quoting' })
    quote = await relayrPostBundle(entries)
    const options = relayrPaymentOptions(quote, destinations)
    session = { ...session, bundleUuid: quote.bundle_uuid, expectedTransactions: quote.expectedTransactions,
      paymentOptions: relayrQuotedOptions(quote, destinations).map(({ option }) => option) }
    if (pendingScope) session = persistRelayrPublication(pendingScope, session)
    if (!options.length) throw new Error('Relayr returned no supported payment option in the destinations’ network family.')
    const selectedChain = paymentChainId ?? await requireFundingChainSelection(
      options.map(option => ({ chainId: option.chain, label: relayrPaymentLabel(option) })),
      preferredPaymentChainId,
    )
    const selected = options.find(option => option.chain === selectedChain)
    if (!selected) throw new Error('Relayr returned no payment option on your selected funding chain. Nothing was paid.')
    payment = selected
  }
  onProgress?.({ phase: 'paying', payment })
  session = {
    ...session,
    bundleUuid: quote.bundle_uuid,
    // While the wallet holds a payment it has no hash yet; `payments` keeps every earlier one.
    paymentHash: null,
    paymentChainId: payment.chain,
    paymentStatus: 'sending',
    chainIds: calls.map(call => call.chainId),
    expectedCount: calls.length,
    records: [],
    itemCount: calls.length,
    account,
    createdAt: signedAt,
    expectedTransactions: quote.expectedTransactions,
  }
  const verifyBeforePayment = async () => {
    assertAuthorizationAvailable()
    await reverify?.()
    await verifyForwardedEntries(entries, account)
  }
  let paymentHash: Hex
  /** The wallet holds the payment and has returned no hash for it. */
  let sending = false
  try {
    ;({ hash: paymentHash } = await relayrPay({
      payment, account, bundleUuid: quote.bundle_uuid, destinationChainIds: destinations,
      sent: session.payments ?? [],
      reverify: verifyBeforePayment,
      onSending: () => {
        const current = pendingScope ? loadRelayrPendingSession(pendingScope) : null
        if (current && (!relayrSessionAwaitsPayment(current) || current.bundleUuid !== quote.bundle_uuid)) {
          throw new Error('Another payment attempt is saved for this action. Check the original bundle before continuing.')
        }
        if (pendingScope) session = persistRelayrPublication(pendingScope, session)
        sending = true
      },
      onSent: payments => {
        sending = false
        const hash = payments[payments.length - 1].hash
        session = { ...session, payments, paymentHash: hash, paymentStatus: 'submitted' }
        if (pendingScope) session = saveRelayrPendingSession(pendingScope, session)
        onProgress?.({ phase: 'payment-submitted', payment, paymentHash: hash, bundleUuid: quote.bundle_uuid })
      },
    }))
  } catch (error) {
    const outcome = relayrPaymentAttemptOutcome(error, { sending, paid: !!session.payments?.length })
    if (pendingScope && outcome) {
      saveRelayrPendingSession(pendingScope, { ...session, paymentStatus: outcome,
        paymentHash: outcome === 'reverted' ? session.payments?.at(-1)?.hash ?? null : null })
    }
    throw error
  }
  session = { ...session, paymentHash, paymentStatus: 'confirmed' }
  if (pendingScope) session = saveRelayrPendingSession(pendingScope, session)
  onProgress?.({ phase: 'payment-confirmed', payment, paymentHash, bundleUuid: quote.bundle_uuid })
  let records: RelayrTransactionRecord[] = []
  try {
    records = await relayrPoll(quote.bundle_uuid, calls.length, next => {
      records = next
      session = { ...session, records: next }
      if (pendingScope) session = saveRelayrPendingSession(pendingScope, session)
      const progress = relayrProgress(next, calls.length)
      onProgress?.({ phase: 'executing', done: progress.confirmed, total: progress.total,
        records: next, bundleUuid: quote.bundle_uuid, paymentHash })
    }, 2_500, 5 * 60_000)
  } catch (error) {
    if (error instanceof RelayrExecutionError && error.records.length) records = error.records
  }
  await verifySavedRelayrDestinations(session, records)
  await onComplete?.(records)
  if (pendingScope) clearRelayrPendingSession(pendingScope)
  return { quote, paymentHash, records }
}
