import { BaseError, ContractFunctionRevertedError } from 'viem'

/** A validation failure with copy that's already user-ready. */
export class FlowError extends Error {}

/** A revert means the chain answered, so a missing feed (or similar) is a fact about the
 *  protocol rather than about the network. */
export function contractReverted(error: unknown): boolean {
  return (
    error instanceof BaseError &&
    !!error.walk(cause => cause instanceof ContractFunctionRevertedError)
  )
}

/**
 * Trim a raw simulation/wallet error down to its useful first line, with the
 * denied/rejected cases mapped to friendly copy. `fallback` covers non-Error
 * throws.
 */
export function shortError(
  error: unknown,
  fallback = 'Something went wrong.',
): string {
  if (error instanceof Error) {
    const message =
      'shortMessage' in error && typeof error.shortMessage === 'string'
        ? error.shortMessage
        : error.message
    if (/denied|rejected/i.test(message)) return 'Transaction cancelled.'
    return message.split('\n')[0]
  }
  return fallback
}

/** A friendly one-line message out of a viem/wagmi error. */
export function friendlyError(e: unknown): string {
  const message =
    e instanceof BaseError
      ? e.shortMessage
      : e instanceof Error
        ? e.message
        : 'Something went wrong.'
  return /reject|denied|cancel/i.test(message)
    ? 'You cancelled in your wallet.'
    : message
}
