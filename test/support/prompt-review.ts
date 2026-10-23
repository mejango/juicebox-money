import { TransactionReviewCancelledError } from '@bananapus/nana-sdk-core/review'
import { promptReviewForTests } from '@bananapus/nana-sdk-core/testing'
import type { TransactionReviewRequest } from '@/lib/transaction-review'

/** Core's prompt of `request` through the page's handler, as a send asks it: resolves once confirmed, and a closed review rejects as core's does. */
export function requireReview(request: TransactionReviewRequest): Promise<void> {
  return promptReviewForTests(request).outcome.then(outcome => {
    if (outcome !== 'confirmed') throw new TransactionReviewCancelledError()
  })
}
