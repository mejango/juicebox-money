import type { BsRevnetPriceHistory } from '@/lib/bendystraw'
import type { BsPoolLiquidityEvent } from '@/lib/lp-positions-queries'
import {
  getAmountsForLiquidity,
  poolPriceFromSqrt,
  sqrtAtTick,
} from '@/lib/uniswap-v4'

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
 * Turn exact post-trade spots into a calmer display series without inventing
 * prices. Each bucket is the time-weighted average of the spot that was in
 * force during that bucket, so a price that lasted for seconds has less visual
 * weight than one that held for days. The exact opening and latest values stay
 * pinned to the ends of the line.
 */
export function smoothPriceSeries(
  points: PricePoint[],
  maxBuckets = 96,
): PricePoint[] {
  const sorted = points
    .filter(
      point =>
        Number.isFinite(point.timestamp) &&
        Number.isFinite(point.value) &&
        point.value > 0,
    )
    .sort((a, b) => a.timestamp - b.timestamp)
    .reduce<PricePoint[]>((deduped, point) => {
      if (deduped.at(-1)?.timestamp === point.timestamp) {
        deduped[deduped.length - 1] = point
      }
      else deduped.push(point)
      return deduped
    }, [])

  if (sorted.length < 4 || maxBuckets < 1) return sorted

  const start = sorted[0].timestamp
  const end = sorted.at(-1)!.timestamp
  const duration = end - start
  if (!(duration > 0)) return sorted

  const bucketCount = Math.min(
    maxBuckets,
    Math.max(2, (sorted.length - 1) * 2),
  )
  const bucketWidth = duration / bucketCount
  const smoothed: PricePoint[] = [{ timestamp: start, value: sorted[0].value }]
  let eventIndex = 1
  let currentValue = sorted[0].value

  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    const bucketStart = start + bucket * bucketWidth
    const bucketEnd = bucket === bucketCount - 1
      ? end
      : start + (bucket + 1) * bucketWidth

    while (
      eventIndex < sorted.length &&
      sorted[eventIndex].timestamp <= bucketStart
    ) {
      currentValue = sorted[eventIndex].value
      eventIndex += 1
    }

    let cursor = bucketStart
    let weightedTotal = 0
    let nextIndex = eventIndex
    let bucketValue = currentValue
    while (
      nextIndex < sorted.length &&
      sorted[nextIndex].timestamp < bucketEnd
    ) {
      const event = sorted[nextIndex]
      weightedTotal += bucketValue * (event.timestamp - cursor)
      cursor = event.timestamp
      bucketValue = event.value
      nextIndex += 1
    }
    weightedTotal += bucketValue * (bucketEnd - cursor)
    currentValue = bucketValue
    eventIndex = nextIndex

    smoothed.push({
      timestamp: bucketStart + (bucketEnd - bucketStart) / 2,
      value: weightedTotal / (bucketEnd - bucketStart),
    })
  }

  const latest = sorted.at(-1)!
  smoothed.push({ timestamp: end, value: latest.value })
  return smoothed
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

export type PoolReservePoint = {
  timestamp: number
  /** The pair side, as held, in whole pair tokens. */
  pairValue: number
  /** The token side valued at this point's pool price, in whole pair tokens. */
  tokenValue: number
}

/**
 * Both sides of the pool over time, for the faint bars under the AMM line:
 * every liquidity change replayed in order, with the reserves re-read at each
 * change (at the price the indexer recorded there) and at each trade's exact
 * post-swap price. Values are only ever compared with each other, so they stay
 * in pair-token units and off the chart's axis.
 */
export function poolReservesSeriesFrom({
  history,
  chainId,
  poolId,
  pairDecimals,
  liquidityEvents,
}: {
  history: BsRevnetPriceHistory | undefined
  chainId: number
  poolId: string | null
  pairDecimals: number | null
  liquidityEvents: BsPoolLiquidityEvent[] | null
}): PoolReservePoint[] {
  if (!poolId || pairDecimals === null || !liquidityEvents?.length || !history) {
    return []
  }
  const id = poolId.toLowerCase()
  const pairScale = 10 ** pairDecimals
  const positions = new Map<
    string,
    { lower: bigint; upper: bigint; liquidity: bigint }
  >()

  const reservesAt = (
    timestamp: number,
    sqrtPriceX96: string | null,
    projectTokenIsCurrency0: boolean | null,
  ): PoolReservePoint[] => {
    if (!sqrtPriceX96 || projectTokenIsCurrency0 === null) return []
    try {
      const sqrtP = BigInt(sqrtPriceX96)
      const price = poolPriceFromSqrt(sqrtP, !projectTokenIsCurrency0, pairDecimals)
      if (price === null) return []
      let amount0 = 0n
      let amount1 = 0n
      for (const position of positions.values()) {
        const amounts = getAmountsForLiquidity(
          sqrtP,
          position.lower,
          position.upper,
          position.liquidity,
        )
        amount0 += amounts.amount0
        amount1 += amounts.amount1
      }
      const tokenAmount = projectTokenIsCurrency0 ? amount0 : amount1
      const pairAmount = projectTokenIsCurrency0 ? amount1 : amount0
      return [
        {
          timestamp,
          pairValue: Number(pairAmount) / pairScale,
          tokenValue: (Number(tokenAmount) / 1e18) * price,
        },
      ]
    } catch {
      return []
    }
  }

  // Token ordering is a pool constant; any row that names it will do.
  const projectTokenIsCurrency0 =
    (history.pools ?? []).find(
      pool => pool.chainId === chainId && pool.poolId.toLowerCase() === id,
    )?.projectTokenIsCurrency0 ??
    history.swaps.find(
      swap => swap.chainId === chainId && swap.poolId.toLowerCase() === id,
    )?.projectTokenIsCurrency0 ??
    null

  type Step =
    | { at: number; order: 0; event: BsPoolLiquidityEvent }
    | { at: number; order: 1; sqrtPriceX96: string | null }
  const timeline: Step[] = [
    ...liquidityEvents.map(event => ({
      at: Number(event.timestamp),
      order: 0 as const,
      event,
    })),
    ...(history.pools ?? []).flatMap(pool =>
      pool.chainId !== chainId || pool.poolId.toLowerCase() !== id
        ? []
        : [{ at: Number(pool.timestamp), order: 1 as const, sqrtPriceX96: pool.initialSqrtPriceX96 }],
    ),
    ...history.swaps.flatMap(swap =>
      swap.chainId !== chainId ||
      swap.direction === 'mint' ||
      swap.poolId.toLowerCase() !== id
        ? []
        : [{ at: Number(swap.timestamp), order: 1 as const, sqrtPriceX96: swap.sqrtPriceX96 }],
    ),
  ].sort((a, b) => a.at - b.at || a.order - b.order)

  // A liquidity change in the same second as a trade applies first, so the
  // trade's point already reflects it. Trades before the first change carry nothing.
  const out: PoolReservePoint[] = []
  let seenLiquidity = false
  for (const step of timeline) {
    if (step.order === 0) {
      const liquidity = BigInt(step.event.liquidityAfter)
      if (liquidity > 0n) {
        positions.set(step.event.tokenId, {
          lower: sqrtAtTick(step.event.tickLower),
          upper: sqrtAtTick(step.event.tickUpper),
          liquidity,
        })
      }
      else positions.delete(step.event.tokenId)
      seenLiquidity = true
      out.push(...reservesAt(step.at, step.event.sqrtPriceX96, projectTokenIsCurrency0))
    }
    else if (seenLiquidity) {
      out.push(...reservesAt(step.at, step.sqrtPriceX96, projectTokenIsCurrency0))
    }
  }
  return out
}

/**
 * The reserves resampled onto `count` even buckets across [t0, t1], each
 * taking the last observation at or before its centre — so the bars sit on a
 * regular grid whatever the trade cadence. Buckets before the first
 * observation are omitted rather than drawn empty.
 */
export function bucketPoolReserves(
  points: PoolReservePoint[],
  t0: number,
  t1: number,
  count: number,
): PoolReservePoint[] {
  const sorted = [...points].sort((a, b) => a.timestamp - b.timestamp)
  if (!sorted.length || !(t1 > t0) || count < 1) return []
  const width = (t1 - t0) / count
  const buckets: PoolReservePoint[] = []
  let index = 0
  let current: PoolReservePoint | undefined
  for (let bucket = 0; bucket < count; bucket += 1) {
    const timestamp = t0 + (bucket + 0.5) * width
    while (index < sorted.length && sorted[index].timestamp <= timestamp) {
      current = sorted[index++]
    }
    if (!current) continue
    buckets.push({ ...current, timestamp })
  }
  return buckets
}
