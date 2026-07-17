'use client'

import { useMemo, useState } from 'react'
import {
  CHART_RANGES,
  buildStepPoints,
  chartDateLabel,
  formatPrice,
  rateAtTime,
  resolveStages,
  timeBounds,
  type ChartStage,
} from './chartUtils'

/**
 * The issuance price ceiling over time: price = 1 / issuance rate (base units
 * per token), a rising ladder as the rate cuts. Optional flat reference lines
 * mark the cash-out floor and the AMM price — arbitrage keeps the market
 * between the two ladders. The vertical scale is anchored to the issuance
 * schedule (website/ parity); reference values outside it pin to the chart
 * edge while their exact values stay in the legend. Linear scale — no log
 * toggle, matching website/. Zero-issuance regions (price → ∞) clamp to the
 * top of the finite range.
 */

type ReferenceLine = { value: number; label: string } | null

const ISSUANCE_COLOR = '#6EC4C4'
const CASH_OUT_COLOR = '#C43550'
const AMM_COLOR = '#B8602E'

// Plot area gutters inside a 320×180 viewBox.
const VW = 320
const VH = 180
const PL = 12
const PR = 12
const PT = 16
const PB = 22

function PriceSummary({
  label,
  color,
  value,
  baseSymbol,
  symbol,
}: {
  label: string
  color: string
  value: number | null
  baseSymbol: string
  symbol: string
}) {
  return (
    <div className="min-w-0 rounded-lg bg-smoke-75 px-3 py-2">
      <div className="flex items-center gap-2 text-[11px] font-medium text-ink">
        <span
          aria-hidden="true"
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ backgroundColor: color }}
        />
        <span>{label}</span>
      </div>
      <p className="mt-0.5 truncate text-[11px] text-smoke-700">
        {value && value > 0 ? (
          <>
            {formatPrice(value)} {baseSymbol}/{symbol}
          </>
        ) : (
          '—'
        )}
      </p>
    </div>
  )
}

export function PriceChart({
  stages,
  symbol,
  baseSymbol,
  floorPrice,
  ammPrice,
}: {
  stages: ChartStage[]
  symbol: string
  baseSymbol: string
  floorPrice?: ReferenceLine
  ammPrice?: ReferenceLine
}) {
  const [years, setYears] = useState(1)
  const [hoverT, setHoverT] = useState<number | null>(null)

  const now = useMemo(() => Math.floor(Date.now() / 1000), [])
  const resolved = useMemo(() => resolveStages(stages), [stages])
  const { t0, t1 } = timeBounds(resolved, now, years)
  // Price points: invert the rate steps; rate 0 → null (no mint price).
  const points = useMemo(
    () =>
      buildStepPoints(resolved, t0, t1).map(
        ([t, rate]) => [t, rate > 0 ? 1 / rate : null] as [number, number | null],
      ),
    [resolved, t0, t1],
  )
  const maxV = points.reduce((m, [, v]) => (v !== null && v > m ? v : m), 0)
  const issuanceNowRate = rateAtTime(resolved, now)
  const issuanceNow = issuanceNowRate > 0 ? 1 / issuanceNowRate : null
  const floor = floorPrice && floorPrice.value > 0 ? floorPrice : null
  const amm = ammPrice && ammPrice.value > 0 ? ammPrice : null

  if (resolved.length === 0 || maxV <= 0) {
    return (
      <div className="mt-3 rounded-xl border border-smoke-200 bg-white p-4">
        <p className="text-xs text-smoke-500">No issuance to chart.</p>
      </div>
    )
  }

  const X = (t: number) => PL + ((VW - PL - PR) * (t - t0)) / (t1 - t0)
  const Y = (v: number) =>
    PT + (VH - PT - PB) * (1 - Math.max(0, Math.min(1, v / maxV)))

  const path = points
    .map(([t, v]) => `${X(t).toFixed(1)},${Y(v ?? maxV).toFixed(1)}`)
    .join(' ')

  const t = Math.min(t1, Math.max(t0, hoverT ?? Math.min(now, t1)))
  const rate = rateAtTime(resolved, t)
  const price = rate > 0 ? 1 / rate : null
  const span = t1 - t0
  const nowX = X(Math.min(now, t1))

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const viewX = ((e.clientX - rect.left) / rect.width) * VW
    const frac = Math.min(1, Math.max(0, (viewX - PL) / (VW - PL - PR)))
    setHoverT(t0 + frac * (t1 - t0))
  }

  return (
    <div className="mt-3 rounded-xl border border-smoke-200 bg-white p-4">
      <div className="grid gap-2 sm:grid-cols-3">
        <PriceSummary
          label="Issuance price"
          color={ISSUANCE_COLOR}
          value={issuanceNow}
          baseSymbol={baseSymbol}
          symbol={symbol}
        />
        <PriceSummary
          label="Cash out price"
          color={CASH_OUT_COLOR}
          value={floor?.value ?? null}
          baseSymbol={baseSymbol}
          symbol={symbol}
        />
        <PriceSummary
          label="AMM price"
          color={AMM_COLOR}
          value={amm?.value ?? null}
          baseSymbol={baseSymbol}
          symbol={symbol}
        />
      </div>
      <div className="mt-3 flex items-center justify-between gap-2">
        <span className="text-xs text-smoke-500">Price</span>
        <div className="flex gap-1">
          {CHART_RANGES.map(r => (
            <button
              key={r.label}
              type="button"
              onClick={() => setYears(r.years)}
              aria-pressed={years === r.years}
              className={`min-h-[32px] rounded-lg border px-2.5 text-[11px] font-medium transition-colors focus-visible:outline-none ${
                years === r.years
                  ? 'border-bluebs-500 bg-bluebs-25 text-bluebs-700 shadow-[0_1px_4px_rgba(39,79,245,0.12)]'
                  : 'border-grey-300 bg-white text-grey-700 hover:border-bluebs-300 hover:text-bluebs-600'
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>
      <svg
        viewBox={`0 0 ${VW} ${VH}`}
        className="mt-2 h-auto w-full cursor-crosshair touch-none"
        role="img"
        aria-label={`${symbol} issuance ceiling, cash-out floor, and AMM price in ${baseSymbol} over time`}
        onPointerMove={onPointerMove}
        onPointerLeave={() => setHoverT(null)}
      >
        {/* Axes */}
        <line x1={PL} y1={VH - PB} x2={VW - PR} y2={VH - PB} stroke="#D4D1C7" strokeWidth="1" />
        <line x1={PL} y1={VH - PB} x2={PL} y2={PT} stroke="#D4D1C7" strokeWidth="1" />
        {/* Stage boundaries */}
        {resolved.map((s, i) =>
          i > 0 && s.start > t0 && s.start < t1 ? (
            <g key={s.start}>
              <line
                x1={X(s.start)}
                y1={PT}
                x2={X(s.start)}
                y2={VH - PB}
                stroke="#D4D1C7"
                strokeWidth="1"
                strokeDasharray="3 3"
              />
              <text x={X(s.start) + 3} y={PT + 8} fontSize="6.5" fill="#9C9580">
                Stage {i + 1}
              </text>
            </g>
          ) : null,
        )}
        {/* Reference lines sit behind the issuance ceiling */}
        {floor ? (
          <line
            x1={PL}
            y1={Y(floor.value)}
            x2={VW - PR}
            y2={Y(floor.value)}
            stroke={CASH_OUT_COLOR}
            strokeWidth="1.5"
            strokeDasharray="5 4"
          />
        ) : null}
        {amm ? (
          <line
            x1={PL}
            y1={Y(amm.value)}
            x2={VW - PR}
            y2={Y(amm.value)}
            stroke={AMM_COLOR}
            strokeWidth="1.5"
            strokeDasharray="5 4"
          />
        ) : null}
        {/* Now marker */}
        {now < t1 ? (
          <>
            <line
              x1={nowX}
              y1={PT}
              x2={nowX}
              y2={VH - PB}
              stroke="#F5A312"
              strokeWidth="1"
              strokeDasharray="4 3"
            />
            <text
              x={nowX > VW - PR - 24 ? nowX - 3 : nowX + 3}
              y={PT - 4}
              fontSize="7"
              fill="#575344"
              textAnchor={nowX > VW - PR - 24 ? 'end' : 'start'}
            >
              Now
            </text>
          </>
        ) : null}
        {/* The price ceiling ladder */}
        <polyline
          points={path}
          fill="none"
          stroke={ISSUANCE_COLOR}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {/* Crosshair guides while hovering */}
        {hoverT !== null && price !== null ? (
          <>
            <line
              x1={X(t)}
              y1={VH - PB}
              x2={X(t)}
              y2={Y(price)}
              stroke="#9C9580"
              strokeWidth="1"
              strokeDasharray="2 2"
            />
            <line
              x1={PL}
              y1={Y(price)}
              x2={X(t)}
              y2={Y(price)}
              stroke="#9C9580"
              strokeWidth="1"
              strokeDasharray="2 2"
            />
          </>
        ) : null}
        {/* The inspected point */}
        <circle
          cx={X(t)}
          cy={Y(price ?? maxV)}
          r="3.5"
          fill="#F5A312"
          stroke="#1A1A1A"
          strokeWidth="1"
        />
        {/* Scale + date labels */}
        <text x={PL + 3} y={PT + 7} fontSize="7" fill="#9C9580">
          {formatPrice(maxV)} {baseSymbol}
        </text>
        <text x={PL} y={VH - 6} fontSize="7.5" fill="#9C9580">
          {chartDateLabel(t0, span)}
        </text>
        <text x={VW - PR} y={VH - 6} textAnchor="end" fontSize="7.5" fill="#9C9580">
          {chartDateLabel(t1, span)}
        </text>
      </svg>
      <p className="mt-2 text-xs leading-relaxed text-smoke-700" aria-live="polite">
        <span className="font-medium text-ink">{chartDateLabel(t, span)}</span>
        {' — '}
        {price !== null ? (
          <>
            <span className="font-medium text-ink">
              {formatPrice(price)} {baseSymbol}
            </span>{' '}
            per {symbol}
          </>
        ) : (
          'no issuance'
        )}
      </p>
    </div>
  )
}
