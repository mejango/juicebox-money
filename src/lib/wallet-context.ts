'use client'

import { getAccount, type Config } from '@wagmi/core'
import type { Address } from 'viem'
import { REVIEWED_ACCOUNT_CHANGED_LINE, ReviewLineError } from '@bananapus/nana-sdk-core/review'
import { isSafeConnection } from '@/lib/safe-connector'
import { getViewAs, VIEW_AS_WRITE_BLOCKED } from '@/lib/viewAs'

/**
 * A request is built for the account that reviewed it (its beneficiary,
 * holder or recipient), so no other connected account may send it. The Pay
 * panel and the Safe batch check it here; a reviewed run checks it itself.
 */
export function assertReviewedAccountConnected(
  reviewed: Address,
  connected: Address | undefined,
  message = REVIEWED_ACCOUNT_CHANGED_LINE,
): void {
  if (connected?.toLowerCase() !== reviewed.toLowerCase()) throw new ReviewLineError(message)
}

/** Capture the reviewed execution route before preparation; check live authority
 * synchronously after the last await, immediately before signing or sending. */
export function captureWalletContext(
  config: Config,
  { account, chainId, message = 'Connected wallet changed. Review the transaction again.' }: {
    account: Address | undefined
    chainId: number
    message?: string
  },
): () => void {
  const viaSafe = isSafeConnection(config)
  return () => {
    if (getViewAs()) throw new ReviewLineError(VIEW_AS_WRITE_BLOCKED)
    const live = getAccount(config)
    if (!account || !live.address || live.address.toLowerCase() !== account.toLowerCase() ||
        live.chainId !== chainId || isSafeConnection(config) !== viaSafe) {
      throw new ReviewLineError(message)
    }
  }
}
