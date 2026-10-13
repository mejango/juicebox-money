'use client'

import { type JBChainId } from '@bananapus/nana-sdk-core'
import { getAccount } from '@wagmi/core'
import { isAddress, isAddressEqual, isHex, type Address, type Hex, type TransactionReceipt } from 'viem'
import { wagmiConfig } from '@/providers/Providers'
import { publicClient } from '@/lib/wallet-core'
import { assertNoViewAs } from '@/lib/viewAs'
import { isSafeConnection } from '@/lib/safe-connector'
import { withRelayrScopeLock } from '@/lib/relayr'
import { relayrBundleRequest, relayrDestinationHash, relayrRecordChain, relayrSentPaymentsSnapshot, relayrSupportsChains, type RelayrEntry } from '@bananapus/nana-sdk-core/review/relayr'
import { assertRawQuoteBindings, isExpiredUnfundedRawQuote, RawQuoteNotObtainedError, runRawRelayrLifecycle, type RawRelayrState } from '@/lib/raw-relayr-lifecycle'

/** One routing attempt's progress, in the reviewed order. */
export type RawAttempt = 'waiting' | 'checking' | 'confirmed' | 'reverted'
export type RawRelayrCall = { chainId: number; target: Address; data: Hex; value?: bigint; gas?: bigint }
type SavedCall = { chainId: number; target: Address; data: Hex; value: '0'; gas?: string }
export type RawRelayrSession = RawRelayrState & { version: 1; scope: string; calls: SavedCall[] }
const PREFIX = 'jb-raw-relayr-v1:'
const memory = new Map<string, RawRelayrSession>()
const authoritative = new Set<string>()
const MAX_BYTES = 2_000_000

function snapshot(value: RawRelayrSession): RawRelayrSession {
  const saved = JSON.parse(JSON.stringify(value)) as RawRelayrSession
  if (saved.version !== 1 || !saved.scope || !isAddress(saved.account) || !Array.isArray(saved.calls) || !saved.calls.length ||
      !Array.isArray(saved.records) || !['reviewed', 'publishing', 'quoted', 'payment-sending', 'payment-reverted', 'executing', 'complete'].includes(saved.phase) ||
      !relayrSupportsChains([...new Set(saved.calls.map(call => call.chainId))]) ||
      (saved.payments !== undefined && !relayrSentPaymentsSnapshot(saved.payments))) throw new Error('The saved routing bundle is malformed. Keep it pending.')
  for (const call of saved.calls) {
    if (!Number.isSafeInteger(call.chainId) || !isAddress(call.target) || !isHex(call.data) || call.data.length % 2 !== 0 || call.value !== '0' ||
        (call.gas !== undefined && !/^[1-9]\d*$/u.test(call.gas))) throw new Error('The saved routing call is malformed. Keep it pending.')
  }
  return saved
}

export function loadRawRelayrSession(scope: string): RawRelayrSession | null {
  if (authoritative.has(scope)) return snapshot(memory.get(scope)!)
  const raw = typeof window === 'undefined' ? null : window.localStorage.getItem(PREFIX + scope)
  if (raw === null) return memory.has(scope) ? snapshot(memory.get(scope)!) : null
  if (raw.length > MAX_BYTES) throw new Error('The saved routing bundle is too large. Keep it pending.')
  const saved = snapshot(JSON.parse(raw) as RawRelayrSession)
  if (saved.scope !== scope) throw new Error('The saved routing scope changed. Keep it pending.')
  return saved
}

function save(session: RawRelayrSession, beforeWrite = false): void {
  const saved = snapshot(session)
  const serialized = JSON.stringify(saved)
  try {
    if (typeof window === 'undefined' || serialized.length > MAX_BYTES) throw new Error('Storage unavailable.')
    window.localStorage.setItem(PREFIX + saved.scope, serialized)
    if (window.localStorage.getItem(PREFIX + saved.scope) !== serialized) throw new Error('Storage verification failed.')
  } catch {
    if (!beforeWrite) { memory.set(saved.scope, saved); authoritative.add(saved.scope) }
    throw new Error('Allow browser storage to preserve this routing bundle before continuing.')
  }
  memory.set(saved.scope, saved)
  authoritative.delete(saved.scope)
}

function forget(scope: string): void {
  window.localStorage.removeItem(PREFIX + scope)
  memory.delete(scope)
  authoritative.delete(scope)
}

/** Caller holds the raw scope lock while consuming this read-only proof. */
export async function isRawRelayrSessionReleased(scope: string): Promise<boolean> {
  const session = loadRawRelayrSession(scope)
  // Unsigned calls whose quote never arrived reserve nothing and cannot have been paid.
  if (session && !session.quote) return session.phase === 'reviewed' || session.phase === 'publishing'
  if (!session?.quote) return false
  const entries = relayrBundleRequest(session.calls.map(entryOf)).transactions
  assertRawQuoteBindings(session.quote, entries)
  return isExpiredUnfundedRawQuote(session, [...new Set(session.calls.map(call => call.chainId))])
}

const entryOf = (call: SavedCall): RelayrEntry => ({ chain: call.chainId, target: call.target, data: call.data, value: '0' })

/** Verify even reverted destinations canonically; the owner decides which pending payments remain retryable. */
async function verifyDestination(call: SavedCall, hash: Hex): Promise<TransactionReceipt> {
  const client = publicClient(call.chainId as JBChainId)
  const [transaction, receipt] = await Promise.all([client.getTransaction({ hash }), client.getTransactionReceipt({ hash })])
  if (transaction.hash.toLowerCase() !== hash.toLowerCase() || receipt.transactionHash.toLowerCase() !== hash.toLowerCase() ||
      transaction.chainId !== call.chainId || !transaction.to || !isAddressEqual(transaction.to, call.target) ||
      transaction.input.toLowerCase() !== call.data.toLowerCase() || transaction.value !== 0n ||
      !receipt.blockHash || typeof receipt.blockNumber !== 'bigint' || transaction.blockHash !== receipt.blockHash ||
      transaction.blockNumber !== receipt.blockNumber || !['success', 'reverted'].includes(receipt.status) ||
      (await client.getBlock({ blockNumber: receipt.blockNumber })).hash !== receipt.blockHash) {
    throw new Error('The routing transaction does not have an exact canonical receipt. Keep its bundle pending.')
  }
  return receipt
}

/** What the saved quote and Relayr's records show of each attempt; `results` are receipts already proven. */
function attemptStates(session: RawRelayrSession, results: (TransactionReceipt['status'] | undefined)[]): RawAttempt[] {
  return session.calls.map((_call, index) => {
    if (results[index]) return results[index] === 'success' ? 'confirmed' : 'reverted'
    const id = session.quote?.expectedTransactions?.[index]?.txUuid.toLowerCase()
    const record = id ? session.records.find(item => item.tx_uuid?.toLowerCase() === id && relayrRecordChain(item) === session.calls[index].chainId) : undefined
    return record && relayrDestinationHash(record) ? 'checking' : 'waiting'
  })
}

/** Only permissionless, zero-value calls belong here. The owner reviews and validates their semantic eligibility. */
export async function runRawRelayrCalls({ calls, account, pendingScope, preferredPaymentChainId, reverify, signal, onQuoted, onAttempts, onProgress, onComplete }: {
  calls: RawRelayrCall[]
  account: Address
  pendingScope: string
  preferredPaymentChainId?: number
  reverify: () => Promise<void>
  /** Cancels the fee quote request, until the quote is saved. */
  signal?: AbortSignal
  /** The quote is saved and the fee payment is next. */
  onQuoted?: () => void
  /** Display only: each attempt's progress in the reviewed order. */
  onAttempts?: (attempts: RawAttempt[]) => void
  onProgress?: (progress: { message: string }) => void
  onComplete: (receipts: TransactionReceipt[]) => Promise<void>
}): Promise<void> {
  return withRelayrScopeLock(`raw:${pendingScope}`, async () => {
    if (typeof navigator === 'undefined' || !navigator.locks) throw new Error('This browser cannot coordinate routing bundles across tabs. Use a browser with Web Locks support.')
    const normalized: SavedCall[] = calls.map(call => {
      if ((call.value ?? 0n) !== 0n) throw new Error('Raw routing bundles cannot transfer native value.')
      return { chainId: call.chainId, target: call.target, data: call.data, value: '0', ...(call.gas !== undefined ? { gas: call.gas.toString() } : {}) }
    })
    let session = loadRawRelayrSession(pendingScope) ?? snapshot({ version: 1, scope: pendingScope, account, calls: normalized, phase: 'reviewed', records: [] })
    if (!isAddressEqual(session.account, account) || JSON.stringify(session.calls) !== JSON.stringify(normalized)) {
      throw new Error('Resume the original routing bundle with its reviewed wallet and calls.')
    }
    const assertAccount = () => {
      assertNoViewAs()
      const connected = getAccount(wagmiConfig).address
      if (!connected || !isAddressEqual(connected, session.account) || isSafeConnection(wagmiConfig)) {
        throw new Error('Connect the wallet that reviewed this routing bundle before continuing.')
      }
    }
    assertAccount()
    const entries = relayrBundleRequest(session.calls.map(entryOf)).transactions
    // Each destination is proven on its own, by reviewed call index, as soon as Relayr reports its hash.
    const proven: (TransactionReceipt | undefined)[] = []
    const reading = new Set<number>()
    const readErrors = new Map<number, unknown>()
    const report = () => {
      try { onAttempts?.(attemptStates(session, proven.map(receipt => receipt?.status))) } catch { /* a display observer cannot interrupt routing */ }
    }
    const destinationHash = (index: number): Hex | null => {
      const call = session.calls[index]
      const binding = session.quote?.expectedTransactions?.[index]
      if (!binding) return null
      const matching = session.records.filter(record => record.tx_uuid?.toLowerCase() === binding.txUuid.toLowerCase() && relayrRecordChain(record) === call.chainId)
      const record = matching.length === 1 ? matching[0] : undefined
      const hash = record && relayrDestinationHash(record)
      const request = record?.request
      if (!hash || !request || request.chain !== call.chainId || !isAddressEqual(request.target, call.target) ||
          request.data.toLowerCase() !== call.data.toLowerCase() || BigInt(request.value) !== 0n || (request.virtual_nonce ?? 0) !== (entries[index].virtual_nonce ?? 0)) return null
      return hash
    }
    const prove = async (index: number) => {
      const hash = destinationHash(index)
      if (!hash || proven[index] || reading.has(index)) return
      reading.add(index)
      try { proven[index] = await verifyDestination(session.calls[index], hash); readErrors.delete(index) }
      catch (error) { readErrors.set(index, error) }
      finally { reading.delete(index); report() }
    }
    const proveAvailable = () => { for (let index = 0; index < session.calls.length; index++) void prove(index) }
    let pollError: unknown
    if (session.phase !== 'complete') {
      try {
        pollError = await runRawRelayrLifecycle({ session, entries, preferredPaymentChainId, assertAccount, releasable: true, signal, onQuoted,
          reverify: async () => { assertAccount(); await reverify(); assertAccount() },
          saveState: (next, beforeWrite) => { session = next; save(session, beforeWrite); onProgress?.({ message: session.phase === 'executing' ? 'Routing payments…' : 'Getting the fee quote…' }); report(); proveAvailable() },
        })
      } catch (error) {
        if (error instanceof RawQuoteNotObtainedError) forget(pendingScope)
        throw error
      }
    }
    if (!session.quote) throw new Error('The original routing quote is unavailable. Keep this bundle pending.')
    assertRawQuoteBindings(session.quote, entries)
    // A failed read of one destination never hides the others; the bundle stays held until all are proven.
    for (let index = 0; index < session.calls.length; index++) {
      while (reading.has(index)) await new Promise(resolve => setTimeout(resolve, 0))
      // Records that changed since a destination was proven void that proof.
      if (proven[index] && destinationHash(index)?.toLowerCase() !== proven[index]!.transactionHash.toLowerCase()) delete proven[index]
      await prove(index)
    }
    const missing = session.calls.findIndex((_call, index) => !proven[index])
    if (missing !== -1) throw readErrors.get(missing) ?? pollError ?? new Error('Some routing transactions remain unresolved. Check this saved bundle before retrying.')
    const receipts = proven as TransactionReceipt[]
    session.phase = 'complete'
    save(session)
    await onComplete(receipts)
    // The owner has durably recorded outcomes before the recovery journal is released.
    forget(pendingScope)
  })
}
