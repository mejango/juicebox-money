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
const NOW_COLOR = '#F5A312'

// Plot area gutters inside a 320×180 viewBox.
const VW = 320
const VH = 180
const PL = 0
const PR = 0
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

/**
 * A quiet range picker in the same voice as MarketPriceViewToggle: a naked
 * select with a chevron, taking one text line instead of a row of pills.
 */
export function ChartRangeSelect({
  ranges,
  value,
  onChange,
}: {
  ranges: readonly { label: string; value: number }[]
  value: number
  onChange: (value: number) => void
}) {
  return (
    <div className="relative inline-flex shrink-0 items-center text-bluebs-700">
      <select
        value={value}
        onChange={event => onChange(Number(event.target.value))}
        aria-label="Time range"
        className="cursor-pointer appearance-none border-0 bg-none bg-transparent p-0 pr-4 text-xs font-medium text-current hover:underline focus:border-0 focus:ring-0 focus-visible:!outline-none focus-visible:underline"
      >
        {ranges.map(range => (
          <option key={range.label} value={range.value}>
            {range.label}
          </option>
        ))}
      </select>
      <svg
        viewBox="0 0 12 12"
        aria-hidden="true"
        className="pointer-events-none absolute right-0 h-3 w-3"
      >
        <path
          d="m2.5 4.25 3.5 3.5 3.5-3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
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
  showLadder = true,
  frameless = false,
  header,
  footer,
  renderSeries,
  renderOverlay,
  renderInspection,
  inspectionPlacement = 'below',
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
  /** Whether to draw the issuance ladder itself (a deselected legend hides it). */
  showLadder?: boolean
  /** Skip the card chrome when the chart already sits inside a card. */
  frameless?: boolean
  /** Rendered inside the card above the svg (summary tiles, range pills). */
  header?: ReactNode
  /** Rendered inside the card below the svg (legend, methodology tips). */
  footer?: ReactNode
  /** Extra series drawn after the stage boundaries, behind the Now marker. */
  renderSeries?: (geom: ChartGeom) => ReactNode
  /** Extra marks drawn after the inspected point, under the scale labels. */
  renderOverlay?: (geom: ChartGeom) => ReactNode
  /** Additional details for the inspected timestamp, rendered below the chart. */
  renderInspection?: (state: {
    timestamp: number
    isHovering: boolean
  }) => ReactNode
  /** PriceChart uses a cursor-following tooltip; issuance-only charts retain the caption below. */
  inspectionPlacement?: 'below' | 'tooltip'
}) {
  const [hoverT, setHoverT] = useState<number | null>(null)
  const [hoverPosition, setHoverPosition] = useState<{
    x: number
    y: number
  } | null>(null)

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
      <div
        className={
          frameless ? 'mt-3' : 'mt-3 card p-6'
        }
      >
        <p className="text-xs text-smoke-500">No issuance to chart.</p>
      </div>
    )
  }

  const X = (t: number) => PL + ((VW - PL - PR) * (t - t0)) / (t1 - t0)
  // 10% headroom keeps the highest series off the plot's top edge.
  const scaleMax = maxV * 1.1
  const Y = (v: number) =>
    PT + (VH - PT - PB) * (1 - Math.max(0, Math.min(1, v / scaleMax)))

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
    setHoverPosition({
      x: Math.min(0.98, Math.max(0.02, (e.clientX - rect.left) / rect.width)),
      y: Math.min(0.98, Math.max(0.02, (e.clientY - rect.top) / rect.height)),
    })
  }

  const clearInspection = () => {
    setHoverT(null)
    setHoverPosition(null)
  }

  return (
    <div
      className={
        frameless ? 'mt-3' : 'mt-3 card p-6'
      }
    >
      {header}
      <div className="relative">
        <svg
          viewBox={`0 0 ${VW} ${VH}`}
          className="mt-2 h-auto w-full cursor-crosshair touch-none rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bluebs-400"
          role="img"
          aria-label={ariaLabel}
          tabIndex={inspectionPlacement === 'tooltip' ? 0 : undefined}
          onPointerMove={onPointerMove}
          onPointerLeave={clearInspection}
          onFocus={() => {
            if (inspectionPlacement !== 'tooltip') return
            setHoverT(Math.min(now, t1))
            setHoverPosition({ x: 0.72, y: 0.25 })
          }}
          onBlur={clearInspection}
        >
        {/* Axes */}
        <line x1={PL} y1={VH - PB} x2={VW - PR} y2={VH - PB} stroke="#D4D1C7" strokeWidth="1" />
        {/* Half-unit inset keeps the full stroke visible at the svg's edge. */}
        <line x1={PL + 0.5} y1={VH - PB} x2={PL + 0.5} y2={PT} stroke="#D4D1C7" strokeWidth="1" />
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
        {showLadder ? (
          <polyline
            points={path}
            fill="none"
            stroke={ISSUANCE_COLOR}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : null}
        {/* Crosshair guides while hovering */}
        {showLadder && hoverT !== null && price !== null ? (
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
        {showLadder ? (
          <circle
            cx={X(t)}
            cy={Y(price ?? maxV)}
            r="3.5"
            fill={NOW_COLOR}
            stroke="#1A1A1A"
            strokeWidth="1"
          />
        ) : null}
        {renderOverlay?.(geom)}
        {/* Scale + date labels */}
        {showLadder ? (
          <text x={PL + 3} y={Y(maxV) + 8} fontSize="7" fill="#9C9580">
            {formatPrice(maxV)} {baseSymbol}
          </text>
        ) : null}
        <text x={PL} y={VH - 6} fontSize="7.5" fill="#9C9580">
          {chartDateLabel(t0, span)}
        </text>
        <text x={VW - PR} y={VH - 6} textAnchor="end" fontSize="7.5" fill="#9C9580">
          {chartDateLabel(t1, span)}
        </text>
        </svg>
        {inspectionPlacement === 'tooltip' && hoverPosition && hoverT !== null ? (
          <div
            role="tooltip"
            aria-live="polite"
            className={`pointer-events-none absolute z-20 w-max min-w-52 max-w-[calc(100%-1rem)] rounded-lg bg-grey-900 px-3 py-2.5 text-grey-25 shadow-xl ${
              hoverPosition.x > 0.58 ? '-ml-3 -translate-x-full' : 'ml-3'
            } ${hoverPosition.y > 0.58 ? '-mt-3 -translate-y-full' : 'mt-3'}`}
            style={{
              left: `${hoverPosition.x * 100}%`,
              top: `${hoverPosition.y * 100}%`,
            }}
          >
            {renderInspection?.({ timestamp: t, isHovering: true })}
          </div>
        ) : null}
      </div>
      {inspectionPlacement === 'below' ? (
        <>
          <p
            data-chart-caption
            className="mt-2 text-xs leading-relaxed text-smoke-700"
            aria-live="polite"
          >
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
          {renderInspection?.({ timestamp: t, isHovering: hoverT !== null })}
        </>
      ) : null}
      {footer}
    </div>
  )
}
