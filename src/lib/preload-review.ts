'use client'

import type { WalletAdapter } from '@bananapus/nana-sdk-core/review'
import { WalletNotInvokedError } from '@/lib/wallet-refusal'

/** The send engine; one stable loader so core's mount preload runs once per page. */
export const loadReviewEngine = () => import('@bananapus/nana-sdk-core/review').then(core => {
  // SDK cleanup consumes the local unsent marker first. Its React hook must then
  // see the actual refusal line, not reinterpret code 4001 as user cancellation.
  const readable = <Args extends unknown[], Result>(run: (...args: Args) => Promise<Result>) => async (...args: Args) => {
    try { return await run(...args) }
    catch (error) {
      if (!(error instanceof WalletNotInvokedError)) throw error
      throw new WalletNotInvokedError(error.acquisitionCause, false)
    }
  }
  const checked = <Deps extends { adapter: WalletAdapter }>(deps: Deps, check: () => void): Deps => {
    const adapter = deps.adapter as WalletAdapter & { withFinalCheck?: (check: () => void) => WalletAdapter }
    return adapter.withFinalCheck ? { ...deps, adapter: adapter.withFinalCheck(check) } : deps
  }
  const send: typeof core.sendReviewed = (action, deps) => core.sendReviewed(action, checked(deps, () => {
    action.guard?.()
    action.assertWriteState?.()
  }))
  const resume: typeof core.resumeReviewed = (record, action, deps) => core.resumeReviewed(record, action, checked(deps, () => {
    action.guard?.()
    action.assertWriteState?.()
  }))
  return { ...core, sendReviewed: readable(send), resumeReviewed: readable(resume) }
})

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
