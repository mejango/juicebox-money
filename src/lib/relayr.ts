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
  isAddressEqual,
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
/** Consecutive 404s that prove the uuid was never Relayr's, not a blip. */
const RELAYR_NOT_FOUND_ATTEMPTS = 3

/**
 * Relayr's immutable prepaid-native payment endpoint. A quote is untrusted
 * HTTP input, so accepting an arbitrary target and calldata here would turn
 * the quote service into a wallet transaction oracle.
 */
export const RELAYR_PAYMENT_ADDRESS =
  '0x1c05f7841379d4393574c0ffa17908ec40ffd97d' as Address
export const RELAYR_PAYMENT_SELECTOR = '0x103903a7'
export const RELAYR_PAYMENT_CODE_HASH =
  '0x6006b5acadb4cd60aa5c00cb844c34563e182dff83d4f4ff4fde226f7df16fa6' as Hex
export const RELAYR_NATIVE_TOKEN =
  '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' as Address
const RELAYR_PAYMENT_CHAINS = new Set<number>([1, 10, 8453, 42161])
const RELAYR_PAYMENT_GAS = 150_000n
const RELAYR_PAYMENT_CODE_MAX_BYTES = 2_048
const RELAYR_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

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
  payment_deadline?: number | string
}

export type RelayrPaymentDetails = {
  chainId: JBChainId
  target: Address
  amount: bigint
  calldata: Hex
  bundleUuid: string
  deadline: bigint
}

type RelayrTransactionStatus = {
  state?: string
  data?: {
    hash?: Hex
    transaction?: { hash?: Hex }
  }
}

export type RelayrTransactionRecord = {
  chain?: number
  tx_uuid?: string
  request?: RelayrEntry
  status?: RelayrTransactionStatus
}

export type RelayrQuote = {
  bundle_uuid: string
  payment_info: RelayrPayment[]
  transactions?: RelayrTransactionRecord[]
  /** Client-authenticated quote ordering; never accepted from status alone. */
  expectedTransactions?: {
    txUuid: string
    chain: number
    entry: RelayrEntry
  }[]
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
  /** Exact outer calls paid for by a SafeQueue Relayr bundle. */
  expectedEntries?: RelayrEntry[]
  /** Safe postconditions which must be proven before that bundle is cleared. */
  expectedSafeExecutions?: RelayrSafeExecutionProof[]
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

/**
 * How long a signed ERC-2771 ForwardRequest stays valid. The forwarder rejects the request
 * after this, and pending sessions persist in localStorage indefinitely — so a bundle resumed
 * days later fails at the forwarder with the payment already made. {@link relayrSessionExpired}
 * lets the resume UI say so instead of offering a retry that cannot succeed.
 */
const FORWARDER_DEADLINE_SECONDS = 47 * 60 * 60
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

/** When a session's signatures stop being executable, in milliseconds. */
export function relayrSessionExpiresAt(session: { createdAt: number }): number {
  return session.createdAt + FORWARDER_DEADLINE_SECONDS * 1000
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
    })
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
    deadline: Math.floor(Date.now() / 1000) + FORWARDER_DEADLINE_SECONDS,
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
  const body = (await response.json()) as Partial<RelayrQuote> & {
    tx_uuids?: unknown
    txn_uuids?: unknown
  }
  const bundleUuid = String(body.bundle_uuid ?? '').toLowerCase()
  if (!RELAYR_UUID_RE.test(bundleUuid)) {
    throw new Error('Relayr returned no valid bundle ID. Nothing was paid.')
  }
  const currentIds = Array.isArray(body.tx_uuids) ? body.tx_uuids : null
  const legacyIds = Array.isArray(body.txn_uuids) ? body.txn_uuids : null
  if (
    currentIds &&
    legacyIds &&
    JSON.stringify(currentIds) !== JSON.stringify(legacyIds)
  ) {
    throw new Error('Relayr returned conflicting transaction IDs. Nothing was paid.')
  }
  const rawIds = currentIds ?? legacyIds
  const txUuids = Array.isArray(rawIds)
    ? rawIds.map(value => String(value).toLowerCase())
    : []
  if (
    txUuids.length !== ordered.length ||
    txUuids.some(uuid => !RELAYR_UUID_RE.test(uuid)) ||
    new Set(txUuids).size !== ordered.length ||
    !Array.isArray(body.payment_info)
  ) {
    throw new Error(
      'Relayr did not bind every quoted transaction to a unique ID. Nothing was paid.',
    )
  }
  return {
    bundle_uuid: bundleUuid,
    payment_info: body.payment_info,
    transactions: Array.isArray(body.transactions) ? body.transactions : [],
    expectedTransactions: ordered.map((entry, index) => ({
      txUuid: txUuids[index],
      chain: entry.chain,
      entry,
    })),
  }
}

function relayrDeadlineSeconds(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return value
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const numeric = Number(value)
    if (Number.isSafeInteger(numeric) && numeric >= 0) return numeric
  }
  const milliseconds = typeof value === 'string' ? Date.parse(value) : Number.NaN
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return null
  return Math.floor(milliseconds / 1_000)
}

/** Authenticate every field in Relayr's payment quote against its bundle. */
export function relayrPaymentDetails(
  payment: RelayrPayment,
  expectedBundleUuid: string,
  nowSeconds = Math.floor(Date.now() / 1_000),
): RelayrPaymentDetails {
  const chainId = Number(payment?.chain) as JBChainId
  if (
    !Number.isSafeInteger(chainId) ||
    !RELAYR_PAYMENT_CHAINS.has(chainId) ||
    !SUPPORTED_CHAINS.some(chain => chain.id === chainId)
  ) {
    throw new Error('Relayr returned an unsupported payment chain.')
  }
  if (
    !payment ||
    !isAddress(payment.target) ||
    !isAddressEqual(payment.target, RELAYR_PAYMENT_ADDRESS)
  ) {
    throw new Error('Relayr returned an unrecognized payment contract.')
  }
  if (
    !payment.token ||
    !isAddress(payment.token) ||
    !isAddressEqual(payment.token, RELAYR_NATIVE_TOKEN)
  ) {
    throw new Error('Relayr returned an unsupported payment token.')
  }

  let amount: bigint
  try {
    amount = BigInt(payment.amount)
  } catch {
    throw new Error('Relayr returned an invalid payment amount.')
  }
  if (amount < 0n) throw new Error('Relayr returned an invalid payment amount.')

  const bundleUuid = String(expectedBundleUuid ?? '').toLowerCase()
  if (!RELAYR_UUID_RE.test(bundleUuid)) {
    throw new Error('Relayr returned an invalid bundle ID.')
  }

  const calldata = String(payment.calldata ?? '').toLowerCase()
  // selector + ABI word(bytes16, right-padded) + ABI word(uint40)
  if (!/^0x[0-9a-f]{136}$/.test(calldata)) {
    throw new Error('Relayr returned invalid payment calldata.')
  }
  if (calldata.slice(0, 10) !== RELAYR_PAYMENT_SELECTOR) {
    throw new Error('Relayr returned an unrecognized payment function.')
  }
  const compactUuid = bundleUuid.replaceAll('-', '')
  if (calldata.slice(10, 74) !== `${compactUuid}${'0'.repeat(32)}`) {
    throw new Error('Relayr payment calldata does not match this bundle.')
  }

  let deadline: bigint
  try {
    deadline = BigInt(`0x${calldata.slice(74, 138)}`)
  } catch {
    throw new Error('Relayr returned invalid payment calldata.')
  }
  if (deadline > 0xffffffffffn) {
    throw new Error('Relayr returned an invalid payment deadline.')
  }
  const quotedDeadline = relayrDeadlineSeconds(payment.payment_deadline)
  if (quotedDeadline === null || BigInt(quotedDeadline) !== deadline) {
    throw new Error('Relayr payment calldata does not match the quote deadline.')
  }
  if (deadline <= BigInt(nowSeconds + 15)) {
    throw new Error('This Relayr quote expired. Review the action again for a new quote.')
  }

  return {
    chainId,
    target: RELAYR_PAYMENT_ADDRESS,
    amount,
    calldata: calldata as Hex,
    bundleUuid,
    deadline,
  }
}

async function requireRelayrPaymentRuntime(
  client: ReturnType<typeof publicClient>,
): Promise<void> {
  const code = await client.request({
    method: 'eth_getCode',
    params: [RELAYR_PAYMENT_ADDRESS, 'latest'],
  })
  if (
    typeof code !== 'string' ||
    !/^0x(?:[0-9a-fA-F]{2})+$/.test(code) ||
    (code.length - 2) / 2 > RELAYR_PAYMENT_CODE_MAX_BYTES
  ) {
    throw new Error('Could not authenticate the Relayr payment contract.')
  }
  if (keccak256(code) !== RELAYR_PAYMENT_CODE_HASH) {
    throw new Error('Relayr payment contract code is not recognized.')
  }
}

async function simulateRelayrPayment(
  client: ReturnType<typeof publicClient>,
  account: Address,
  details: RelayrPaymentDetails,
): Promise<void> {
  const result = await client.request({
    method: 'eth_call',
    params: [
      {
        from: account,
        to: details.target,
        value: `0x${details.amount.toString(16)}`,
        data: details.calldata,
        gas: `0x${RELAYR_PAYMENT_GAS.toString(16)}`,
      },
      'latest',
    ],
  })
  if (result !== '0x') {
    throw new Error('Relayr payment simulation returned an unexpected result.')
  }
}

export function relayrPaymentLabel(payment: RelayrPayment): string {
  const chain = SUPPORTED_CHAINS.find(item => item.id === Number(payment.chain))
  const amount = Number(formatEther(BigInt(payment.amount)))
  return `${chain?.name ?? `Chain ${payment.chain}`} — ~${amount.toFixed(5)} ETH`
}

export async function relayrPay(
  payment: RelayrPayment,
  expectedAccount: Address,
  expectedBundleUuid: string,
  onSubmitted?: (hash: Hex) => void,
  reverify?: () => Promise<void>,
): Promise<Hex> {
  assertNoViewAs()
  let details = relayrPaymentDetails(payment, expectedBundleUuid)
  await reverify?.()
  const chainId = details.chainId
  const client = publicClient(chainId)
  await requireRelayrPaymentRuntime(client)

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
        to: details.target,
        value: details.amount,
        data: details.calldata,
        label: 'Pay for relayed transactions',
        contractName: 'Relayr prepaid payment',
      },
    ],
  })

  details = relayrPaymentDetails(payment, expectedBundleUuid)
  await reverify?.()
  const { wallet, account } = await connectedWallet(chainId)
  if (account.toLowerCase() !== expectedAccount.toLowerCase()) {
    throw new Error('Connected account changed. Review the Relayr payment again.')
  }
  await requireRelayrPaymentRuntime(client)
  await simulateRelayrPayment(client, account, details)
  const live = getAccount(wagmiConfig).address
  if (!live || live.toLowerCase() !== expectedAccount.toLowerCase()) {
    throw new Error('Connected account changed. Review the Relayr payment again.')
  }
  // Review and wallet preparation are open-ended. Re-authenticate the exact
  // quote immediately before the fixed-gas write.
  details = relayrPaymentDetails(payment, expectedBundleUuid)
  await reverify?.()
  let hash = await wallet.sendTransaction({
    account,
    to: details.target,
    value: details.amount,
    data: details.calldata,
    gas: RELAYR_PAYMENT_GAS,
  })
  const submittedHash = hash
  try {
    onSubmitted?.(submittedHash)
    if (isSafeConnection(wagmiConfig)) {
      hash = await waitForSafeExecutionHash(chainId, submittedHash)
    }
  } catch {
    // Once the wallet returns a hash, callback/storage or Safe execution-hash
    // tracking failures are uncertain submitted outcomes, never permission to
    // quote and pay this bundle again.
    throw new RelayrPaymentSubmittedError(submittedHash, chainId)
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
      const response = await relayrFetch(
        `${RELAYR_API}/v1/bundle/${uuid}`,
        undefined,
        Math.min(RELAYR_STATUS_REQUEST_TIMEOUT_MS, Math.max(timeoutMs - elapsed, 1)),
      )
      if (response.status === 404) {
        consecutiveNotFound += 1
        if (consecutiveNotFound >= RELAYR_NOT_FOUND_ATTEMPTS) {
          throw new RelayrExecutionError(
            `Relayr does not recognize bundle ${uuid}. Nothing is pending under it — start the action again.`,
            'RELAYR_NOT_FOUND',
            uuid,
            lastRecords,
            false,
          )
        }
      } else {
        consecutiveNotFound = 0
      }
      if (response.ok) {
        const body = (await response.json()) as {
          transactions?: RelayrTransactionRecord[]
        }
        const records = body.transactions ?? []
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

export function relayrDestinationHash(
  record: RelayrTransactionRecord,
): Hex | null {
  return record.status?.data?.hash ?? record.status?.data?.transaction?.hash ?? null
}

/** Relayr's live status schema nests the destination chain under request. */
export function relayrRecordChain(
  record: RelayrTransactionRecord,
): number | null {
  const chain = record.request?.chain ?? record.chain
  return Number.isSafeInteger(chain) && Number(chain) > 0 ? Number(chain) : null
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

function relayrSessionFullyFailed(
  records: RelayrTransactionRecord[],
  expectedCount: number,
): boolean {
  return (
    records.length === expectedCount &&
    records.every(record => relayrStateIsFailed(record.status?.state))
  )
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
  if (
    pendingScope.startsWith('safe-queue:') ||
    saved.expectedEntries ||
    saved.expectedSafeExecutions
  ) {
    // SafeQueue sessions carry an execution hash/nonce proof which the global
    // account list cannot re-establish without the queue's exact Safe context.
    // Never let API-only success/failure clear that paid receipt.
    throw new Error(
      'Resume this paid Safe bundle from the project Owner/Operator queue so its exact onchain executions can be verified.',
    )
  }
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
    const records = await relayrPoll(saved.bundleUuid, saved.expectedCount, next => {
      saveRelayrPendingSession(pendingScope, { ...saved, records: next })
      reportProgress(next)
    }, 2_500, 5 * 60_000)
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
  reverify,
}: {
  calls: RelayrCall[]
  account: Address
  paymentChainId?: number
  pendingScope?: string
  onProgress?: (progress: RelayrProgress) => void
  /** Re-prove every mutable project call around signatures and payment. */
  reverify?: () => Promise<void>
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

  // The ForwardRequest deadlines start at SIGNING, not at payment — stamping
  // the session when the payment lands would report a bundle as still valid
  // for however long the wallet sat on the signatures, and a "not yet expired"
  // resume would then die at the forwarder. Taken before the first signature,
  // so it can only understate the remaining validity.
  const signedAt = Date.now()
  const entries: RelayrEntry[] = []
  for (let index = 0; index < calls.length; index++) {
    onProgress?.({
      phase: 'signing',
      current: index + 1,
      total: calls.length,
      chainId: calls[index].chainId,
    })
    await reverify?.()
    entries.push(await buildForwardedTx(calls[index], account))
    await reverify?.()
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
  const paymentHash = await relayrPay(payment, account, quote.bundle_uuid, hash => {
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
        createdAt: signedAt,
      })
    }
    onProgress?.({
      phase: 'payment-submitted',
      payment,
      paymentHash: hash,
      bundleUuid: quote.bundle_uuid,
    })
  }, reverify)
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
      createdAt: signedAt,
    })
  }
  onProgress?.({
    phase: 'payment-confirmed',
    payment,
    paymentHash,
    bundleUuid: quote.bundle_uuid,
  })

  try {
    const records = await relayrPoll(quote.bundle_uuid, calls.length, next => {
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
    }, 2_500, 5 * 60_000)
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
