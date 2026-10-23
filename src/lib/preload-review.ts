'use client'

/** The send engine; one stable loader so core's mount preload runs once per page. */
export const loadReviewEngine = () => import('@bananapus/nana-sdk-core/review')

/** jbm's send deps (wallet adapter, write hold), loaded with the engine by libs a page imports eagerly. */
export const loadReviewedSendDeps = () => import('@/lib/reviewed-send').then(module => module.reviewedSendDeps)

/** Fetch the send engine and the review dialog now; the import cache dedupes repeats. A failure loads again on the click. */
export function preloadReview() {
  void loadReviewEngine().catch(() => {})
  void import('@/components/TransactionReviewDialog').catch(() => {})
}

/**
 * Fetch the review once the page is idle, so a first click opens it without
 * waiting for its download. Actions also call `preloadReview` on approach.
 */
export function preloadReviewDialog(): () => void {
  if (typeof requestIdleCallback === 'function') {
    const id = requestIdleCallback(preloadReview, { timeout: 2000 })
    return () => cancelIdleCallback(id)
  }
  const id = setTimeout(preloadReview, 1)
  return () => clearTimeout(id)
}
