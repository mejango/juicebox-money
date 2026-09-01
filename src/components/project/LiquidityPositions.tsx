'use client'

import {
  buildCollectUniswapV4FeesTx,
  readUniswapV4PositionFees,
} from '@bananapus/nana-sdk-core/v6'
import { JB_CHAINS, type JBChainId } from '@bananapus/nana-sdk-core'
import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useState } from 'react'
import ReactDOM from 'react-dom'
import { decodeFunctionData, type Address, type Hex, type PublicClient } from 'viem'
import { usePublicClient } from 'wagmi'
import { ChainIcon } from '@/components/ChainIcon'
import { chainName } from '@/lib/urn'
import { ErrorNote } from '@/components/ui/TxError'
import { useSafeTx } from '@/hooks/useSafeTx'
import { useViewedAccount } from '@/hooks/useViewedAccount'
import { formatTokenAmount } from '@/lib/format'
import { POSITION_MANAGER_BY_CHAIN } from '@/lib/uniswap-v4'
import { swapDeadline } from '@/lib/safe-connector'
import {
  buildModifyLiquiditiesRequest,
  buildMoveLiquidityUnlockData,
  buildRemoveLiquidityUnlockData,
  retainedFloor,
} from '@/lib/transaction-builders'
import {
  readUserLpPositions,
  resolveMarket,
  type MarketResult,
  type UserLpPosition,
} from './MarketSection'
import { buildMint } from './AddLiquidityFlow'
import { LiquidityRangePreview } from './LiquidityRangePreview'
import { useCashOutFloor } from '@/hooks/useCashOutFloor'
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

/** A position's band on the pair-per-token axis, min < max regardless of
 *  which currency the pool sorts first. */
function bandPrices(pool: Pool, tickLower: number, tickUpper: number) {
  const display = (tick: number) => {
    const raw = Math.pow(1.0001, tick)
    return pool.pairIsC0
      ? Math.pow(10, 18 - pool.pair.decimals) / raw
      : raw * Math.pow(10, 18 - pool.pair.decimals)
  }
  const a = display(tickLower)
  const b = display(tickUpper)
  return { min: Math.min(a, b), max: Math.max(a, b) }
}

/**
 * The connected wallet's own LP positions across every project chain, in one
 * table (the hierarchy juicescan and revnet.money share): Chain | Position |
 * Holdings | Unclaimed fees | Lifetime fees | actions. Each chain contributes
 * its own row group so one slow or failing scan never blanks the others.
 *
 * Fees shown are CLAIMABLE NOW, not lifetime earnings — the pool rewrites a
 * position's fee checkpoint on every collect.
 */
export function LiquidityPositions({
  chains,
  sym,
  onChanged,
}: {
  chains: { chainId: JBChainId; projectId: number }[]
  sym: string
  onChanged?: () => void
}) {
  const { address, isViewAs } = useViewedAccount()
  // Per-chain scan outcomes reported up by the row groups, so the aggregate
  // empty state is knowable without lifting each chain's queries out of them.
  const [scan, setScan] = useState<Record<number, number | 'loading' | 'error'>>({})
  // The move editor portals here, BELOW the scroll wrapper — as a table row it
  // would inherit the table's full scrollable width and blow the modal out.
  const [panelHost, setPanelHost] = useState<HTMLDivElement | null>(null)
  const onStatus = useCallback(
    (chainId: number, status: number | 'loading' | 'error') => {
      setScan(current =>
        current[chainId] === status ? current : { ...current, [chainId]: status },
      )
    },
    [],
  )
  if (!address || !chains.length) return null
  const allEmpty = chains.every(chain => scan[chain.chainId] === 0)

  return (
    <div>
      {allEmpty ? (
        <p className="text-sm text-smoke-500">
          You have no LP positions on any chain.
        </p>
      ) : null}
      {/* Hidden rather than unmounted while empty so the per-chain queries keep
          watching for a position minted elsewhere. */}
      <div className={allEmpty ? 'hidden' : 'overflow-x-auto'}>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-smoke-500">
              <th className="py-1.5 pr-3 font-normal">Chain</th>
              <th className="py-1.5 pr-3 font-normal">Position</th>
              <th className="py-1.5 pr-3 text-right font-normal">Holdings</th>
              <th className="py-1.5 pr-3 text-right font-normal">Unclaimed fees</th>
              <th className="py-1.5 pr-3 text-right font-normal">Lifetime fees</th>
              <th className="py-1.5 font-normal" />
            </tr>
          </thead>
          <tbody>
            {chains.map(chain => (
              <ChainLpRows
                key={chain.chainId}
                chainId={chain.chainId}
                projectId={chain.projectId}
                sym={sym}
                onChanged={onChanged}
                onStatus={onStatus}
                panelHost={panelHost}
              />
            ))}
          </tbody>
        </table>
      </div>
      <div ref={setPanelHost} className="min-w-0" />
      {isViewAs ? (
        <p className="mt-2 text-xs text-smoke-500">
          You&apos;re viewing another account — connect as its owner to claim,
          move, or remove.
        </p>
      ) : null}
    </div>
  )
}

/**
 * One chain's row group in the spanning positions table: the wallet's
 * positions in that chain's pool, each with claim/move/remove. The move
 * editor renders as a full-width row anchored under its position.
 */
function ChainLpRows({
  chainId,
  projectId,
  sym,
  onChanged,
  onStatus,
  panelHost,
}: {
  chainId: JBChainId
  projectId: number
  sym: string
  onChanged?: () => void
  onStatus: (chainId: number, status: number | 'loading' | 'error') => void
  /** Where the move editor renders, below the table's scroll wrapper. */
  panelHost: HTMLDivElement | null
}) {
  const client = usePublicClient({ chainId }) as PublicClient | undefined
  const { address, connectedAddress, isViewAs } = useViewedAccount()
  const tx = useSafeTx(chainId)
  const [error, setError] = useState<string | null>(null)
  const [reviewing, setReviewing] = useState<bigint | null>(null)
  // The band-move editor: which position is being re-banded and its editable
  // range (pair-per-token), seeded from the position's current ticks.
  const [moving, setMoving] = useState<{
    tokenId: bigint
    minText: string
    maxText: string
  } | null>(null)
  const summary = useUserLpSummary(chainId, projectId, address)
  const { pool, positionManager } = summary
  const { data: floor } = useCashOutFloor(chainId, projectId, !!pool)

  useEffect(() => {
    onStatus(
      chainId,
      summary.isLoading
        ? 'loading'
        : summary.isError
          ? 'error'
          : summary.positions.length,
    )
  }, [chainId, onStatus, summary.isLoading, summary.isError, summary.positions.length])

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
      // The POOL has to be re-read too, not just the position. `pairAmount`/`tokenAmount` are
      // derived from `pool.sqrtP`, and this `pool` comes from the cached ['market', …] query
      // (60s staleTime, PERSIST revalidate tier — worst case restored from a previous
      // session). Refreshing liquidity against a stale price still yields stale amounts, and
      // those become the reviewed 95% minimum: too high reverts at simulation, too low gives
      // weaker sandwich protection than the number on screen says.
      const freshMarket = await resolveMarket(
        client,
        chainId,
        projectId,
        JB_CHAINS[chainId]?.nativeTokenSymbol ?? 'ETH',
      )
      if (freshMarket.status !== 'pool' || freshMarket.poolId !== pool.poolId) {
        throw new Error('The pool changed while this list was open. Reopen it and try again.')
      }
      const fresh = (
        await readUserLpPositions(client, chainId, freshMarket, connectedAddress)
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

  // One-transaction band move: re-read the pool and position (same staleness
  // rules as `remove` — the reviewed floors and mint sizing must come from
  // live amounts), size the mint inside the burn's proceeds with 1% drift
  // headroom so the credit always covers it, and send the composed unlock.
  const move = async () => {
    if (!moving || !connectedAddress || !client || !pool || !positionManager) return
    setError(null)
    setReviewing(moving.tokenId)
    try {
      const pa = Number(moving.minText)
      const pb = Number(moving.maxText)
      if (!(pa > 0) || !(pb > pa)) throw new Error('Set a valid positive price range.')
      const freshMarket = await resolveMarket(
        client,
        chainId,
        projectId,
        JB_CHAINS[chainId]?.nativeTokenSymbol ?? 'ETH',
      )
      if (freshMarket.status !== 'pool' || freshMarket.poolId !== pool.poolId) {
        throw new Error('The pool changed while this list was open. Reopen it and try again.')
      }
      const fresh = (
        await readUserLpPositions(client, chainId, freshMarket, connectedAddress)
      ).find(p => p.tokenId === moving.tokenId)
      if (!fresh) throw new Error('This position is no longer owned by your wallet.')
      const shave = (amount: bigint) => amount - amount / 100n
      const mint = buildMint({
        pool: freshMarket,
        pairAmount: shave(fresh.pairAmount),
        tokenAmount: shave(fresh.tokenAmount),
        pa,
        pb,
        account: connectedAddress,
      })
      const pairMin = retainedFloor(fresh.pairAmount)
      const tokenMin = retainedFloor(fresh.tokenAmount)
      tx.send(
        buildModifyLiquiditiesRequest({
          chainId,
          positionManager,
          unlockData: buildMoveLiquidityUnlockData({
            tokenId: fresh.tokenId,
            currency0: pool.key.currency0,
            currency1: pool.key.currency1,
            amount0Min: pool.pairIsC0 ? pairMin : tokenMin,
            amount1Min: pool.pairIsC0 ? tokenMin : pairMin,
            mintUnlockData: mint.unlockData,
          }),
          deadline: swapDeadline(tx.isSafe),
          value: 0n,
        }),
      )
      setMoving(null)
      refresh()
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Could not move this position.',
      )
    } finally {
      setReviewing(null)
    }
  }

  if (!address) return null

  const chainCell = (
    <td className="whitespace-nowrap py-2 pr-3">
      <span className="flex items-center gap-2 text-xs text-smoke-700">
        <ChainIcon chainId={chainId} size={16} />
        {chainName(chainId)}
      </span>
    </td>
  )

  if (summary.isLoading) {
    return (
      <tr className="border-t border-smoke-100">
        {chainCell}
        <td colSpan={5} className="py-2 text-xs text-smoke-500">
          Reading your positions…
        </td>
      </tr>
    )
  }
  // An incomplete log scan must not read as "you have no positions".
  if (summary.isError) {
    return (
      <tr className="border-t border-smoke-100">
        {chainCell}
        <td colSpan={5} className="py-2 text-xs text-red-700">
          Could not verify the complete position history — nothing has been
          hidden as an empty result.
        </td>
      </tr>
    )
  }
  if (!pool || !positionManager || !summary.positions.length) return null

  return (
    <>
      {summary.positions.map(position => {
        const owed = summary.feesByToken[position.tokenId.toString()]
        const nothingOwed =
          !owed || (owed.pairFees <= 0n && owed.tokenFees <= 0n)
        return (
          <tr
            key={position.tokenId.toString()}
            className="border-t border-smoke-100 align-top"
          >
            {chainCell}
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
                  disabled={
                    tx.busy || reviewing !== null || moving !== null || isViewAs
                  }
                  onClick={() => {
                    const band = bandPrices(
                      pool,
                      position.tickLower,
                      position.tickUpper,
                    )
                    setMoving({
                      tokenId: position.tokenId,
                      minText: String(Number(band.min.toPrecision(6))),
                      maxText: String(Number(band.max.toPrecision(6))),
                    })
                  }}
                >
                  Move
                </button>
                <button
                  type="button"
                  className="btn-secondary min-h-[32px] px-3 text-xs"
                  disabled={
                    tx.busy || reviewing !== null || moving !== null || isViewAs
                  }
                  onClick={() => void remove(position)}
                >
                  {reviewing === position.tokenId ? 'Refreshing…' : 'Remove'}
                </button>
              </span>
            </td>
          </tr>
        )
      })}
      {/* The editor lives OUTSIDE the scroll wrapper — as a table row it would
          inherit the table's full scrollable width and blow the modal out. */}
      {panelHost && moving && pool
        ? ReactDOM.createPortal(
            <div className="mt-3 border border-smoke-200 p-3">
              <p className="text-xs font-medium text-ink">
                Move position #{moving.tokenId.toString()} on {chainName(chainId)} to a new
                price band
              </p>
              <p className="mt-1 text-xs text-smoke-500">
                The position is burned and everything it holds is re-minted into the new
                band, all in one transaction. Unclaimed fees and anything the new band
                doesn&apos;t use return to your wallet. If prices shift too much before it
                lands, the whole move cancels itself and the position stays untouched.
              </p>
              <LiquidityRangePreview
                floor={floor ?? null}
                ceiling={pool.issuance ?? null}
                current={pool.price}
                minimum={Number(moving.minText) || 0}
                maximum={Number(moving.maxText) || 0}
                pairSymbol={pool.pair.symbol}
                tokenSymbol={sym}
                onRangeChange={
                  tx.busy
                    ? undefined
                    : (edge, value) =>
                        setMoving(current =>
                          current
                            ? {
                                ...current,
                                [edge === 'min' ? 'minText' : 'maxText']: String(value),
                              }
                            : current,
                        )
                }
              />
              <div className="mt-2 grid grid-cols-2 gap-2">
                <label className="text-xs text-smoke-500">
                  Min price
                  <input
                    className="input-well mt-1 min-h-[40px] w-full px-3 text-sm"
                    type="number"
                    min="0"
                    value={moving.minText}
                    disabled={tx.busy}
                    onChange={event =>
                      setMoving(current =>
                        current ? { ...current, minText: event.target.value } : current,
                      )
                    }
                  />
                </label>
                <label className="text-xs text-smoke-500">
                  Max price
                  <input
                    className="input-well mt-1 min-h-[40px] w-full px-3 text-sm"
                    type="number"
                    min="0"
                    value={moving.maxText}
                    disabled={tx.busy}
                    onChange={event =>
                      setMoving(current =>
                        current ? { ...current, maxText: event.target.value } : current,
                      )
                    }
                  />
                </label>
              </div>
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  className="btn-primary min-h-[32px] px-3 text-xs"
                  disabled={tx.busy || reviewing !== null || isViewAs}
                  onClick={() => void move()}
                >
                  {reviewing === moving.tokenId ? 'Refreshing…' : 'Move liquidity'}
                </button>
                <button
                  type="button"
                  className="btn-secondary min-h-[32px] px-3 text-xs"
                  disabled={tx.busy}
                  onClick={() => setMoving(null)}
                >
                  Cancel
                </button>
              </div>
            </div>,
            panelHost,
          )
        : null}
      {panelHost && (error ?? tx.error)
        ? ReactDOM.createPortal(
            <div className="mt-2">
              <ErrorNote message={error ?? tx.error!} />
            </div>,
            panelHost,
          )
        : null}
    </>
  )
}
