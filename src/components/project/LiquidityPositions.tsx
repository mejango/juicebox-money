'use client'

import {
  buildCollectUniswapV4FeesTx,
  readUniswapV4PositionFees,
} from '@bananapus/nana-sdk-core/v6'
import { type JBChainId } from '@bananapus/nana-sdk-core'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { decodeFunctionData, type Address, type Hex, type PublicClient } from 'viem'
import { usePublicClient } from 'wagmi'
import { ErrorNote } from '@/components/ui/TxError'
import { useSafeTx } from '@/hooks/useSafeTx'
import { useWallet } from '@/hooks/useWallet'
import { formatTokenAmount } from '@/lib/format'
import { swapDeadline } from '@/lib/safe-connector'
import {
  buildModifyLiquiditiesRequest,
  buildRemoveLiquidityUnlockData,
  retainedFloor,
} from '@/lib/transaction-builders'
import {
  readUserLpPositions,
  type MarketResult,
  type UserLpPosition,
} from './MarketSection'

type Pool = Extract<MarketResult, { status: 'pool' }>

const POSITION_MANAGER_ABI = [
  {
    type: 'function',
    name: 'modifyLiquidities',
    stateMutability: 'payable',
    inputs: [
      { name: 'unlockData', type: 'bytes' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [],
  },
] as const

/** Pull the unlockData back out of an SDK-encoded call so the send path stays
 *  the one reviewed request builder every other LP step uses. */
function unlockDataOf(data: Hex): Hex {
  const call = decodeFunctionData({ abi: POSITION_MANAGER_ABI, data })
  return call.args[0] as Hex
}

/**
 * The connected wallet's own LP positions in this pool: what each holds, what
 * it has earned, and the two things an owner can do with it.
 *
 * Fees shown are CLAIMABLE NOW, not lifetime earnings — the pool rewrites a
 * position's fee checkpoint on every collect.
 */
export function LiquidityPositions({
  chainId,
  pool,
  positionManager,
  sym,
  onChanged,
}: {
  chainId: JBChainId
  pool: Pool
  positionManager: Address
  sym: string
  onChanged?: () => void
}) {
  const client = usePublicClient({ chainId }) as PublicClient | undefined
  const { address } = useWallet()
  const tx = useSafeTx(chainId)
  const [error, setError] = useState<string | null>(null)
  const [reviewing, setReviewing] = useState<bigint | null>(null)

  const positions = useQuery({
    queryKey: ['userLpPositions', chainId, pool.poolId, address?.toLowerCase()],
    enabled: !!client && !!address,
    retry: 0,
    staleTime: 30_000,
    queryFn: () => readUserLpPositions(client!, chainId, pool, address!),
  })

  // Fees are two extra reads per position, so they load beside the list rather
  // than holding it up.
  const fees = useQuery({
    queryKey: [
      'userLpFees',
      chainId,
      pool.poolId,
      (positions.data ?? []).map(p => p.tokenId.toString()).join(','),
    ],
    enabled: !!client && !!positions.data?.length,
    retry: 0,
    staleTime: 30_000,
    queryFn: async () => {
      const entries = await Promise.all(
        (positions.data ?? []).map(async position => {
          const owed = await readUniswapV4PositionFees(client!, {
            chainId,
            poolId: pool.poolId,
            positionManager,
            tokenId: position.tokenId,
            tickLower: position.tickLower,
            tickUpper: position.tickUpper,
          }).catch(() => null)
          if (!owed) return [position.tokenId.toString(), null] as const
          return [
            position.tokenId.toString(),
            {
              pairFees: pool.pairIsC0 ? owed.amount0 : owed.amount1,
              tokenFees: pool.pairIsC0 ? owed.amount1 : owed.amount0,
            },
          ] as const
        }),
      )
      return Object.fromEntries(entries)
    },
  })

  const refresh = () => {
    void positions.refetch()
    void fees.refetch()
    onChanged?.()
  }

  const claim = (position: UserLpPosition) => {
    if (!address) return
    setError(null)
    const collect = buildCollectUniswapV4FeesTx({
      positionManager,
      tokenId: position.tokenId,
      currency0: pool.key.currency0,
      currency1: pool.key.currency1,
      recipient: address,
      deadline: swapDeadline(tx.isSafe),
    })
    tx.send(
      buildModifyLiquiditiesRequest({
        chainId,
        positionManager,
        unlockData: unlockDataOf(collect.data),
        deadline: swapDeadline(tx.isSafe),
        value: 0n,
      }),
    )
    refresh()
  }

  // Re-read the position immediately before building the burn: the list can sit
  // open while the market moves, and a stale amount must never become the
  // reviewed minimum.
  const remove = async (position: UserLpPosition) => {
    if (!address || !client) return
    setError(null)
    setReviewing(position.tokenId)
    try {
      const fresh = (
        await readUserLpPositions(client, chainId, pool, address)
      ).find(p => p.tokenId === position.tokenId)
      if (!fresh) throw new Error('This position is no longer owned by your wallet.')
      const pairMin = retainedFloor(fresh.pairAmount)
      const tokenMin = retainedFloor(fresh.tokenAmount)
      tx.send(
        buildModifyLiquiditiesRequest({
          chainId,
          positionManager,
          unlockData: buildRemoveLiquidityUnlockData({
            tokenId: fresh.tokenId,
            currency0: pool.key.currency0,
            currency1: pool.key.currency1,
            recipient: address,
            amount0Min: pool.pairIsC0 ? pairMin : tokenMin,
            amount1Min: pool.pairIsC0 ? tokenMin : pairMin,
          }),
          deadline: swapDeadline(tx.isSafe),
          value: 0n,
        }),
      )
      refresh()
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Could not remove this position.',
      )
    } finally {
      setReviewing(null)
    }
  }

  if (!address) return null

  return (
    <div className="mt-5 border-t border-smoke-200 pt-4">
      <span className="text-xs font-medium text-smoke-700">Your positions</span>

      {positions.isLoading ? (
        <p className="mt-2 text-sm text-smoke-500">Reading your positions…</p>
      ) : positions.isError ? (
        <p className="mt-2 text-sm text-red-700">
          Could not verify the complete position history — nothing has been hidden
          as an empty result.
        </p>
      ) : !positions.data?.length ? (
        <p className="mt-2 text-sm text-smoke-500">
          You have no LP positions in this pool.
        </p>
      ) : (
        <div className="mt-2 space-y-2">
          {positions.data.map(position => {
            const owed = fees.data?.[position.tokenId.toString()]
            const nothingOwed =
              !owed || (owed.pairFees <= 0n && owed.tokenFees <= 0n)
            return (
              <div
                key={position.tokenId.toString()}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-smoke-200 p-3 text-xs"
              >
                <div className="min-w-0">
                  <p className="font-medium text-ink">
                    #{position.tokenId.toString()}
                  </p>
                  <p className="text-smoke-700">
                    {formatTokenAmount(position.tokenAmount, 18)} {sym} +{' '}
                    {formatTokenAmount(position.pairAmount, pool.pair.decimals)}{' '}
                    {pool.pair.symbol}
                  </p>
                  <p className="text-smoke-500">
                    {fees.isLoading && owed === undefined
                      ? 'unclaimed fees: reading…'
                      : owed === null
                        ? 'unclaimed fees: unavailable on this chain'
                        : nothingOwed
                          ? 'unclaimed fees: none yet'
                          : `unclaimed fees: ${formatTokenAmount(owed.tokenFees, 18)} ${sym} + ${formatTokenAmount(owed.pairFees, pool.pair.decimals)} ${pool.pair.symbol}`}
                  </p>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    className="btn-secondary min-h-[32px] px-3 text-xs"
                    disabled={tx.busy || nothingOwed}
                    onClick={() => claim(position)}
                  >
                    Claim fees
                  </button>
                  <button
                    type="button"
                    className="btn-secondary min-h-[32px] px-3 text-xs"
                    disabled={tx.busy || reviewing !== null}
                    onClick={() => void remove(position)}
                  >
                    {reviewing === position.tokenId ? 'Refreshing…' : 'Remove'}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
      {error ?? tx.error ? <ErrorNote message={error ?? tx.error!} /> : null}
    </div>
  )
}
