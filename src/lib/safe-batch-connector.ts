'use client'

import { getAccount } from '@wagmi/core'
import { sendCalls } from 'wagmi/actions'
import { isHex, size, type Abi, type Address, type Hex } from 'viem'
import type { JBChainId } from '@bananapus/nana-sdk-core'
import { simulateCallSequence, waitForTrackedReceipt } from '@bananapus/nana-sdk-core/review'
import { wagmiConfig } from '@/providers/Providers'
import type { BatchCall } from '@/lib/safe-batch'
import {
  requireSafeProposalSuccess,
  SAFE_NONCE_GUIDANCE,
  waitForSafeExecutionHash,
} from '@/lib/safe-connector'
import { requireTransactionReview } from '@/lib/transaction-review'
import { chainName } from '@/lib/urn'
import { assertNoViewAs } from '@/lib/viewAs'
import { assertReviewedAccountConnected } from '@/lib/contract-write'
import { connectedWallet, publicClient } from '@/lib/wallet-core'

const SAFE_CONNECTION_CHANGED = 'Safe connection changed. Review this batch again.'

/** One call of an ordered batch, with what the review needs to decode it. */
export type SequenceCall = BatchCall & {
  label: string
  /** Needs an earlier call's effect (an allowance, a hook), so it cannot simulate alone. */
  dependsOnPrior?: boolean
  abi?: Abi
  functionName?: string
  args?: readonly unknown[]
  contractName?: string
}

/**
 * The one raw `sendCalls` site: a Safe app connection maps `wallet_sendCalls`
 * to a single MultiSend proposal, and the returned id is its safeTxHash.
 * The sequence is simulated and every call reviewed first; by default the
 * proposal is then tracked to execution the way single Safe-app authority
 * calls are.
 */
export async function proposeSafeBatch({
  chainId,
  safe,
  calls,
  title,
  awaitExecution = true,
  onProposed,
}: {
  chainId: JBChainId
  safe: Address
  calls: readonly SequenceCall[]
  title: string
  /** False returns as soon as Safe has queued the proposal (a position mint that signers finish later). */
  awaitExecution?: boolean
  /** Runs once the Safe app has queued the proposal, before execution is awaited. */
  onProposed?: (safeTxHash: Hex) => Promise<void> | void
}): Promise<{ safeTxHash: Hex; executionHash: Hex | null }> {
  assertNoViewAs()
  if (!calls.length) throw new Error('A batch needs at least one call.')
  // The batch was reviewed for this Safe: refuse before simulating or
  // reviewing it when the wallet is connected as another account.
  assertReviewedAccountConnected(safe, getAccount(wagmiConfig).address, SAFE_CONNECTION_CHANGED)
  const client = publicClient(chainId)
  await simulateCallSequence(client, { from: safe, calls, chainName: chainName(chainId) })
  await requireTransactionReview({
    title,
    description: `These ${calls.length} calls continue in Safe as one MultiSend proposal, in the displayed order. ${SAFE_NONCE_GUIDANCE}`,
    confirmLabel: 'Agree & propose to Safe',
    calls: calls.map(call => ({
      chainId,
      from: safe,
      to: call.to,
      data: call.data,
      value: call.value,
      label: call.label,
      abi: call.abi,
      functionName: call.functionName,
      args: call.args,
      contractName: call.contractName,
    })),
  })
  await connectedWallet(chainId, {
    expected: safe,
    requireUnchanged: true,
    changedError: SAFE_CONNECTION_CHANGED,
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
  if (!awaitExecution) return { safeTxHash, executionHash: null }
  const executionHash = await waitForSafeExecutionHash(chainId, safeTxHash)
  const receipt = await waitForTrackedReceipt(client, executionHash)
  const failure = 'The batch reverted after Safe execution.'
  if (receipt.status !== 'success') throw new Error(failure)
  await requireSafeProposalSuccess(
    { client, receipt, safe, proposalHash: safeTxHash, calls },
    failure,
  )
  return { safeTxHash, executionHash }
}
