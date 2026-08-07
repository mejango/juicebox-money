import type { BsRevnetPriceHistory } from '@/lib/bendystraw'
import { poolPriceFromSqrt } from '@/lib/uniswap-v4'

/**
 * Price observations over time, shared by the Overview price chart and the
 * Market subtab's standalone market chart.
 */

export type PricePoint = {
  timestamp: number
  value: number
  reason?: string
  /**
   * USD per one whole accounting token AT THIS POINT'S BLOCK, when the indexer recorded it.
   * Carried alongside the value so a base-currency axis can convert each point with the rate
   * that was actually in force, instead of scaling the whole series by today's. Undefined
   * where the indexer has not backfilled it — the caller falls back to the live rate.
   */
  rate?: number
}

/**
 * The observations inside [t0, t1], with the last observation before t0 pinned
 * at t0 so a line entering the window starts at its true level, and `live`
 * appended at t1 so it terminates at the on-chain value.
 */
export function visibleSeries(
  points: PricePoint[],
  live: number | null,
  t0: number,
  t1: number,
): PricePoint[] {
  const sorted = points
    .filter(
      point =>
        Number.isFinite(point.timestamp) &&
        Number.isFinite(point.value) &&
        point.value > 0 &&
        point.timestamp <= t1,
    )
    .sort((a, b) => a.timestamp - b.timestamp)

  const before = sorted.filter(point => point.timestamp < t0).at(-1)
  const visible = sorted.filter(
    point => point.timestamp >= t0 && point.timestamp <= t1,
  )
  const out = before
    ? [{ ...before, timestamp: t0 }, ...visible]
    : visible

  if (live && live > 0) {
    const last = out.at(-1)
    if (last?.timestamp === t1) {
      out[out.length - 1] = { ...out[out.length - 1], timestamp: t1, value: live }
    }
    else out.push({ timestamp: t1, value: live })
  }
  return out
}

/**
 * AMM spot prices for one pool: the pool's registration price, then each
 * swap's exact post-trade spot. Rows without sqrtPriceX96 (pre-reindex) fall
 * back to the trade's realized average price. Decimals and prices are only
 * comparable inside one pool, so everything is filtered to `poolId`.
 */
/**
 * The indexer's 18-dec rate as a plain number. Undefined for a row the indexer has not
 * backfilled, and for a null the indexer wrote because no feed bridged the pair — both mean
 * "no rate here", which the caller answers with the live one.
 */
export function usdRateOf(raw: string | null | undefined): number | undefined {
  if (raw === null || raw === undefined) return undefined
  const rate = Number(raw) / 1e18
  return Number.isFinite(rate) && rate > 0 ? rate : undefined
}

export function ammSeriesFrom({
  history,
  chainId,
  poolId,
  pairDecimals,
}: {
  history: BsRevnetPriceHistory | undefined
  chainId: number
  poolId: string | null
  pairDecimals: number | null
}): PricePoint[] {
  if (
    !poolId ||
    pairDecimals === null ||
    (!history?.swaps.length && !history?.pools?.length)
  ) {
    return []
  }

  const id = poolId.toLowerCase()
  const pairScale = 10 ** pairDecimals
  const spotPrice = (
    sqrtPriceX96: string | null,
    projectTokenIsCurrency0: boolean | null,
  ) => {
    if (!sqrtPriceX96 || projectTokenIsCurrency0 === null) return null
    try {
      return poolPriceFromSqrt(
        BigInt(sqrtPriceX96),
        !projectTokenIsCurrency0,
        pairDecimals,
      )
    }
    catch {
      return null
    }
  }

  const initial = (history.pools ?? []).flatMap(pool => {
    if (pool.chainId !== chainId || pool.poolId.toLowerCase() !== id) return []
    const value = spotPrice(pool.initialSqrtPriceX96, pool.projectTokenIsCurrency0)
    return value ? [{ timestamp: Number(pool.timestamp), value }] : []
  })
  const swaps = history.swaps.flatMap(swap => {
    if (
      swap.chainId !== chainId ||
      swap.direction === 'mint' ||
      swap.poolId.toLowerCase() !== id
    ) {
      return []
    }
    try {
      const rate = usdRateOf(swap.accountingTokenUsdRate)
      const spot = spotPrice(swap.sqrtPriceX96, swap.projectTokenIsCurrency0)
      if (spot) return [{ timestamp: Number(swap.timestamp), value: spot, rate }]

      // Compatibility for pre-sqrtPriceX96 rows while Bendystraw reindexes.
      const terminalAmount = Number(BigInt(swap.terminalTokenAmount)) / pairScale
      const projectAmount = Number(BigInt(swap.projectTokenAmount)) / 1e18
      const value = terminalAmount / projectAmount
      return Number.isFinite(value) && value > 0
        ? [{ timestamp: Number(swap.timestamp), value, rate }]
        : []
    } catch {
      return []
    }
  })
  return [...initial, ...swaps].sort((a, b) => a.timestamp - b.timestamp)
}
