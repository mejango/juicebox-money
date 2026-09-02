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
  buildRemoveLiquidityUnlockData,
  retainedFloor,
} from '@/lib/transaction-builders'
import {
  readUserLpPositions,
  resolveMarket,
  type MarketResult,
  type UserLpPosition,
} from './MarketSection'
import { EditPositionPanel } from './EditPositionPanel'
import { MarketEditPanel } from './MarketEditPanel'
import {
  buildCollectMarketFeesUnlockData,
  groupMarketPositions,
  type MarketSides,
  type PositionGroup,
} from '@/lib/market-liquidity'
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
  // The edit panel portals here, BELOW the scroll wrapper — as a table row it
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
          edit, or remove.
        </p>
      ) : null}
    </div>
  )
}

/**
 * One chain's row group in the spanning positions table: the wallet's
 * positions in that chain's pool, each with claim/edit/remove. The edit
 * panel renders below the table, anchored to its position.
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
  /** Where the edit panel renders, below the table's scroll wrapper. */
  panelHost: HTMLDivElement | null
}) {
  const client = usePublicClient({ chainId }) as PublicClient | undefined
  const { address, connectedAddress, isViewAs } = useViewedAccount()
  const tx = useSafeTx(chainId)
  const [error, setError] = useState<string | null>(null)
  const [reviewing, setReviewing] = useState<bigint | null>(null)
  // The position whose holdings/band are being edited in the panel below, or
  // the market (two sides) being edited or removed.
  const [editing, setEditing] = useState<UserLpPosition | null>(null)
  const [editingMarket, setEditingMarket] = useState<{
    sides: MarketSides
    startEmpty: boolean
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

  const claim = (positions: UserLpPosition[]) => {
    if (!connectedAddress || !pool || !positionManager) return
    setError(null)
    const unlockData =
      positions.length === 1
        ? unlockDataOf(
            buildCollectUniswapV4FeesTx({
              positionManager,
              tokenId: positions[0].tokenId,
              currency0: pool.key.currency0,
              currency1: pool.key.currency1,
              recipient: connectedAddress,
              deadline: swapDeadline(tx.isSafe),
            }).data,
          )
        : buildCollectMarketFeesUnlockData(
            pool,
            positions.map(position => position.tokenId),
            connectedAddress,
          )
    tx.send(
      buildModifyLiquiditiesRequest({
        chainId,
        positionManager,
        unlockData,
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

  if (!address) return null

  const chainCell = (
    <td className="whitespace-nowrap py-2 pr-3">
      {/* Inline so the auto table layout measures the icon + name; a block flex
          container here reports no min width and the next column overlaps it. */}
      <span className="inline-flex items-center gap-2 text-xs text-smoke-700">
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

  const groups = groupMarketPositions(pool, summary.positions)
  const anyBusy =
    tx.busy || reviewing !== null || editing !== null || editingMarket !== null || isViewAs

  const renderSingle = (position: UserLpPosition) => {
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
                  onClick={() => claim([position])}
                >
                  Claim fees
                </button>
                <button
                  type="button"
                  className="btn-secondary min-h-[32px] px-3 text-xs"
                  disabled={
                    tx.busy || reviewing !== null || editing !== null || editingMarket !== null || isViewAs
                  }
                  onClick={() => {
                    setError(null)
                    setEditing(position)
                  }}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="btn-secondary min-h-[32px] px-3 text-xs"
                  disabled={
                    tx.busy || reviewing !== null || editing !== null || editingMarket !== null || isViewAs
                  }
                  onClick={() => void remove(position)}
                >
                  {reviewing === position.tokenId ? 'Refreshing…' : 'Remove'}
                </button>
              </span>
            </td>
          </tr>
        )
  }

  // A market: two positions that meet at the price. Holdings and fees are the
  // two sides added up; every action covers both.
  const renderMarket = (group: Extract<PositionGroup, { kind: 'market' }>) => {
    const sides = [group.tokenSide, group.pairSide]
    const owedSides = sides.map(side => summary.feesByToken[side.tokenId.toString()])
    const feesKnown = owedSides.every(owed => owed !== undefined)
    const feesUsable = owedSides.every(owed => !!owed)
    const owedToken = owedSides.reduce((sum, owed) => sum + (owed?.tokenFees ?? 0n), 0n)
    const owedPair = owedSides.reduce((sum, owed) => sum + (owed?.pairFees ?? 0n), 0n)
    const nothingOwed = !feesUsable || (owedToken <= 0n && owedPair <= 0n)
    const tokenHeld = sides.reduce((sum, side) => sum + side.tokenAmount, 0n)
    const pairHeld = sides.reduce((sum, side) => sum + side.pairAmount, 0n)
    const lifetimeKnown = feesUsable && sides.every(side => side.claimedPairFees !== undefined)
    const lifetimeToken = lifetimeKnown
      ? sides.reduce((sum, side) => sum + side.claimedTokenFees!, 0n) + owedToken
      : 0n
    const lifetimePair = lifetimeKnown
      ? sides.reduce((sum, side) => sum + side.claimedPairFees!, 0n) + owedPair
      : 0n
    return (
      <tr
        key={`market:${group.tokenSide.tokenId.toString()}:${group.pairSide.tokenId.toString()}`}
        className="border-t border-smoke-100 align-top"
      >
        {chainCell}
        <td className="whitespace-nowrap py-2 pr-3 font-mono text-xs text-ink">
          Market
          <span className="block text-smoke-500">
            #{group.tokenSide.tokenId.toString()} · #{group.pairSide.tokenId.toString()}
          </span>
        </td>
        <td className="whitespace-nowrap py-2 pr-3 text-right text-smoke-700">
          {formatTokenAmount(tokenHeld, 18)} {sym}
          <span className="block text-xs text-smoke-500">
            {formatTokenAmount(pairHeld, pool.pair.decimals)} {pool.pair.symbol}
          </span>
        </td>
        <td className="whitespace-nowrap py-2 pr-3 text-right text-smoke-700">
          {!feesKnown ? (
            <span className="text-smoke-500">Reading…</span>
          ) : !feesUsable ? (
            <span className="text-smoke-500">Unavailable</span>
          ) : nothingOwed ? (
            <span className="text-smoke-500">None yet</span>
          ) : (
            <>
              {formatTokenAmount(owedToken, 18)} {sym}
              <span className="block text-xs text-smoke-500">
                {formatTokenAmount(owedPair, pool.pair.decimals)} {pool.pair.symbol}
              </span>
            </>
          )}
        </td>
        <td className="whitespace-nowrap py-2 pr-3 text-right text-smoke-700">
          {!lifetimeKnown ? (
            <span className="text-smoke-500">—</span>
          ) : lifetimeToken <= 0n && lifetimePair <= 0n ? (
            <span className="text-smoke-500">None yet</span>
          ) : (
            <>
              {formatTokenAmount(lifetimeToken, 18)} {sym}
              <span className="block text-xs text-smoke-500">
                {formatTokenAmount(lifetimePair, pool.pair.decimals)} {pool.pair.symbol}
              </span>
            </>
          )}
        </td>
        <td className="whitespace-nowrap py-2 text-right">
          <span className="inline-flex gap-2">
            <button
              type="button"
              className="btn-secondary min-h-[32px] px-3 text-xs"
              disabled={anyBusy || nothingOwed}
              onClick={() => claim(sides)}
            >
              Claim fees
            </button>
            <button
              type="button"
              className="btn-secondary min-h-[32px] px-3 text-xs"
              disabled={anyBusy}
              onClick={() => {
                setError(null)
                setEditingMarket({ sides: group, startEmpty: false })
              }}
            >
              Edit
            </button>
            <button
              type="button"
              className="btn-secondary min-h-[32px] px-3 text-xs"
              disabled={anyBusy}
              onClick={() => {
                setError(null)
                setEditingMarket({ sides: group, startEmpty: true })
              }}
            >
              Remove
            </button>
          </span>
        </td>
      </tr>
    )
  }

  return (
    <>
      {groups.map(group =>
        group.kind === 'single' ? renderSingle(group.position) : renderMarket(group),
      )}
      {/* The panel lives OUTSIDE the scroll wrapper — as a table row it would
          inherit the table's full scrollable width and blow the modal out. */}
      {panelHost && editingMarket && pool
        ? ReactDOM.createPortal(
            <MarketEditPanel
              key={`${editingMarket.sides.tokenSide?.tokenId ?? '-'}:${editingMarket.sides.pairSide?.tokenId ?? '-'}`}
              chainId={chainId}
              projectId={projectId}
              pool={pool}
              positionManager={positionManager}
              sides={editingMarket.sides}
              sym={sym}
              floor={floor ?? null}
              startEmpty={editingMarket.startEmpty}
              onClose={() => setEditingMarket(null)}
              onDone={() => refresh()}
            />,
            panelHost,
          )
        : null}
      {panelHost && editing && pool
        ? ReactDOM.createPortal(
            <EditPositionPanel
              key={editing.tokenId.toString()}
              chainId={chainId}
              projectId={projectId}
              pool={pool}
              positionManager={positionManager}
              position={editing}
              sym={sym}
              floor={floor ?? null}
              onClose={() => setEditing(null)}
              onDone={() => refresh()}
            />,
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
