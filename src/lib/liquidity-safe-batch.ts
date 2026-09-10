'use client'

import type { JBChainId } from '@bananapus/nana-sdk-core'
import { UNISWAP_PERMIT2_ADDRESS } from '@bananapus/nana-sdk-core/v6'
import { encodeFunctionData, type Address, type Hex } from 'viem'
import { wagmiConfig } from '@/providers/Providers'
import { proposeSafeBatch, type SequenceCall } from '@/lib/safe-batch-connector'
import { isSafeConnection, swapDeadline } from '@/lib/safe-connector'
import {
  buildErc20ApproveRequest,
  buildModifyLiquiditiesRequest,
  buildPermit2ApproveRequest,
} from '@/lib/transaction-builders'

/**
 * A Uniswap V4 liquidity plan as one Safe proposal. The LP flows build their
 * step list at review time (ERC-20 → Permit2, Permit2 → PositionManager, then
 * the mint or edit); under a Safe app connection those steps go out as one
 * MultiSend instead of one proposal per step. Every other connection keeps
 * the sequential reviewed `useSafeTx` path.
 */
export type LiquidityStep =
  | { kind: 'approve-erc20'; token: Address; amount: bigint; label: string }
  | {
      kind: 'permit2-approve'
      token: Address
      amount: bigint
      expiration: number
      label: string
    }
  | { kind: 'mint'; label: string }

export function liquidityBatchApplies(steps: readonly LiquidityStep[]): boolean {
  return steps.length > 1 && isSafeConnection(wagmiConfig)
}

export function liquidityBatchIntro(count: number): string {
  return `Goes to your Safe as one batch of ${count} calls: approved once, executed together.`
}

export const LIQUIDITY_BATCH_PROPOSED =
  'Proposed to Safe as one batch. Once its signers approve and it executes, the position shows under Your liquidity.'

/** The plan's calls in order; the mint depends on the allowances ahead of it. */
export function liquidityBatchCalls({
  chainId,
  positionManager,
  steps,
  unlockData,
  value,
}: {
  chainId: JBChainId
  positionManager: Address
  steps: readonly LiquidityStep[]
  unlockData: Hex
  value: bigint
}): SequenceCall[] {
  return steps.map(step => {
    if (step.kind === 'approve-erc20') {
      const request = buildErc20ApproveRequest({
        chainId,
        token: step.token,
        spender: UNISWAP_PERMIT2_ADDRESS,
        amount: step.amount,
      })
      return {
        to: request.address,
        data: encodeFunctionData(request),
        value: 0n,
        label: step.label,
        abi: request.abi,
        functionName: request.functionName,
        args: request.args,
        contractName: 'ERC20',
      }
    }
    if (step.kind === 'permit2-approve') {
      const request = buildPermit2ApproveRequest({
        chainId,
        token: step.token,
        positionManager,
        amount: step.amount,
        expiration: step.expiration,
      })
      return {
        to: request.address,
        data: encodeFunctionData(request),
        value: 0n,
        label: step.label,
        abi: request.abi,
        functionName: request.functionName,
        args: request.args,
        contractName: 'Permit2',
      }
    }
    const request = buildModifyLiquiditiesRequest({
      chainId,
      positionManager,
      unlockData,
      // Signature collection outlives an EOA's 20 minutes; match the 30-day Permit2 windows.
      deadline: swapDeadline(true),
      value,
    })
    return {
      to: request.address,
      data: encodeFunctionData(request),
      value,
      label: step.label,
      dependsOnPrior: true,
      abi: request.abi,
      functionName: request.functionName,
      args: request.args,
      contractName: 'PositionManager',
    }
  })
}

/** Propose the plan as one Safe batch; resolves with the safeTxHash once Safe has queued it. */
export async function proposeLiquidityBatch({
  chainId,
  account,
  positionManager,
  steps,
  unlockData,
  value,
  title,
}: {
  chainId: JBChainId
  account: Address
  positionManager: Address
  steps: readonly LiquidityStep[]
  unlockData: Hex
  value: bigint
  title: string
}): Promise<Hex> {
  const { safeTxHash } = await proposeSafeBatch({
    chainId,
    safe: account,
    calls: liquidityBatchCalls({ chainId, positionManager, steps, unlockData, value }),
    title,
    awaitExecution: false,
  })
  return safeTxHash
}
