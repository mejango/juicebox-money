import { getPublicClient } from '@wagmi/core'
import type { PublicClient } from 'viem'
import {
  type ReviewedAction,
  type ReviewedCall,
  type ReviewedSendDeps,
} from '@bananapus/nana-sdk-core/review'
import { currentWalletAdapter } from '@/lib/current-wallet'
import { isSafeConnection } from '@/lib/safe-connector'
import { assertNoViewAs } from '@/lib/viewAs'
import { writeHolds } from '@/lib/write-holds'
import { loadReviewEngine } from '@/lib/preload-review'
import { wagmiConfig } from '@/providers/Providers'

/** jbm's wallet, chains and write hold, as core's reviewed send takes them. */
export const reviewedSendDeps: ReviewedSendDeps = {
  adapter: currentWalletAdapter(wagmiConfig, () => isSafeConnection(wagmiConfig)),
  clientFor: target => getPublicClient(wagmiConfig, { chainId: target as never }) as PublicClient,
  hold: writeHolds,
}

/**
 * Core's reviewed send outside a component (a launch's steps), refused while
 * viewing as another account. A component uses `useReviewedAction`.
 */
export async function sendReviewedWrite(action: Omit<ReviewedAction, 'guard'>) {
  // The send engine loads with the write, not with the page.
  const { sendReviewed } = await loadReviewEngine()
  // A step still confirming is followed in the run unless the caller set its own `follow`.
  return sendReviewed({ follow: {}, ...action, guard: assertNoViewAs }, reviewedSendDeps)
}

/** Drop the run saved under `scope` once its last step is proven: nothing of it is left to continue. A step still held keeps it. */
export async function finishSequence(scope: string, account: `0x${string}`, matches?: (calls: readonly ReviewedCall[]) => boolean) {
  const engine = await loadReviewEngine()
  const saved = engine.findReviewedSequence(scope, account)
  if (saved && (!matches || matches(saved.calls))) await engine.discardReviewedSequence(saved).catch(() => {})
}

/** The review's line for a saved action continued as it was reviewed. */
export const SAVED_SEQUENCE_LINE = 'This continues your saved action exactly as you reviewed it. Its remaining steps are below.'

/**
 * The calls a run of a multi-step action sends under `scope`. An earlier run
 * that only completed steps (its approvals) is dropped: the fresh plan reads
 * them from the chain again. One with a step sent or proposed and not yet
 * recorded is never dropped: its saved calls continue as they were reviewed
 * (`saved`), so core settles that step by its hold and sends only what
 * remains, never a completed payment again. A saved run is shown as saved,
 * never under the fresh plan's summary or checks. `scope` is the run's: none
 * for a lone call, which its write hold and the hold's exit decide alone.
 * `held` is the saved step in flight, which the resumed run settles first.
 */
export async function sequenceCalls<Call>(
  scope: string,
  account: `0x${string}`,
  calls: Call[],
  matches?: (saved: readonly ReviewedCall[]) => boolean,
): Promise<{ calls: Call[]; saved: boolean; scope?: string; held?: number }> {
  const engine = await loadReviewEngine()
  const unfinished = engine.findReviewedSequence(scope, account)
  const fresh = { calls, saved: false, ...(calls.length > 1 ? { scope } : {}) }
  // A legacy scope may be shared across chains: match this snapshot before adopting or discarding it.
  if (!unfinished || (matches && !matches(unfinished.calls))) return fresh
  if (!unfinished.sending && !unfinished.proposed) {
    try {
      await engine.discardReviewedSequence(unfinished)
      return fresh
    } catch { /* Another window moved it on: continue it as saved. */ }
  }
  return { calls: unfinished.calls as Call[], saved: true, scope, ...(unfinished.sending ? { held: unfinished.sending.step } : {}) }
}

/** A run's summary and plan checks: a saved run shows only its own line, never the fresh plan's. */
export function planShown<Shown extends object>(saved: boolean, shown: Shown): Shown | { description: string } {
  return saved ? { description: SAVED_SEQUENCE_LINE } : shown
}
