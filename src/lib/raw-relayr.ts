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
import { assertRawQuoteBindings, runRawRelayrLifecycle, type RawRelayrState } from '@/lib/raw-relayr-lifecycle'

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
  if (!raw) return memory.has(scope) ? snapshot(memory.get(scope)!) : null
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

/** Only permissionless, zero-value calls belong here. The owner reviews and validates their semantic eligibility. */
export async function runRawRelayrCalls({ calls, account, pendingScope, preferredPaymentChainId, reverify, onProgress, onComplete }: {
  calls: RawRelayrCall[]
  account: Address
  pendingScope: string
  preferredPaymentChainId?: number
  reverify: () => Promise<void>
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
    let pollError: unknown
    if (session.phase !== 'complete') {
      pollError = await runRawRelayrLifecycle({ session, entries, preferredPaymentChainId, assertAccount,
        reverify: async () => { assertAccount(); await reverify(); assertAccount() },
        saveState: (next, beforeWrite) => { session = next; save(session, beforeWrite); onProgress?.({ message: session.phase === 'executing' ? 'Routing payments…' : 'Preparing routing bundle…' }) },
      })
    }
    if (!session.quote) throw new Error('The original routing quote is unavailable. Keep this bundle pending.')
    assertRawQuoteBindings(session.quote, entries)
    const receipts: TransactionReceipt[] = []
    for (let index = 0; index < session.calls.length; index++) {
      const call = session.calls[index]
      const binding = session.quote.expectedTransactions[index]
      const matching = session.records.filter(record => record.tx_uuid?.toLowerCase() === binding.txUuid.toLowerCase() && relayrRecordChain(record) === call.chainId)
      const record = matching.length === 1 ? matching[0] : undefined
      const hash = record && relayrDestinationHash(record)
      const request = record?.request
      if (!hash || !request || request.chain !== call.chainId || !isAddressEqual(request.target, call.target) ||
          request.data.toLowerCase() !== call.data.toLowerCase() || BigInt(request.value) !== 0n || (request.virtual_nonce ?? 0) !== (entries[index].virtual_nonce ?? 0)) {
        throw pollError ?? new Error('Some routing transactions remain unresolved. Check this saved bundle before retrying.')
      }
      receipts.push(await verifyDestination(call, hash))
    }
    session.phase = 'complete'
    save(session)
    await onComplete(receipts)
    // The owner has durably recorded outcomes before the recovery journal is released.
    window.localStorage.removeItem(PREFIX + pendingScope)
    memory.delete(pendingScope)
    authoritative.delete(pendingScope)
  })
}
