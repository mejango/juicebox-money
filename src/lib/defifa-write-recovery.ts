import {
  createBrowserWriteRecovery,
  createHeldWriteStorage,
  readBrowserWriteRecovery,
  writeHeldMessage,
  type ReviewedWriteRecoveryRecord,
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

/** The SDK hold's saved record of a Defifa action, if one is held. */
export function readDefifaWriteRecovery(scope: DefifaRecoveryScope) {
  return readBrowserWriteRecovery({ chainId: scope.chainId, account: scope.account, namespace: defifaWriteNamespace(scope) }, { storage })
}

export class PendingDefifaWriteError extends Error {
  constructor(readonly record: ReviewedWriteRecoveryRecord) {
    super(writeHeldMessage('NFT action'))
  }
}

/**
 * Run a Defifa action under the SDK hold of its namespace: the hold reserves,
 * records and follows it. A saved earlier attempt goes to its recovery card
 * first, and `onRecord` hears of the hold's record as it changes.
 */
export async function runRecoverableDefifaWrite({ scope, action, run, onRecord }: {
  scope: DefifaRecoveryScope
  action: ReviewedRun
  run: (action: ReviewedRun) => Promise<ReviewedResult | null>
  onRecord?: (record: ReviewedWriteRecoveryRecord | null) => void
}) {
  const [call] = action.calls
  if (action.calls.length !== 1 || call.chainId !== scope.chainId || action.account.toLowerCase() !== scope.account.toLowerCase()) {
    throw new Error('The recovery scope does not match the reviewed account and network.')
  }
  const previous = readDefifaWriteRecovery(scope)
  if (previous) {
    onRecord?.(previous)
    throw new PendingDefifaWriteError(previous)
  }
  const told = (record: ReviewedWriteRecoveryRecord | null) => {
    onRecord?.(record)
    notifyRecovery()
  }
  const result = await run({
    ...action,
    calls: [{ ...call, intent: defifaWriteNamespace(scope) }],
    beforeWallet: async (reviewed, step) => {
      // The hold reserved this write just before: its record is the recovery record.
      told(readDefifaWriteRecovery(scope))
      await action.beforeWallet?.(reviewed, step)
    },
    onUnsent: async (reviewed, step) => {
      told(null)
      await action.onUnsent?.(reviewed, step)
    },
  })
  if (result) {
    // A receipt the hold already settled leaves no record: the card keeps the one it was told.
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
  notifyRecovery()
}
