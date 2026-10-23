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

/**
 * The calls a fresh run of a multi-step action sends under `scope`. Its steps
 * are read again from the chain, so an earlier run's unsent rest is dropped;
 * while a step of that run is held, its saved calls resume instead, so the
 * step's hold decides it. A caller tells the two apart by identity.
 */
export async function sequenceCalls<Call>(scope: string, account: `0x${string}`, calls: Call[]): Promise<Call[]> {
  const engine = await loadReviewEngine()
  const unfinished = engine.findReviewedSequence(scope, account)
  if (!unfinished) return calls
  try {
    await engine.discardReviewedSequence(unfinished)
    return calls
  } catch {
    return unfinished.calls as Call[]
  }
}
