import { getAccount, getPublicClient, getWalletClient, switchChain } from '@wagmi/core'
import type { PublicClient } from 'viem'
import {
  viemWalletAdapter,
  type ReviewedAction,
  type ReviewedSendDeps,
} from '@bananapus/nana-sdk-core/review'
import { isSafeConnection } from '@/lib/safe-connector'
import { assertNoViewAs } from '@/lib/viewAs'
import { writeHolds } from '@/lib/write-holds'
import { loadReviewEngine } from '@/lib/preload-review'
import { wagmiConfig } from '@/providers/Providers'

/** jbm's wallet, chains and write hold, as core's reviewed send takes them. */
export const reviewedSendDeps: ReviewedSendDeps = {
  adapter: viemWalletAdapter({
    walletClient: () => getWalletClient(wagmiConfig),
    account: () => getAccount(wagmiConfig).address,
    chainId: () => getAccount(wagmiConfig).chainId,
    isSafe: () => isSafeConnection(wagmiConfig),
    switchChain: target => switchChain(wagmiConfig, { chainId: target as never }),
  }),
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
  return sendReviewed({ ...action, guard: assertNoViewAs }, reviewedSendDeps)
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
): Promise<{ calls: Call[]; saved: boolean; scope?: string; held?: number }> {
  const engine = await loadReviewEngine()
  const unfinished = engine.findReviewedSequence(scope, account)
  const fresh = { calls, saved: false, ...(calls.length > 1 ? { scope } : {}) }
  if (!unfinished) return fresh
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
