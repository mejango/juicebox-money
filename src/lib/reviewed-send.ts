import { getAccount, getPublicClient, getWalletClient, switchChain } from '@wagmi/core'
import type { PublicClient } from 'viem'
import {
  sendReviewed,
  viemWalletAdapter,
  type ReviewedAction,
  type ReviewedSendDeps,
} from '@bananapus/nana-sdk-core/review'
import { isSafeConnection } from '@/lib/safe-connector'
import { assertNoViewAs } from '@/lib/viewAs'
import { writeHolds } from '@/lib/write-holds'
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
export function sendReviewedWrite(action: Omit<ReviewedAction, 'guard'>) {
  return sendReviewed({ ...action, guard: assertNoViewAs }, reviewedSendDeps)
}
