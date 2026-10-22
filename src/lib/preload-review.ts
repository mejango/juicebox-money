'use client'

/** The send engine; one stable loader so core's mount preload runs once per page. */
export const loadReviewEngine = () => import('@bananapus/nana-sdk-core/review')

/**
 * Fetch the review dialog once the page is idle, so a first click opens the
 * review without waiting for its download. The import cache dedupes repeats.
 */
export function preloadReviewDialog(): () => void {
  const load = () => { void import('@/components/TransactionReviewDialog').catch(() => {}) }
  if (typeof requestIdleCallback === 'function') {
    const id = requestIdleCallback(load, { timeout: 2000 })
    return () => cancelIdleCallback(id)
  }
  const id = setTimeout(load, 1)
  return () => clearTimeout(id)
}
