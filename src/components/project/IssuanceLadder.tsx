'use client'

import { useMemo, useState } from 'react'
import {
  CHART_RANGES,
  resolveStages,
  timeBounds,
  type ChartStage,
} from './chartUtils'
import { ChartRangeSelect, StepChartBase } from './StepChartBase'

/**
 * Projected issuance price (base units per token) as a rising ladder. The
 * protocol schedule stores an issuance rate, so the plotted value is its
 * reciprocal: price = 1 / rate. As issuance is cut, each token costs more.
 * Pure SVG — no libraries. Hover to inspect any point in time.
 */

export function IssuanceLadder({
  stages,
  symbol,
  baseSymbol,
  stageLabel,
  viewHeight,
}: {
  stages: ChartStage[]
  symbol: string
  baseSymbol: string
  stageLabel?: string
  viewHeight?: number
}) {
  const [years, setYears] = useState(1)

  const now = useMemo(() => Math.floor(Date.now() / 1000), [])
  const resolved = useMemo(() => resolveStages(stages), [stages])
  const { t0, t1 } = timeBounds(resolved, now, years)

  return (
    <StepChartBase
      resolved={resolved}
      t0={t0}
      t1={t1}
      now={now}
      symbol={symbol}
      baseSymbol={baseSymbol}
      ariaLabel={`Projected ${symbol} issuance price in ${baseSymbol} over time`}
      showNowMarker={now < t1}
      showScaleLabel={false}
      frameless
      stageLabel={stageLabel}
      viewHeight={viewHeight}
      header={
        <div className="flex items-center justify-end gap-2">
          <ChartRangeSelect
            ranges={CHART_RANGES.map(r => ({ label: r.label, value: r.years }))}
            value={years}
            onChange={setYears}
          />
        </div>
      }
    />
  )
}
