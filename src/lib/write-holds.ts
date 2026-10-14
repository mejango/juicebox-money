import { createWriteHold, type WriteHoldSettled } from '@bananapus/nana-sdk-core/review'

/**
 * The app's one SDK write hold: every wallet write is held through it
 * (storage or this tab's memory, one lock per exact call, the states, the
 * exits and the release rules).
 */
export const writeHolds = createWriteHold()

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
