import { createWriteHold, type WriteHoldSettled } from '@bananapus/nana-sdk-core/review'

/**
 * The app's one SDK write hold: every wallet write is held through it
 * (storage or this tab's memory, one lock per exact call, the states, the
 * exits and the release rules).
 */
export const writeHolds = createWriteHold()

/** What a hold that ended on its own says: its result when the hold saw it, otherwise that it went through. Never a send. */
export function settledLine(settled?: WriteHoldSettled): string {
  if (settled?.result === 'failed') return 'Your earlier transaction failed onchain.'
  if (settled?.result === 'expired') return 'Your earlier Safe proposal expired before it ran.'
  return 'Your earlier transaction went through.'
}
