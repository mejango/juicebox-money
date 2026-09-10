'use client'

import { sendCalls } from 'wagmi/actions'
import { isHex, size, type Address, type Hex } from 'viem'
import type { JBChainId } from '@bananapus/nana-sdk-core'
import { wagmiConfig } from '@/providers/Providers'
import { waitForTrackedReceipt } from '@/lib/receipt'
import type { BatchCall } from '@/lib/safe-batch'
import { SAFE_NONCE_GUIDANCE, waitForSafeExecutionHash } from '@/lib/safe-connector'
import {
  requireTransactionReview,
  type TransactionReviewCall,
} from '@/lib/transaction-review'
import { assertNoViewAs } from '@/lib/viewAs'
import { connectedWallet, publicClient } from '@/lib/wallet-core'

/**
 * The one raw `sendCalls` site: a Safe app connection maps `wallet_sendCalls`
 * to a single MultiSend proposal, and the returned id is its safeTxHash.
 * Every call is reviewed first, then the proposal is tracked to execution the
 * way single Safe-app authority calls are.
 */
export async function proposeSafeBatch({
  chainId,
  safe,
  calls,
  reviewCalls,
  title,
  onProposed,
}: {
  chainId: JBChainId
  safe: Address
  calls: readonly BatchCall[]
  reviewCalls: readonly TransactionReviewCall[]
  title: string
  /** Runs once the Safe app has queued the proposal, before execution is awaited. */
  onProposed?: (safeTxHash: Hex) => Promise<void> | void
}): Promise<{ safeTxHash: Hex; executionHash: Hex }> {
  assertNoViewAs()
  if (!calls.length) throw new Error('A batch needs at least one call.')
  await requireTransactionReview({
    title,
    description: `These ${calls.length} calls continue in Safe as one MultiSend proposal, in the displayed order. ${SAFE_NONCE_GUIDANCE}`,
    confirmLabel: 'Agree & propose to Safe',
    calls: reviewCalls,
  })
  await connectedWallet(chainId, {
    expected: safe,
    requireUnchanged: true,
    changedError: 'Safe connection changed. Review this batch again.',
  })
  const { id } = await sendCalls(wagmiConfig, {
    chainId,
    calls: calls.map(call => ({
      to: call.to,
      data: call.data,
      value: call.value,
    })),
  })
  if (!isHex(id) || size(id) !== 32) {
    throw new Error('Safe did not return a proposal hash for this batch.')
  }
  const safeTxHash: Hex = id
  await onProposed?.(safeTxHash)
  const executionHash = await waitForSafeExecutionHash(chainId, safeTxHash)
  const receipt = await waitForTrackedReceipt(publicClient(chainId), executionHash)
  if (receipt.status !== 'success') {
    throw new Error('The batch reverted after Safe execution.')
  }
  return { safeTxHash, executionHash }
}
