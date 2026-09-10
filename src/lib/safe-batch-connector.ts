'use client'

import { sendCalls } from 'wagmi/actions'
import { isHex, size, type Abi, type Address, type Hex, type PublicClient } from 'viem'
import type { JBChainId } from '@bananapus/nana-sdk-core'
import { wagmiConfig } from '@/providers/Providers'
import { waitForTrackedReceipt } from '@/lib/receipt'
import type { BatchCall } from '@/lib/safe-batch'
import { SAFE_NONCE_GUIDANCE, waitForSafeExecutionHash } from '@/lib/safe-connector'
import { requireTransactionReview } from '@/lib/transaction-review'
import { simulateStateChangingTransaction } from '@/lib/transaction-simulation'
import { chainName } from '@/lib/urn'
import { assertNoViewAs } from '@/lib/viewAs'
import { connectedWallet, publicClient } from '@/lib/wallet-core'

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

function revertDetail(error: unknown): string {
  if (error instanceof Error && 'shortMessage' in error && typeof error.shortMessage === 'string') {
    return error.shortMessage
  }
  return error instanceof Error ? error.message.split('\n')[0] : 'The call would revert.'
}

/** True when the node reports that `eth_simulateV1` itself is unavailable, not that a call reverted. */
function simulationUnsupported(error: unknown): boolean {
  const cause = error as { code?: number; message?: string } | null
  return (
    cause?.code === -32601 ||
    cause?.code === -32004 ||
    /not (?:allowed|supported|found|implemented)|unsupported|does not exist/i.test(
      cause?.message ?? '',
    )
  )
}

/**
 * Prove the whole sequence from `from` before anything is signed:
 * `eth_simulateV1` runs the calls in order against one state; where a node
 * lacks it, each call that does not depend on an earlier one is simulated on
 * its own and the dependent ones are left to Safe's own batch simulation.
 */
export async function simulateCallSequence(
  client: PublicClient,
  from: Address,
  chainId: JBChainId,
  calls: readonly SequenceCall[],
): Promise<void> {
  const plain = calls.map(call => ({ to: call.to, data: call.data, value: call.value }))
  let sequence: { status: string; error?: unknown }[] | null = null
  try {
    const simulated = await client.simulateCalls({ account: from, calls: plain })
    sequence = simulated.results.map(result =>
      result.status === 'failure'
        ? { status: 'failure', error: result.error }
        : { status: result.status },
    )
  } catch (error) {
    if (!simulationUnsupported(error)) {
      throw new Error(
        `The batch could not be simulated on ${chainName(chainId)}: ${revertDetail(error)}`,
      )
    }
    sequence = null
  }
  for (const [index, call] of calls.entries()) {
    if (sequence) {
      const result = sequence[index]
      if (result?.status === 'success') continue
      throw new Error(
        `${call.label} cannot run on ${chainName(chainId)}: ${
          result?.status === 'failure' ? revertDetail(result.error) : 'The call would revert.'
        }`,
      )
    }
    if (call.dependsOnPrior) continue
    try {
      await simulateStateChangingTransaction(client, {
        from,
        to: call.to,
        data: call.data,
        value: call.value,
      })
    } catch (error) {
      throw new Error(`${call.label} cannot run on ${chainName(chainId)}: ${revertDetail(error)}`)
    }
  }
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
  const client = publicClient(chainId)
  await simulateCallSequence(client, safe, chainId, calls)
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
  if (!awaitExecution) return { safeTxHash, executionHash: null }
  const executionHash = await waitForSafeExecutionHash(chainId, safeTxHash)
  const receipt = await waitForTrackedReceipt(client, executionHash)
  if (receipt.status !== 'success') {
    throw new Error('The batch reverted after Safe execution.')
  }
  return { safeTxHash, executionHash }
}
