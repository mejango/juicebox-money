'use client'

import {
  buildCollectUniswapV4FeesTx,
  readUniswapV4PositionFees,
} from '@bananapus/nana-sdk-core/v6'
import { JB_CHAINS, type JBChainId } from '@bananapus/nana-sdk-core'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { decodeFunctionData, type Address, type Hex, type PublicClient } from 'viem'
import { usePublicClient } from 'wagmi'
import { ErrorNote } from '@/components/ui/TxError'
import { useSafeTx } from '@/hooks/useSafeTx'
import { useViewedAccount } from '@/hooks/useViewedAccount'
import { formatTokenAmount } from '@/lib/format'
import { POSITION_MANAGER_BY_CHAIN } from '@/lib/uniswap-v4'
import { swapDeadline } from '@/lib/safe-connector'
import {
  buildModifyLiquiditiesRequest,
  buildRemoveLiquidityUnlockData,
  retainedFloor,
} from '@/lib/transaction-builders'
import {
  readUserLpPositions,
  resolveMarket,
  type MarketResult,
  type UserLpPosition,
} from './MarketSection'
import { PERSIST } from '@/lib/query-persist'

type Pool = Extract<MarketResult, { status: 'pool' }>

export interface UserLpSummary {
  pool: Pool | null
  positionManager: Address | null
  positions: UserLpPosition[]
  /** Totals across the wallet's positions in this pool. */
  pairFees: bigint
  tokenFees: bigint
  feesByToken: Record<string, { pairFees: bigint; tokenFees: bigint } | null>
  isLoading: boolean
  isError: boolean
  refresh: () => void
}

/**
 * The connected wallet's positions in a project's pool on one chain, with the
 * fees each has accrued. Keyed so the You table and the Market panel share one
 * pool scan rather than each running their own.
 */
export function useUserLpSummary(
  chainId: JBChainId,
  projectId: number,
  holder: Address | undefined,
): UserLpSummary {
  const client = usePublicClient({ chainId }) as PublicClient | undefined
  const nativeSymbol = JB_CHAINS[chainId]?.nativeTokenSymbol ?? 'ETH'
  const positionManager = POSITION_MANAGER_BY_CHAIN[chainId] ?? null

  const market = useQuery({
    queryKey: ['market', chainId, projectId],
    meta: PERSIST,
    enabled: !!client,
    staleTime: 60_000,
    retry: 1,
    queryFn: () => resolveMarket(client!, chainId, projectId, nativeSymbol),
  })
  const pool: Pool | null =
    market.data?.status === 'pool' ? (market.data as Pool) : null

  const positions = useQuery({
    queryKey: ['userLpPositions', chainId, pool?.poolId, holder?.toLowerCase()],
    enabled: !!client && !!pool && !!holder,
    retry: 0,
    staleTime: 30_000,
    queryFn: () => readUserLpPositions(client!, chainId, pool!, holder!),
  })

  const fees = useQuery({
    queryKey: [
      'userLpFees',
      chainId,
      pool?.poolId,
      (positions.data ?? []).map(p => p.tokenId.toString()).join(','),
    ],
    enabled: !!client && !!pool && !!positionManager && !!positions.data?.length,
    retry: 0,
    staleTime: 30_000,
    queryFn: async () => {
      const entries = await Promise.all(
        (positions.data ?? []).map(async position => {
          const owed = await readUniswapV4PositionFees(client!, {
            chainId,
            poolId: pool!.poolId,
            positionManager: positionManager!,
            tokenId: position.tokenId,
            tickLower: position.tickLower,
            tickUpper: position.tickUpper,
          }).catch(() => null)
          if (!owed) return [position.tokenId.toString(), null] as const
          return [
            position.tokenId.toString(),
            {
              pairFees: pool!.pairIsC0 ? owed.amount0 : owed.amount1,
              tokenFees: pool!.pairIsC0 ? owed.amount1 : owed.amount0,
            },
          ] as const
        }),
      )
      return Object.fromEntries(entries)
    },
  })

  const feesByToken = fees.data ?? {}
  let pairFees = 0n
  let tokenFees = 0n
  for (const owed of Object.values(feesByToken)) {
    if (!owed) continue
    pairFees += owed.pairFees
    tokenFees += owed.tokenFees
  }

  return {
    pool,
    positionManager,
    positions: positions.data ?? [],
    pairFees,
    tokenFees,
    feesByToken,
    isLoading: market.isLoading || positions.isLoading,
    isError: positions.isError,
    refresh: () => {
      void positions.refetch()
      void fees.refetch()
    },
  }
}

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
  projectId,
  sym,
  onChanged,
}: {
  chainId: JBChainId
  projectId: number
  sym: string
  onChanged?: () => void
}) {
  const client = usePublicClient({ chainId }) as PublicClient | undefined
  const { address, connectedAddress, isViewAs } = useViewedAccount()
  const tx = useSafeTx(chainId)
  const [error, setError] = useState<string | null>(null)
  const [reviewing, setReviewing] = useState<bigint | null>(null)
  const summary = useUserLpSummary(chainId, projectId, address)
  const { pool, positionManager } = summary

  const refresh = () => {
    summary.refresh()
    onChanged?.()
  }

  const claim = (position: UserLpPosition) => {
    if (!connectedAddress || !pool || !positionManager) return
    setError(null)
    const collect = buildCollectUniswapV4FeesTx({
      positionManager,
      tokenId: position.tokenId,
      currency0: pool.key.currency0,
      currency1: pool.key.currency1,
      recipient: connectedAddress,
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
    if (!connectedAddress || !client || !pool || !positionManager) return
    setError(null)
    setReviewing(position.tokenId)
    try {
      const fresh = (
        await readUserLpPositions(client, chainId, pool, connectedAddress)
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
            recipient: connectedAddress,
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

  if (!address || !pool || !positionManager) return null

  return (
    <div>

      {summary.isLoading ? (
        <p className="text-sm text-smoke-500">Reading your positions…</p>
      ) : summary.isError ? (
        <p className="text-sm text-red-700">
          Could not verify the complete position history — nothing has been hidden
          as an empty result.
        </p>
      ) : !summary.positions.length ? (
        <p className="text-sm text-smoke-500">
          You have no LP positions in this pool.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-smoke-500">
                <th className="py-1.5 pr-3 font-normal">Position</th>
                <th className="py-1.5 pr-3 text-right font-normal">Holdings</th>
                <th className="py-1.5 pr-3 text-right font-normal">Unclaimed fees</th>
                <th className="py-1.5 pr-3 text-right font-normal">Lifetime fees</th>
                <th className="py-1.5 font-normal" />
              </tr>
            </thead>
            <tbody>
              {summary.positions.map(position => {
                const owed = summary.feesByToken[position.tokenId.toString()]
                const nothingOwed =
                  !owed || (owed.pairFees <= 0n && owed.tokenFees <= 0n)
                return (
                  <tr
                    key={position.tokenId.toString()}
                    className="border-t border-smoke-100 align-top"
                  >
                    <td className="whitespace-nowrap py-2 pr-3 font-mono text-xs text-ink">
                      #{position.tokenId.toString()}
                    </td>
                    <td className="whitespace-nowrap py-2 pr-3 text-right text-smoke-700">
                      {formatTokenAmount(position.tokenAmount, 18)} {sym}
                      <span className="block text-xs text-smoke-500">
                        {formatTokenAmount(position.pairAmount, pool.pair.decimals)}{' '}
                        {pool.pair.symbol}
                      </span>
                    </td>
                    <td className="whitespace-nowrap py-2 pr-3 text-right text-smoke-700">
                      {owed === undefined ? (
                        <span className="text-smoke-500">Reading…</span>
                      ) : owed === null ? (
                        <span className="text-smoke-500">Unavailable</span>
                      ) : nothingOwed ? (
                        <span className="text-smoke-500">None yet</span>
                      ) : (
                        <>
                          {formatTokenAmount(owed.tokenFees, 18)} {sym}
                          <span className="block text-xs text-smoke-500">
                            {formatTokenAmount(owed.pairFees, pool.pair.decimals)}{' '}
                            {pool.pair.symbol}
                          </span>
                        </>
                      )}
                    </td>
                    <td className="whitespace-nowrap py-2 pr-3 text-right text-smoke-700">
                      {(() => {
                        // The pool forgets what a position already took, so
                        // lifetime is only knowable where the index has been
                        // accumulating it.
                        if (position.claimedPairFees === undefined || !owed) {
                          return <span className="text-smoke-500">—</span>
                        }
                        const lifetimeToken = position.claimedTokenFees! + owed.tokenFees
                        const lifetimePair = position.claimedPairFees + owed.pairFees
                        if (lifetimeToken <= 0n && lifetimePair <= 0n) {
                          return <span className="text-smoke-500">None yet</span>
                        }
                        return (
                          <>
                            {formatTokenAmount(lifetimeToken, 18)} {sym}
                            <span className="block text-xs text-smoke-500">
                              {formatTokenAmount(lifetimePair, pool.pair.decimals)}{' '}
                              {pool.pair.symbol}
                            </span>
                          </>
                        )
                      })()}
                    </td>
                    <td className="whitespace-nowrap py-2 text-right">
                      <span className="inline-flex gap-2">
                        <button
                          type="button"
                          className="btn-secondary min-h-[32px] px-3 text-xs"
                          disabled={tx.busy || nothingOwed || isViewAs}
                          onClick={() => claim(position)}
                        >
                          Claim fees
                        </button>
                        <button
                          type="button"
                          className="btn-secondary min-h-[32px] px-3 text-xs"
                          disabled={tx.busy || reviewing !== null || isViewAs}
                          onClick={() => void remove(position)}
                        >
                          {reviewing === position.tokenId ? 'Refreshing…' : 'Remove'}
                        </button>
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      {isViewAs ? (
        <p className="mt-2 text-xs text-smoke-500">
          You&apos;re viewing another account — connect as its owner to claim or
          remove.
        </p>
      ) : null}
      {error ?? tx.error ? <ErrorNote message={error ?? tx.error!} /> : null}
    </div>
  )
}
