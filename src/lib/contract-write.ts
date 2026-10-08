import { submitReviewedContractWrite as submitReviewed } from '@bananapus/nana-sdk-core/review'
import type { Address } from 'viem'
import { assertNoViewAs } from '@/lib/viewAs'
import { captureWalletContext } from '@/lib/wallet-context'
import { isSafeConnection } from '@/lib/safe-connector'
import { wagmiConfig } from '@/providers/Providers'

export const REVIEWED_ACCOUNT_CHANGED = 'The connected account changed. Review again.'

/**
 * A request is built for the account that reviewed it (its beneficiary,
 * holder or recipient), so no other connected account may send it. The
 * Permit2 signature, the Safe batch and the Pay panel check it here; a
 * reviewed write leaves it to the SDK.
 */
export function assertReviewedAccountConnected(
  reviewed: Address,
  connected: Address | undefined,
  message = REVIEWED_ACCOUNT_CHANGED,
): void {
  if (connected?.toLowerCase() !== reviewed.toLowerCase()) throw new Error(message)
}

/**
 * The SDK's reviewed write, refused while the site is viewing as another
 * account. A request is built for the account that reviewed it, so the SDK
 * refuses any connected account other than `expectedAccount` before the
 * review opens and at each step after it up to signing, in these words
 * unless a flow names its own.
 */
export const submitReviewedContractWrite: typeof submitReviewed = options => {
  const assertWalletContext = captureWalletContext(wagmiConfig, {
    account: options.expectedAccount, chainId: options.request.chainId,
  })
  const viaSafe = isSafeConnection(wagmiConfig)
  return submitReviewed({
    ...options,
    accountChangedError: options.accountChangedError ?? REVIEWED_ACCOUNT_CHANGED,
    guard: assertNoViewAs,
    beforeSend: () => {
      options.beforeSend?.()
      assertWalletContext()
      if (isSafeConnection(wagmiConfig) !== viaSafe) {
        throw new Error('Wallet connection changed. Review the transaction again.')
      }
    },
  })
}
