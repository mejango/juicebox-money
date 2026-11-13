import { TransactionReviewCancelledError } from '@bananapus/nana-sdk-core/review'

/** A Safe's valid proposal nonces, ascending: the last is the next free one. */
export type SafeNonceRequest = {
  chainName: string
  choices: readonly number[]
}

type SafeNonceHandler = (request: SafeNonceRequest) => Promise<number | null>

let handler: SafeNonceHandler | null = null

/** The app's dialog provider answers nonce choices. Returns the unregister. */
export function registerSafeNonceHandler(next: SafeNonceHandler): () => void {
  handler = next
  return () => {
    if (handler === next) handler = null
  }
}

/** What a nonce option says: the next free one, or the replacement of what is queued there. */
export function safeNonceLabel(nonce: number, next: number): string {
  return nonce === next ? `${nonce}, next available` : `${nonce}, replaces what is queued there`
}

/**
 * The nonce a new Safe proposal takes. Asks only when the Safe has queued proposals one could
 * replace; a closed prompt cancels the action.
 */
export async function chooseSafeNonce(request: SafeNonceRequest): Promise<number> {
  const next = request.choices[request.choices.length - 1]
  if (next === undefined) throw new Error('Could not read the Safe nonce.')
  if (request.choices.length === 1 || !handler) return next
  const chosen = await handler(request)
  if (chosen === null || !request.choices.includes(chosen)) throw new TransactionReviewCancelledError()
  return chosen
}
