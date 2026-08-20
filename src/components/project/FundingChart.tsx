'use client'

import { useEffect, useMemo, useState } from 'react'
import { SecuredReserveChart } from '@/components/SecuredReserveChart'
import { ChartRangeSelect } from '@/components/project/StepChartBase'
import {
  getSuckerGroupAddToBalance,
  getSuckerGroupMoments,
  type BsAddToBalance,
  type BsPriceMoment,
} from '@/lib/bendystraw'
import type { ReservePoint } from '@/lib/homepage-reserves'

const BARS = 45
const DAY = 86_400
const RANGES = [
  { label: '1 hour', value: 60 * 60 },
  { label: '6 hours', value: 6 * 60 * 60 },
  { label: '1 day', value: DAY },
  { label: '7 days', value: 7 * DAY },
  { label: '30 days', value: 30 * DAY },
  { label: '3 months', value: 91 * DAY },
  { label: '1 year', value: 365 * DAY },
  { label: 'All', value: 0 },
] as const

type Metric = 'volume' | 'balance'

const METRICS: { value: Metric; label: string; chartLabel: string }[] = [
  {
    value: 'volume',
    label: 'Volume',
    chartLabel:
      'Cumulative payment volume over time, shown as bars. Focus and use arrow keys to inspect values.',
  },
  {
    value: 'balance',
    label: 'Balance',
    chartLabel:
      'Project balance over time, shown as bars. Focus and use arrow keys to inspect values.',
  },
]

function usd(value: number) {
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

/**
 * Even time buckets from the first event to now, forward-filling quiet
 * stretches so the bars read as a continuous history like the homepage chart.
 *
 * Volume is cumulative INTAKE — indexed payment volume plus funds added
 * straight to the terminal — so it can only rise. Balance is the actual
 * terminal balance, so payouts and cash outs pull it down. Both series are
 * the indexer's per-event-time USD accruals (volumeUsd, balanceUsd,
 * amountUsd), so they stay honest across accounting-context switches.
 */
function bucketize(
  moments: BsPriceMoment[],
  adds: BsAddToBalance[],
  metric: Metric,
  rangeSeconds: number,
): ReservePoint[] {
  type UsdEvent = { timestamp: number; base?: number; add?: number }
  const events: UsdEvent[] = []
  for (const moment of moments) {
    try {
      events.push({
        timestamp: moment.timestamp,
        base:
          Number(
            BigInt(metric === 'volume' ? moment.volumeUsd : moment.balanceUsd),
          ) / 1e18,
      })
    } catch {
      // Skip an unparseable row.
    }
  }
  if (metric === 'volume') {
    for (const add of adds) {
      try {
        events.push({ timestamp: add.timestamp, add: Number(BigInt(add.amountUsd)) / 1e18 })
      } catch {
        // Skip an unparseable row.
      }
    }
  }
  events.sort((a, b) => a.timestamp - b.timestamp)
  if (!events.length) return []

  const t1 = Math.floor(Date.now() / 1000)
  const t0 = Math.max(
    events[0].timestamp,
    rangeSeconds > 0 ? t1 - rangeSeconds : events[0].timestamp,
  )
  const span = Math.max(t1 - t0, 1)
  const points: ReservePoint[] = []
  let index = 0
  let lastBase = 0
  let cumulativeAdds = 0
  const consume = (limit: number) => {
    while (index < events.length && events[index].timestamp <= limit) {
      const event = events[index]
      if (event.base !== undefined) lastBase = event.base
      if (event.add !== undefined) cumulativeAdds += event.add
      index += 1
    }
  }
  // Seed with the state standing when the window opens.
  consume(t0)
  for (let bar = 0; bar < BARS; bar++) {
    const end = t0 + (span * (bar + 1)) / BARS
    consume(end)
    points.push({
      timestamp: Math.floor(end),
      valueUsd: lastBase + cumulativeAdds,
    })
  }
  return points
}

/**
 * Volume/Balance history for non-revnet projects — the Overview counterpart
 * to the revnet price chart, in the homepage reserve chart's voice.
 */
export function FundingChart({
  suckerGroupId,
}: {
  suckerGroupId: string | null
}) {
  const [moments, setMoments] = useState<BsPriceMoment[] | null>(null)
  const [adds, setAdds] = useState<BsAddToBalance[]>([])
  const [metric, setMetric] = useState<Metric>('volume')
  // A quarter, like the price chart's default window.
  const [rangeSeconds, setRangeSeconds] = useState(91 * DAY)

  useEffect(() => {
    if (!suckerGroupId) return
    let stopped = false
    getSuckerGroupMoments(suckerGroupId)
      .then(items => {
        if (!stopped) setMoments(items)
      })
      .catch(() => {
        if (!stopped) setMoments([])
      })
    getSuckerGroupAddToBalance(suckerGroupId)
      .then(items => {
        if (!stopped) setAdds(items)
      })
      .catch(() => {
        // Without the add-to-balance rows the volume series still shows
        // indexed payment volume; it just understates direct additions.
      })
    return () => {
      stopped = true
    }
  }, [suckerGroupId])

  const points = useMemo(
    () => (moments ? bucketize(moments, adds, metric, rangeSeconds) : []),
    [moments, adds, metric, rangeSeconds],
  )

  if (!suckerGroupId) return null
  if (moments !== null && points.length === 0) return null

  const selected = METRICS.find(item => item.value === metric)!
  const totalUsd = points.length ? points[points.length - 1].valueUsd : null

  return (
    <div className="card p-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col items-start gap-1">
        <span className="inline-flex font-agrandir text-2xl font-medium leading-none tabular-nums">
          {totalUsd !== null ? usd(totalUsd) : '—'}
        </span>
        <span className="relative inline-flex font-agrandir text-xs text-smoke-500">
          <select
            value={metric}
            onChange={event => setMetric(event.target.value as Metric)}
            aria-label="Choose which history to show"
            className="peer absolute inset-0 z-10 size-full cursor-pointer appearance-none opacity-0"
          >
            {METRICS.map(item => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
          <span
            aria-hidden="true"
            className="inline-flex items-center gap-1 peer-hover:text-smoke-700 peer-focus-visible:ring-2 peer-focus-visible:ring-bluebs-500"
          >
            {selected.label}
            <svg viewBox="0 0 8 5" className="h-[5px] w-2 fill-current">
              <path d="M0 0h8L4 5Z" />
            </svg>
          </span>
        </span>
        </div>
        <ChartRangeSelect
          ranges={RANGES}
          value={rangeSeconds}
          onChange={setRangeSeconds}
        />
      </div>
      <div className="mt-3">
        <SecuredReserveChart points={points} ariaLabel={selected.chartLabel} />
      </div>
    </div>
  )
}
