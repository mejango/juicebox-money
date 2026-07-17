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
 * Projected issuance price (base units per token) as a rising ladder. The
 * protocol schedule stores an issuance rate, so the plotted value is its
 * reciprocal: price = 1 / rate. As issuance is cut, each token costs more.
 * Pure SVG — no libraries. Hover to inspect any point in time.
 */

// Plot area gutters inside a 320×180 viewBox.
const VW = 320
const VH = 180
const PL = 12
const PR = 12
const PT = 16
const PB = 22

export function IssuanceLadder({
  stages,
  symbol,
  baseSymbol,
}: {
  stages: ChartStage[]
  symbol: string
  baseSymbol: string
}) {
  const [years, setYears] = useState(1)
  const [hoverT, setHoverT] = useState<number | null>(null)

  const now = useMemo(() => Math.floor(Date.now() / 1000), [])
  const resolved = useMemo(() => resolveStages(stages), [stages])
  const { t0, t1 } = timeBounds(resolved, now, years)
  const points = useMemo(
    () =>
      buildStepPoints(resolved, t0, t1).map(
        ([t, rate]) => [t, rate > 0 ? 1 / rate : null] as [
          number,
          number | null,
        ],
      ),
    [resolved, t0, t1],
  )
  const maxV = points.reduce(
    (m, [, price]) => (price !== null && price > m ? price : m),
    0,
  )

  if (resolved.length === 0 || maxV <= 0) {
    return (
      <div className="mt-3 rounded-xl border border-smoke-200 bg-white p-4">
        <p className="text-xs text-smoke-500">No issuance to chart.</p>
      </div>
    )
  }

  const X = (t: number) => PL + ((VW - PL - PR) * (t - t0)) / (t1 - t0)
  const Y = (price: number) =>
    PT +
    (VH - PT - PB) *
      (1 - Math.max(0, Math.min(1, price / maxV)))

  const path = points
    // No issuance has an infinite price; pin it to the top of the finite
    // issuance-price range, matching website/'s chart.
    .map(([t, price]) =>
      `${X(t).toFixed(1)},${Y(price ?? maxV).toFixed(1)}`,
    )
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
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-smoke-500">
          Projected issuance price
        </span>
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
        aria-label={`Projected ${symbol} issuance price in ${baseSymbol} over time`}
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
        {/* The ladder */}
        <polyline
          points={path}
          fill="none"
          stroke="#5777EB"
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
