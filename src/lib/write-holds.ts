import { createWriteHold, type WriteHoldHandle, type WriteHoldSettled, type WriteHoldState } from '@bananapus/nana-sdk-core/review'

/**
 * The app's one SDK write hold: every wallet write is held through it
 * (storage or this tab's memory, one lock per exact call, the states, the
 * exits and the release rules).
 */
export const writeHolds = createWriteHold()

/** A hold that cleared with no settlement this flow can claim (an exit elsewhere): neutral, never a result. */
export const WRITE_RELEASED_LINE = 'This transaction is no longer held here. Check your wallet before sending it again.'

/**
 * Whether `next` only repeats `shown` without its exit (a replay, or a saved
 * state read before the chain was asked): the exit `shown` already offers stays.
 */
export function repeatsWithoutExit(shown: WriteHoldState | null | undefined, next: WriteHoldState): boolean {
  return !!shown && shown.status !== 'clear' && next.status !== 'clear' && shown.exit && !next.exit &&
    (shown.status as string) === next.status && JSON.stringify(shown.record) === JSON.stringify(next.record)
}

/** The hash a settlement names, lowercased, or null (an expiry names none). */
export function settledHashOf(settled?: WriteHoldSettled): string | null {
  return settled && 'hash' in settled ? settled.hash.toLowerCase() : null
}

/** What a hold that ended on its own says: its result when the hold saw it, otherwise that it went through. Never a send. */
export function settledLine(settled?: WriteHoldSettled): string {
  if (settled?.result === 'failed') return 'Your earlier transaction failed onchain.'
  if (settled?.result === 'expired') return 'Your earlier Safe proposal expired before it ran.'
  return 'Your earlier transaction went through.'
}

/**
 * What a hold's saved record says, without asking the chain, for display only:
 * never an exit. Exits come only from state() and exit(), which ask the chain
 * first.
 */
export function peekHeld(hold: WriteHoldHandle): WriteHoldState {
  const state = hold.peek()
  return state.status === 'clear' ? state : ({ ...state, exit: false } as unknown as WriteHoldState)
}
