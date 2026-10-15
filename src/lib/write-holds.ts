import {
  createSavedAttemptRecovery,
  createWriteHold,
  HELD_RELEASED_ELSEWHERE_LINE,
  type SavedAttempt,
  type SavedAttemptOutcome,
  type WriteHoldClient,
  type WriteHoldHandle,
} from '@bananapus/nana-sdk-core/review'
import { keccak256, stringToHex, type Address, type TransactionReceipt } from 'viem'
import { heldCall, type SafeAppCall } from '@/lib/safe-connector'

/**
 * The app's one SDK write hold: every wallet write is held through it
 * (storage or this tab's memory, one lock per exact call or intent, the
 * states, the exits and the release rules).
 */
export const writeHolds = createWriteHold()

/** The app's one saved-attempt recovery over it: launches, Relayr sessions, payers, batches and Safe setup. */
export const savedAttempts = createSavedAttemptRecovery({ hold: writeHolds })

/**
 * A saved attempt the SDK's recovery is showing (held, or its one check): the
 * flow stops there, before any preparation, until it settles or the user
 * retires it (SavedAttemptRecovery).
 */
export class SavedAttemptShownError extends Error {
  readonly name = 'SavedAttemptShownError'
  constructor(readonly attempt: SavedAttempt<unknown>, line: string) {
    super(line)
  }
}

/**
 * The SDK's recovery of a saved attempt, right after a flow finds it: `done`
 * and `none` come back for the flow to follow or resend; a hold or a check
 * stops the flow with SavedAttemptShownError, whose attempt the page shows.
 */
export async function recoverSaved<T>(
  attempt: SavedAttempt<T>,
  client: WriteHoldClient,
  /** The flow's own line for where it stopped; the SDK's otherwise. The page shows the SDK's copy either way. */
  line?: string,
): Promise<Extract<SavedAttemptOutcome<T>, { status: 'done' | 'none' }>> {
  const outcome = await savedAttempts.recover(attempt, client)
  if (outcome.status === 'held') throw new SavedAttemptShownError(attempt as SavedAttempt<unknown>, line ?? outcome.state.line)
  if (outcome.status === 'check') throw new SavedAttemptShownError(attempt as SavedAttempt<unknown>, line ?? outcome.line)
  return outcome
}

/** Attempts whose user took the SDK's warned exit over storage this browser can't read. */
const unreadableConsent = new WeakSet<object>()

/**
 * Run the SDK's warned exit (unreadableAction) for `attempt`: while it runs, a
 * journal re-read that fails still lets it retire, in this tab alone. Only this
 * explicit action ever does; a read exception otherwise never counts as released.
 */
export async function withUnreadableConsent<T>(attempt: object, run: () => Promise<T>): Promise<T> {
  unreadableConsent.add(attempt)
  try {
    return await run()
  } finally {
    unreadableConsent.delete(attempt)
  }
}

/** A journal re-read for confirmRetirable: false when it reads a kept success, and a failed read retires only under the warned exit. */
export function strictRetirable(attempt: () => object, read: () => boolean): () => Promise<boolean> {
  return async () => {
    try {
      return read()
    } catch {
      return unreadableConsent.has(attempt())
    }
  }
}

/** A review's description, with the hold's line when this browser can't remember pending writes. */
export function reviewDescription(...parts: (string | null | undefined)[]): string | undefined {
  return [...parts, writeHolds.reviewLine()].filter(Boolean).join('\n\n') || undefined
}

/**
 * A lib flow's receipt goes to the SDK hold, which verifies it: only its
 * settlement of this hash is the flow's success (acknowledged, since the flow
 * reports it). Anything else stays held, listed app-wide by HeldWritesNotice,
 * and ends the flow with the hold's line.
 */
export async function requireHeldSettlement(
  hold: WriteHoldHandle,
  client: WriteHoldClient,
  receipt: TransactionReceipt,
  proof?: Parameters<WriteHoldHandle['onReceipt']>[2],
): Promise<void> {
  const state = await hold.onReceipt(receipt, client, proof).catch(() => hold.peek())
  if (state.status !== 'clear') throw new Error(state.line)
  const settled = state.settled
  if (!settled || !('hash' in settled) || settled.hash.toLowerCase() !== receipt.transactionHash.toLowerCase()) throw new Error(HELD_RELEASED_ELSEWHERE_LINE)
  if (settled.result === 'success') await hold.acknowledge(settled).catch(() => null)
}

/** A Safe proposal's key: its chain, Safe and exact call with any field stamped at send time blanked. */
export function safeProposalKey(chainId: number, safe: Address, call: SafeAppCall): string {
  const held = heldCall(call)
  return `${chainId}:${safe.toLowerCase()}:${held.to.toLowerCase()}:${held.value ?? 0n}:${held.data.toLowerCase()}`
}

/** A Safe write is held by that key, so a re-stamped proposal of the same call is the same hold. */
export function safeHoldNamespace(key: string): string {
  return `safe:${keccak256(stringToHex(key)).slice(2)}`
}

/** The hold over a Safe app write of `call`, shared by every module that proposes it. */
export function safeWriteHold(chainId: number, safe: Address, call: SafeAppCall): WriteHoldHandle {
  return writeHolds.open({ chainId, account: safe, safe: true, namespace: safeHoldNamespace(safeProposalKey(chainId, safe, call)), call })
}
