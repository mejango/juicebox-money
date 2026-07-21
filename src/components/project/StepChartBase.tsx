'use client'

import { useMemo, useState, type ReactNode } from 'react'
import {
  buildStepPoints,
  chartDateLabel,
  formatPrice,
  rateAtTime,
  type ResolvedStage,
} from './chartUtils'

/**
 * Shared SVG scaffold for the issuance-price step charts (IssuanceLadder,
 * PriceChart): the card, axes, stage boundaries, Now marker, the price
 * ladder polyline, hover crosshair + inspected point, scale/date labels, and
 * the caption. Chart-specific series slot in through `renderSeries` (drawn
 * behind the Now marker) and `renderOverlay` (drawn above the inspected
 * point), keeping the shared element order fixed.
 */

export const ISSUANCE_COLOR = '#5777EB'
export const NOW_COLOR = '#F5A312'

// Plot area gutters inside a 320×180 viewBox.
const VW = 320
const VH = 180
const PL = 12
const PR = 12
const PT = 16
const PB = 22

export type ChartGeom = {
  /** Time → x in viewBox units. */
  X: (t: number) => number
  /** Price → y in viewBox units, clamped to the plot area. */
  Y: (v: number) => number
  /** X at min(now, t1). */
  nowX: number
  /** The vertical scale's top value (max issuance price in the window). */
  maxV: number
}

/** One range-selector pill; the caller maps its own range model over these. */
export function ChartRangeButton({
  label,
  active,
  onClick,
}: {
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`min-h-11 rounded-lg border px-2.5 text-[11px] font-medium transition-colors focus-visible:outline-none ${
        active
          ? 'border-bluebs-500 bg-bluebs-25 text-bluebs-700 shadow-[0_1px_4px_rgba(39,79,245,0.12)]'
          : 'border-grey-300 bg-white text-grey-700 hover:border-bluebs-300 hover:text-bluebs-600'
      }`}
    >
      {label}
    </button>
  )
}

export function StepChartBase({
  resolved,
  t0,
  t1,
  now,
  symbol,
  baseSymbol,
  ariaLabel,
  showNowMarker = true,
  header,
  renderSeries,
  renderOverlay,
}: {
  resolved: ResolvedStage[]
  t0: number
  t1: number
  now: number
  symbol: string
  baseSymbol: string
  ariaLabel: string
  /** Whether to draw the Now marker (e.g. only inside a projected window). */
  showNowMarker?: boolean
  /** Rendered inside the card above the svg (summary tiles, range pills). */
  header?: ReactNode
  /** Extra series drawn after the stage boundaries, behind the Now marker. */
  renderSeries?: (geom: ChartGeom) => ReactNode
  /** Extra marks drawn after the inspected point, under the scale labels. */
  renderOverlay?: (geom: ChartGeom) => ReactNode
}) {
  const [hoverT, setHoverT] = useState<number | null>(null)

  // Price points: invert the rate steps; rate 0 → null (no mint price).
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
  const maxV = points.reduce((m, [, v]) => (v !== null && v > m ? v : m), 0)

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
    // No issuance has an infinite price; pin it to the top of the finite
    // issuance-price range, matching website/'s chart.
    .map(([t, v]) => `${X(t).toFixed(1)},${Y(v ?? maxV).toFixed(1)}`)
    .join(' ')

  const t = Math.min(t1, Math.max(t0, hoverT ?? Math.min(now, t1)))
  const rate = rateAtTime(resolved, t)
  const price = rate > 0 ? 1 / rate : null
  const span = t1 - t0
  const nowX = X(Math.min(now, t1))
  const geom: ChartGeom = { X, Y, nowX, maxV }

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const viewX = ((e.clientX - rect.left) / rect.width) * VW
    const frac = Math.min(1, Math.max(0, (viewX - PL) / (VW - PL - PR)))
    setHoverT(t0 + frac * (t1 - t0))
  }

  return (
    <div className="mt-3 rounded-xl border border-smoke-200 bg-white p-4">
      {header}
      <svg
        viewBox={`0 0 ${VW} ${VH}`}
        className="mt-2 h-auto w-full cursor-crosshair touch-none"
        role="img"
        aria-label={ariaLabel}
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
        {renderSeries?.(geom)}
        {/* Now marker */}
        {showNowMarker ? (
          <>
            <line
              x1={nowX}
              y1={PT}
              x2={nowX}
              y2={VH - PB}
              stroke={NOW_COLOR}
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
        {/* The price ladder */}
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
          fill={NOW_COLOR}
          stroke="#1A1A1A"
          strokeWidth="1"
        />
        {renderOverlay?.(geom)}
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
