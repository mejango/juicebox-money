'use client'

import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import type { BsRevnetPriceHistory } from '@/lib/bendystraw'
import { cachedQuery } from '@/lib/query-persist'
import { ammSeriesFrom, visibleSeries, type PricePoint } from '@/lib/price-series'
import { chartDateLabel, formatPrice } from './chartUtils'
import { ChartRangeButton } from './StepChartBase'

/**
 * The market price on its own terms: AMM spot over time, scaled to the trades
 * themselves rather than to the issuance ladder (the Overview chart anchors to
 * issuance, which flattens real price movement). Registration price + every
 * post-trade spot, terminating at the live pool price.
 */

const DAY = 86_400
const PRICE_REFRESH_MS = 15_000
const LINE = '#BD4513'

const RANGES = [
  { label: '1D', seconds: DAY },
  { label: '7D', seconds: 7 * DAY },
  { label: '30D', seconds: 30 * DAY },
  { label: '3M', seconds: 91 * DAY },
  { label: '1Y', seconds: 365 * DAY },
  { label: 'All', seconds: 0 },
] as const

const VW = 640
const VH = 220
const PL = 8
const PR = 8
const PT = 12
const PB = 20

function pointLabel(timestamp: number, span: number): string {
  if (span > 2 * DAY) return chartDateLabel(timestamp, span)
  return new Date(timestamp * 1000).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export function MarketPriceChart({
  chainId,
  suckerGroupId,
  poolId,
  pairDecimals,
  pairSymbol,
  symbol,
  livePrice,
}: {
  chainId: number
  suckerGroupId: string | null
  poolId: string
  pairDecimals: number
  pairSymbol: string
  symbol: string
  livePrice: number
}) {
  const [rangeSeconds, setRangeSeconds] = useState<number>(30 * DAY)
  const [hover, setHover] = useState<{ index: number; x: number } | null>(null)

  // Shares the Overview chart's query — one fetch per project, not two.
  const { data: history, isPending } = useQuery(
    cachedQuery({
    queryKey: ['revnetPriceHistory', suckerGroupId],
    enabled: !!suckerGroupId,
    staleTime: 30_000,
    refetchInterval: PRICE_REFRESH_MS,
    refetchOnWindowFocus: true,
    retry: 1,
    queryFn: async (): Promise<BsRevnetPriceHistory> => {
      const response = await fetch(
        `/api/price-history?suckerGroupId=${encodeURIComponent(suckerGroupId!)}&chainId=${chainId}`,
      )
      if (!response.ok) throw new Error('Price history is unavailable.')
      return response.json() as Promise<BsRevnetPriceHistory>
    },
    }),
  )

  const observed = useMemo(
    () => ammSeriesFrom({ history, chainId, poolId, pairDecimals }),
    [history, chainId, poolId, pairDecimals],
  )

  const now = Math.floor(Date.now() / 1000)
  const first = observed[0]?.timestamp ?? now
  const t0 = Math.min(
    now - 1,
    rangeSeconds === 0 ? first : Math.max(first, now - rangeSeconds),
  )
  const series: PricePoint[] = visibleSeries(observed, livePrice, t0, now)

  const opening = series[0]?.value ?? livePrice
  const change = opening > 0 ? (livePrice - opening) / opening : 0
  const span = now - t0

  const low = series.reduce((m, p) => Math.min(m, p.value), livePrice)
  const high = series.reduce((m, p) => Math.max(m, p.value), livePrice)
  // A flat series would divide by zero; give it a visible band around itself.
  const pad = high > low ? (high - low) * 0.12 : Math.max(high * 0.1, 1e-18)
  const yMin = Math.max(0, low - pad)
  const yMax = high + pad

  const X = (t: number) =>
    PL + ((VW - PL - PR) * (t - t0)) / Math.max(1, now - t0)
  const Y = (v: number) =>
    PT + (VH - PT - PB) * (1 - (v - yMin) / Math.max(yMax - yMin, 1e-18))

  const line = series.map(p => `${X(p.timestamp).toFixed(1)},${Y(p.value).toFixed(1)}`)
  const area = series.length
    ? `${X(series[0].timestamp).toFixed(1)},${VH - PB} ${line.join(' ')} ${X(now).toFixed(1)},${VH - PB}`
    : ''

  const inspected = hover ? series[hover.index] : null

  const onPointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    if (series.length < 2) return
    const rect = event.currentTarget.getBoundingClientRect()
    const fraction = (event.clientX - rect.left) / rect.width
    const t = t0 + Math.min(1, Math.max(0, fraction)) * (now - t0)
    let index = 0
    for (let i = 1; i < series.length; i += 1) {
      if (
        Math.abs(series[i].timestamp - t) <
        Math.abs(series[index].timestamp - t)
      ) {
        index = i
      }
    }
    setHover({ index, x: Math.min(0.98, Math.max(0.02, fraction)) })
  }

  return (
    <div className="card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <span className="field-label">Market price</span>
          <p className="mt-2 text-2xl font-medium tracking-tight text-ink">
            {formatPrice(livePrice)}{' '}
            <span className="text-base text-smoke-700">
              {pairSymbol}/{symbol}
            </span>
          </p>
          {series.length > 1 ? (
            <p
              className={`mt-0.5 text-sm font-medium ${
                change > 0
                  ? 'text-melon-600'
                  : change < 0
                    ? 'text-error-600'
                    : 'text-smoke-700'
              }`}
            >
              {change >= 0 ? '+' : '−'}
              {Math.abs(change * 100).toFixed(Math.abs(change) < 0.1 ? 2 : 1)}%{' '}
              <span className="font-normal text-smoke-500">
                over {rangeSeconds === 0 ? 'all time' : 'this range'}
              </span>
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap justify-end gap-1">
          {RANGES.map(range => (
            <ChartRangeButton
              key={range.label}
              label={range.label}
              active={rangeSeconds === range.seconds}
              onClick={() => {
                setRangeSeconds(range.seconds)
                setHover(null)
              }}
            />
          ))}
        </div>
      </div>

      {isPending && !series.length ? (
        <div className="skeleton-shimmer mt-4 h-40 w-full rounded-lg" aria-hidden="true" />
      ) : series.length < 2 ? (
        <p className="mt-4 text-sm leading-relaxed text-smoke-700">
          No trades in this range yet — the price above is the live pool price.
        </p>
      ) : (
        <div className="relative mt-4">
          <svg
            viewBox={`0 0 ${VW} ${VH}`}
            className="h-auto w-full cursor-crosshair touch-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bluebs-400"
            role="img"
            aria-label={`${symbol} market price in ${pairSymbol} over the selected range`}
            tabIndex={0}
            onPointerMove={onPointerMove}
            onPointerLeave={() => setHover(null)}
            onFocus={() => setHover({ index: series.length - 1, x: 0.9 })}
            onBlur={() => setHover(null)}
          >
            <defs>
              <linearGradient id="market-price-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={LINE} stopOpacity="0.22" />
                <stop offset="100%" stopColor={LINE} stopOpacity="0" />
              </linearGradient>
            </defs>
            <line
              x1={PL}
              y1={VH - PB}
              x2={VW - PR}
              y2={VH - PB}
              stroke="#D4D1C7"
              strokeWidth="1"
            />
            <polygon points={area} fill="url(#market-price-fill)" />
            <polyline
              points={line.join(' ')}
              fill="none"
              stroke={LINE}
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            {inspected ? (
              <>
                <line
                  x1={X(inspected.timestamp)}
                  y1={PT}
                  x2={X(inspected.timestamp)}
                  y2={VH - PB}
                  stroke="#9C9580"
                  strokeWidth="1"
                  strokeDasharray="3 3"
                />
                <circle
                  cx={X(inspected.timestamp)}
                  cy={Y(inspected.value)}
                  r="4"
                  fill={LINE}
                  stroke="white"
                  strokeWidth="1.5"
                />
              </>
            ) : (
              <circle
                cx={X(now)}
                cy={Y(livePrice)}
                r="4"
                fill={LINE}
                stroke="white"
                strokeWidth="1.5"
              />
            )}
            <text x={PL + 2} y={PT + 9} fontSize="11" fill="#9C9580">
              {formatPrice(yMax)}
            </text>
            <text x={PL + 2} y={VH - PB - 4} fontSize="11" fill="#9C9580">
              {formatPrice(yMin)}
            </text>
            <text x={PL} y={VH - 5} fontSize="11" fill="#9C9580">
              {chartDateLabel(t0, span)}
            </text>
            <text
              x={VW - PR}
              y={VH - 5}
              textAnchor="end"
              fontSize="11"
              fill="#9C9580"
            >
              Now
            </text>
          </svg>
          {inspected ? (
            <div
              role="tooltip"
              aria-live="polite"
              className={`pointer-events-none absolute top-2 z-20 w-max rounded-lg bg-grey-900 px-3 py-2 text-xs text-grey-25 shadow-xl ${
                hover && hover.x > 0.58 ? '-translate-x-full -ml-3' : 'ml-3'
              }`}
              style={{ left: `${(hover?.x ?? 0.5) * 100}%` }}
            >
              <p className="font-medium text-white">
                {formatPrice(inspected.value)} {pairSymbol}/{symbol}
              </p>
              <p className="mt-0.5 text-grey-300">
                {pointLabel(inspected.timestamp, span)}
              </p>
            </div>
          ) : null}
        </div>
      )}

      <p className="mt-4 border-t border-smoke-100 pt-3 text-xs leading-relaxed text-smoke-500">
        Each point is a trade&apos;s exact post-trade pool price. Arbitrage keeps
        it between the issuance ceiling and the cash-out floor.
      </p>
    </div>
  )
}
