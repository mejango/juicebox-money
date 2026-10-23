import {
  createBrowserWriteRecovery,
  createHeldWriteStorage,
  readBrowserWriteRecovery,
  writeHeldMessage,
  type ReviewedWriteRecoveryRecord,
  ReviewLineError,
} from '@bananapus/nana-sdk-core/review'
import type { Address } from 'viem'
import type { ReviewedResult } from '@bananapus/nana-sdk-core/review'
import type { ReviewedRun } from '@/hooks/useReviewedAction'

/** The SDK's held-write storage, shared with every write hold: the browser's, or this tab's memory. */
const storage = createHeldWriteStorage()

export type DefifaWriteAction = 'pay' | 'cash-out' | 'transfer'
export type DefifaRecoveryScope = { chainId: number; projectId: number; account: Address; action: DefifaWriteAction }
export const DEFIFA_RECOVERY_QUERY_PREFIX = ['defifa-write-recovery'] as const
export const DEFIFA_RECOVERY_CHANGE_EVENT = 'defifa-write-recovery'
export const notifyRecovery = () => { globalThis.dispatchEvent?.(new Event(DEFIFA_RECOVERY_CHANGE_EVENT)) }

/** Approval and mint are successive legs of one pay intent, never two holds. */
export const defifaWriteNamespace = (scope: DefifaRecoveryScope) => `defifa:${scope.action}:${scope.projectId}`

/**
 * The site's copy of a sent Defifa action's record, kept until its NFT effects
 * are verified. The hold clears its own record once the transaction settles,
 * which is before that check: a reload in between still shows the action as
 * pending, with a re-check, never a second send.
 */
const unverifiedKey = (scope: DefifaRecoveryScope) =>
  `jbm:defifa-unverified:${defifaWriteNamespace(scope)}:${scope.chainId}:${scope.account.toLowerCase()}`
function readUnverified(scope: DefifaRecoveryScope): ReviewedWriteRecoveryRecord | null {
  try {
    const saved = storage.getItem(unverifiedKey(scope))
    return saved ? JSON.parse(saved) as ReviewedWriteRecoveryRecord : null
  } catch {
    return null
  }
}
function keepUnverified(scope: DefifaRecoveryScope, record: ReviewedWriteRecoveryRecord | null) {
  try {
    if (record) storage.setItem(unverifiedKey(scope), JSON.stringify(record))
    else storage.removeItem(unverifiedKey(scope))
  } catch { /* The hold's own record still guards this tab. */ }
}

/** The saved record of a Defifa action until its effects are verified: the hold's, or the site's copy once the hold settled it. */
export function readDefifaWriteRecovery(scope: DefifaRecoveryScope) {
  return readBrowserWriteRecovery({ chainId: scope.chainId, account: scope.account, namespace: defifaWriteNamespace(scope) }, { storage })
    ?? readUnverified(scope)
}

export class PendingDefifaWriteError extends Error {
  constructor(readonly record: ReviewedWriteRecoveryRecord) {
    super(writeHeldMessage('NFT action'))
  }
}

/**
 * Run a Defifa action under the SDK hold of its namespace: the hold reserves,
 * records and follows it. Its last call is the action (the mint, cash-out or
 * transfer); calls before it (its payment approval) are steps of the same
 * review, held by their own keys, saved as one sequence under the namespace
 * so a reload resumes them. A saved earlier attempt goes to its recovery card
 * first, and `onRecord` hears of the action's hold record as it changes.
 */
export async function runRecoverableDefifaWrite({ scope, action, run, onRecord }: {
  scope: DefifaRecoveryScope
  action: ReviewedRun
  run: (action: ReviewedRun) => Promise<ReviewedResult | null>
  onRecord?: (record: ReviewedWriteRecoveryRecord | null) => void
}) {
  const last = action.calls.length - 1
  if (last < 0 || action.calls.some(call => call.chainId !== scope.chainId) || action.account.toLowerCase() !== scope.account.toLowerCase()) {
    throw new ReviewLineError('The recovery scope does not match the reviewed account and network.')
  }
  const previous = readDefifaWriteRecovery(scope)
  if (previous) {
    onRecord?.(previous)
    throw new PendingDefifaWriteError(previous)
  }
  const told = (record: ReviewedWriteRecoveryRecord | null) => {
    keepUnverified(scope, record)
    onRecord?.(record)
    notifyRecovery()
  }
  const namespace = defifaWriteNamespace(scope)
  const result = await run({
    ...action,
    calls: action.calls.map((call, step) => (step === last ? { ...call, intent: namespace } : call)),
    ...(last > 0 ? { scope: namespace } : {}),
    beforeWallet: async (reviewed, step) => {
      // The hold reserved the action just before: its record is the recovery record.
      if (step === last) told(readDefifaWriteRecovery(scope))
      await action.beforeWallet?.(reviewed, step)
    },
    onSubmitted: async (reviewed, step, hash, sent) => {
      // The copy carries the hash, so a reload after the hold settles can still re-check it.
      const record = step !== last ? null : readBrowserWriteRecovery({ chainId: scope.chainId, account: scope.account, namespace }, { storage })
        ?? readUnverified(scope)
      if (record) told({ ...record, hash: record.hash ?? hash })
      await action.onSubmitted?.(reviewed, step, hash, sent)
    },
    onUnsent: async (reviewed, step) => {
      if (step === last) told(null)
      await action.onUnsent?.(reviewed, step)
    },
  })
  if (result) {
    // A receipt the hold already settled leaves the site's copy until the effects are verified.
    const record = readDefifaWriteRecovery(scope)
    if (record) told(record)
    else notifyRecovery()
  }
  return result
}

/**
 * Call only after the exact original write's success or finalized failure was
 * authenticated. The hold may already have settled it (its record is gone):
 * then nothing is left to clear.
 */
export async function clearDefifaWriteRecovery(scope: DefifaRecoveryScope, record: ReviewedWriteRecoveryRecord) {
  const journal = createBrowserWriteRecovery({ ...record, namespace: defifaWriteNamespace(scope) }, { storage })
  await journal.withLock(async () => {
    const current = journal.read()
    if (current?.id === record.id) journal.clear(current)
  })
  if (readUnverified(scope)?.id === record.id) keepUnverified(scope, null)
  notifyRecovery()
}
