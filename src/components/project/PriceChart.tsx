'use client'

import { useMemo, useState } from 'react'
import { ChartNoteTip } from '@/components/project/ChartNoteTip'
import { ConceptTerm } from '@/components/project/ConceptTerm'
import { priceConcept } from '@/lib/price-concepts'
import {
  buildStepPoints,
  chartDateLabel,
  formatPrice,
  rateAtTime,
  resolveStages,
  type ChartStage,
} from './chartUtils'
import {
  ChartRangeButton,
  ISSUANCE_COLOR,
  StepChartBase,
} from './StepChartBase'
import {
  minimumCashOutPriceAtIssuancePrice,
  netCashOutDisplayValue,
  shouldShowCashOutAsymptote,
} from '@/lib/cashOut'
import {
  smoothPriceSeries,
  visibleSeries,
  type PricePoint,
} from '@/lib/price-series'
import {
  MarketPriceViewToggle,
  type MarketPriceView,
} from './MarketPriceViewToggle'

/**
 * The issuance price ceiling over time: price = 1 / issuance rate (base units
 * per token), a rising ladder as the rate cuts. Indexed cash-out and AMM
 * observations are drawn only over the historical window and terminate at
 * live values at Now. The vertical scale is anchored to the issuance schedule
 * (website/ parity); values outside it pin to the chart edge while their exact
 * values stay in the legend. Linear scale — no log toggle, matching website/.
 */

type ReferenceLine = {
  value: number
  label: string
  cashOutTaxRate?: number
} | null
export type { PricePoint }
export type CashOutTaxPoint = {
  timestamp: number
  cashOutTaxRate: number
}

const CASH_OUT_COLOR = '#C85F9A'
const AMM_COLOR = '#BD4513'
const DAY = 86_400

const PRICE_RANGES = [
  { label: '1H', seconds: 60 * 60 },
  { label: '6H', seconds: 6 * 60 * 60 },
  { label: '1D', seconds: DAY },
  { label: '7D', seconds: 7 * DAY },
  { label: '30D', seconds: 30 * DAY },
  { label: '3M', seconds: 91 * DAY },
  { label: '1Y', seconds: 365 * DAY },
  { label: 'All', seconds: 0 },
] as const

function asStepSeries(points: PricePoint[]): PricePoint[] {
  if (points.length < 2) return points
  const stepped: PricePoint[] = [points[0]]
  for (let i = 1; i < points.length; i++) {
    stepped.push({ timestamp: points[i].timestamp, value: points[i - 1].value })
    stepped.push(points[i])
  }
  return stepped
}

function pointAt(points: PricePoint[], timestamp: number): PricePoint | null {
  let found: PricePoint | null = null
  for (const point of points) {
    if (point.timestamp > timestamp) break
    found = point
  }
  return found
}

function interpolatedPointAt(
  points: PricePoint[],
  timestamp: number,
): PricePoint | null {
  if (!points.length) return null
  let previous = points[0]
  if (timestamp <= previous.timestamp) return previous
  for (let index = 1; index < points.length; index += 1) {
    const next = points[index]
    if (timestamp > next.timestamp) {
      previous = next
      continue
    }
    if (next.timestamp === previous.timestamp) return next
    const progress =
      (timestamp - previous.timestamp) / (next.timestamp - previous.timestamp)
    return {
      timestamp,
      value: previous.value + (next.value - previous.value) * progress,
    }
  }
  return previous
}

function inspectionDateLabel(timestamp: number, span: number): string {
  if (span > 2 * DAY) return chartDateLabel(timestamp, span)
  return new Date(timestamp * 1000).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function TooltipPriceRow({
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
    <div className="flex items-baseline justify-between gap-4 whitespace-nowrap">
      <span className="flex items-center gap-2 text-grey-300">
        <span
          aria-hidden="true"
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ backgroundColor: color }}
        />
        {label}
      </span>
      <span className="font-medium text-white">
        {value && value > 0
          ? `${formatPrice(value)} ${baseSymbol}/${symbol}`
          : '—'}
      </span>
    </div>
  )
}

function PriceSummary({
  label,
  color,
  note,
}: {
  label: string
  color: string
  /** What this price MEANS. Carried by the whole cell so the entire target reveals it; the (?)
   *  beside the label is the affordance saying so. */
  note?: string
}) {
  return (
    <div className="min-w-0 rounded-lg bg-smoke-75 px-3 py-2">
      <div className="flex items-center gap-2 text-[11px] font-medium text-ink">
        <span
          aria-hidden="true"
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ backgroundColor: color }}
        />
        {note ? <ConceptTerm note={note}>{label}</ConceptTerm> : <span>{label}</span>}
      </div>
    </div>
  )
}

export function PriceChart({
  stages,
  symbol,
  baseSymbol,
  floorPrice,
  ammPrice,
  floorHistory = [],
  ammHistory = [],
  cashOutTaxHistory = [],
  note,
}: {
  stages: ChartStage[]
  symbol: string
  baseSymbol: string
  floorPrice?: ReferenceLine
  ammPrice?: ReferenceLine
  floorHistory?: PricePoint[]
  ammHistory?: PricePoint[]
  cashOutTaxHistory?: CashOutTaxPoint[]
  /** The live cash-out / AMM reads are still confirming. */
  /** Accepted for caller compatibility; the value-less legend no longer shows it. */
  referencesPending?: boolean
  /** An always-true caveat about how to READ the chart, shown behind an (!) rather than as a
   *  banner. Notices about missing or stale DATA stay inline — see RevnetPriceCard. */
  note?: string | null
}) {
  const [rangeSeconds, setRangeSeconds] = useState(
    // A quarter is where a project's shape is legible: long enough to show
    // the trend, short enough that recent movement is not a smudge at the edge.
    91 * DAY,
  )
  const [marketPriceView, setMarketPriceView] =
    useState<MarketPriceView>('smooth')

  const now = Math.floor(Date.now() / 1000)
  const resolved = useMemo(() => resolveStages(stages), [stages])
  const firstStart = Math.min(resolved[0]?.start ?? now, now)
  const requestedStart =
    rangeSeconds === 0 ? firstStart : now - rangeSeconds
  const t0 = Math.min(now - 1, Math.max(firstStart, requestedStart))
  const t1 = now
  const floor = floorPrice && floorPrice.value > 0 ? floorPrice : null
  const amm = ammPrice && ammPrice.value > 0 ? ammPrice : null
  const floorSeries = visibleSeries(
    floorHistory,
    floor?.value ?? null,
    t0,
    t1,
  )
  const exactAmmSeries = visibleSeries(
    ammHistory,
    amm?.value ?? null,
    t0,
    t1,
  )
  const ammSeries = marketPriceView === 'trades'
    ? exactAmmSeries
    : smoothPriceSeries(exactAmmSeries)
  const sortedTaxHistory = [...cashOutTaxHistory].sort(
    (a, b) => a.timestamp - b.timestamp,
  )
  const taxAtTime = (timestamp: number) => {
    let tax = sortedTaxHistory[0]?.cashOutTaxRate ?? floorPrice?.cashOutTaxRate
    for (const point of sortedTaxHistory) {
      if (point.timestamp > timestamp) break
      tax = point.cashOutTaxRate
    }
    return tax
  }
  const issuanceSteps = buildStepPoints(resolved, t0, t1)
  const minimumSeries = issuanceSteps.flatMap(
    ([timestamp, rate], index) => {
      // buildStepPoints repeats a stage boundary: first with the outgoing
      // rate, then with the incoming rate. Match the outgoing point to the
      // tax immediately before the boundary so the line remains stepped.
      const isOutgoingBoundary =
        issuanceSteps[index + 1]?.[0] === timestamp
      const tax = taxAtTime(
        isOutgoingBoundary ? timestamp - 0.001 : timestamp,
      )
      // Net of the protocol fee so the asymptote shares the axis honestly with the floor
      // line above it; both are ambient displays of what a holder would receive.
      const value =
        rate > 0 && tax !== undefined
          ? netCashOutDisplayValue(minimumCashOutPriceAtIssuancePrice(1 / rate, tax), tax)
          : null
      return value && value > 0 ? [{ timestamp, value }] : []
    },
  )
  const currentMinimum = pointAt(minimumSeries, now)?.value
  const showMinimum = shouldShowCashOutAsymptote(
    floor?.value,
    currentMinimum,
  )
  const visibleMinimumSeries = showMinimum ? minimumSeries : []

  return (
    <StepChartBase
      resolved={resolved}
      t0={t0}
      t1={t1}
      now={now}
      symbol={symbol}
      baseSymbol={baseSymbol}
      ariaLabel={`${symbol} issuance ceiling history through Now, with the cash-out price${showMinimum ? ', dotted minimum cash-out price,' : ','} and AMM price in ${baseSymbol}`}
      header={
        <>
          <div className="flex flex-wrap items-center justify-end gap-1">
            {PRICE_RANGES.map(r => (
              <ChartRangeButton
                key={r.label}
                label={r.label}
                active={rangeSeconds === r.seconds}
                onClick={() => setRangeSeconds(r.seconds)}
              />
            ))}
          </div>
          {exactAmmSeries.length > 1 ? (
            <div className="mt-2 flex justify-end">
              <MarketPriceViewToggle
                value={marketPriceView}
                onChange={setMarketPriceView}
              />
            </div>
          ) : null}
        </>
      }
      footer={
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <PriceSummary
            label="Issuance price"
            note={priceConcept("issuance", { tokenSymbol: symbol, baseSymbol })}
            color={ISSUANCE_COLOR}
          />
          <PriceSummary
            label="Cash out price"
            note={priceConcept("cashOut", { tokenSymbol: symbol, baseSymbol })}
            color={CASH_OUT_COLOR}
          />
          <PriceSummary
            label="AMM price"
            note={priceConcept("pool", { tokenSymbol: symbol, baseSymbol })}
            color={AMM_COLOR}
          />
          {note ? <ChartNoteTip note={note} /> : null}
        </div>
      }
      renderSeries={({ X, Y }) => {
        // Observed histories stop at the live value at Now.
        const floorPath = asStepSeries(floorSeries)
          .map(point =>
            `${X(point.timestamp).toFixed(1)},${Y(point.value).toFixed(1)}`,
          )
          .join(' ')
        const ammPath = ammSeries
          .map(point =>
            `${X(point.timestamp).toFixed(1)},${Y(point.value).toFixed(1)}`,
          )
          .join(' ')
        const minimumPath = visibleMinimumSeries
          .map(point =>
            `${X(point.timestamp).toFixed(1)},${Y(point.value).toFixed(1)}`,
          )
          .join(' ')
        return (
          <>
            {floorSeries.length > 1 ? (
              <polyline
                points={floorPath}
                fill="none"
                stroke={CASH_OUT_COLOR}
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ) : null}
            {ammSeries.length > 1 ? (
              <polyline
                points={ammPath}
                fill="none"
                stroke={AMM_COLOR}
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ) : null}
            {visibleMinimumSeries.length > 1 ? (
              <polyline
                points={minimumPath}
                fill="none"
                stroke={CASH_OUT_COLOR}
                strokeWidth="1.3"
                strokeDasharray="5 4"
                strokeLinecap="round"
                strokeLinejoin="round"
                opacity="0.55"
              />
            ) : null}
          </>
        )
      }}
      renderOverlay={({ Y, nowX }) => (
        // Exact live observations at Now.
        <>
          {floor ? (
            <circle
              cx={nowX}
              cy={Y(floor.value)}
              r="2.5"
              fill={CASH_OUT_COLOR}
              stroke="white"
              strokeWidth="1"
            />
          ) : null}
          {amm ? (
            <circle
              cx={nowX}
              cy={Y(amm.value)}
              r="2.5"
              fill={AMM_COLOR}
              stroke="white"
              strokeWidth="1"
            />
          ) : null}
        </>
      )}
      inspectionPlacement="tooltip"
      renderInspection={({ timestamp, isHovering }) => {
        if (!isHovering) return null
        const issuanceRate = rateAtTime(resolved, timestamp)
        const issuance = issuanceRate > 0 ? 1 / issuanceRate : null
        const floorPoint = pointAt(floorSeries, timestamp)
        const ammPoint = interpolatedPointAt(ammSeries, timestamp)
        const minimum = pointAt(visibleMinimumSeries, timestamp)?.value
        return (
          <div className="space-y-1.5 text-xs leading-relaxed">
            <p className="border-b border-grey-700 pb-1.5 font-medium text-white">
              {inspectionDateLabel(timestamp, t1 - t0)}
            </p>
            <TooltipPriceRow
              label="Issuance"
              color={ISSUANCE_COLOR}
              value={issuance}
              baseSymbol={baseSymbol}
              symbol={symbol}
            />
            <TooltipPriceRow
                label={marketPriceView === 'smooth' ? 'AMM average' : 'AMM'}
              color={AMM_COLOR}
              value={ammPoint?.value ?? null}
              baseSymbol={baseSymbol}
              symbol={symbol}
            />
            <TooltipPriceRow
              label="Cash out"
              color={CASH_OUT_COLOR}
              value={floorPoint?.value ?? null}
              baseSymbol={baseSymbol}
              symbol={symbol}
            />
            {minimum ? (
              <TooltipPriceRow
                label="Min cash out"
                color={CASH_OUT_COLOR}
                value={minimum}
                baseSymbol={baseSymbol}
                symbol={symbol}
              />
            ) : null}
            {floorPoint?.reason ? (
              <p className="border-t border-grey-700 pt-1.5 text-grey-300">
                {floorPoint.reason}
              </p>
            ) : null}
          </div>
        )
      }}
    />
  )
}
