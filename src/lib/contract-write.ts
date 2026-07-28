import type { Address } from 'viem'
import { assertNoViewAs } from '@/lib/viewAs'

export type ReviewedWritePhase = 'review' | 'simulating' | 'signing'

type ReviewedContractWriteOptions<TRequest extends { chainId: number }, TSimulated, THash> = {
  request: TRequest
  expectedAccount: Address | undefined
  review: (request: TRequest) => Promise<unknown>
  switchChain: (chainId: number) => Promise<unknown>
  currentAccount: () => Address | undefined
  simulate: (request: TRequest) => Promise<TSimulated>
  write: (simulated: TSimulated) => Promise<THash>
  onPhase?: (phase: ReviewedWritePhase) => void
  accountChangedError?: string
}

/**
 * Shared review-to-wallet boundary for direct contract writes.
 *
 * The exact request object accepted by review is also handed to simulation,
 * and only the simulation result reaches the wallet writer. Account identity
 * is checked after a chain switch and again immediately before signing.
 */
export async function submitReviewedContractWrite<
  TRequest extends { chainId: number },
  TSimulated,
  THash,
>({
  request,
  expectedAccount,
  review,
  switchChain,
  currentAccount,
  simulate,
  write,
  onPhase,
  accountChangedError = 'Connected account changed. Review the transaction again.',
}: ReviewedContractWriteOptions<TRequest, TSimulated, THash>): Promise<THash> {
  assertNoViewAs()
  if (!expectedAccount) throw new Error('Connect a wallet first.')

  onPhase?.('review')
  await review(request)

  onPhase?.('simulating')
  await switchChain(request.chainId)
  assertExpectedAccount(currentAccount(), expectedAccount, accountChangedError)

  const simulated = await simulate(request)
  assertExpectedAccount(currentAccount(), expectedAccount, accountChangedError)

  onPhase?.('signing')
  return write(simulated)
}

function assertExpectedAccount(
  current: Address | undefined,
  expected: Address,
  message: string,
): void {
  if (!current || current.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(message)
  }
}
