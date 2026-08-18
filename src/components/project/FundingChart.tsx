'use client'

import { useEffect, useMemo, useState } from 'react'
import { SecuredReserveChart } from '@/components/SecuredReserveChart'
import { ChartRangeSelect } from '@/components/project/StepChartBase'
import {
  getSuckerGroupMoments,
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

/** A moment's raw amount valued in USD at that moment's own indexed rate. */
function momentUsd(
  raw: string,
  rate: string | null | undefined,
  decimals: number,
): number | null {
  if (!rate) return null
  try {
    return (
      Number(BigInt(raw)) / 10 ** decimals * (Number(BigInt(rate)) / 1e18)
    )
  } catch {
    return null
  }
}

/**
 * Even time buckets from the first moment to now, forward-filling quiet
 * stretches so the bars read as a continuous history like the homepage chart.
 */
function bucketize(
  moments: BsPriceMoment[],
  metric: Metric,
  decimals: number,
  rangeSeconds: number,
): ReservePoint[] {
  const valued = moments
    .map(moment => ({
      timestamp: moment.timestamp,
      valueUsd: momentUsd(
        metric === 'volume' ? moment.volume : moment.balance,
        moment.accountingTokenUsdRate,
        decimals,
      ),
    }))
    .filter((point): point is ReservePoint => point.valueUsd !== null)
    .sort((a, b) => a.timestamp - b.timestamp)
  if (!valued.length) return []

  const t1 = Math.floor(Date.now() / 1000)
  const t0 = Math.max(
    valued[0].timestamp,
    rangeSeconds > 0 ? t1 - rangeSeconds : valued[0].timestamp,
  )
  const span = Math.max(t1 - t0, 1)
  const points: ReservePoint[] = []
  let index = 0
  let last = 0
  // Seed with the value standing when the window opens.
  while (index < valued.length && valued[index].timestamp <= t0) {
    last = valued[index].valueUsd
    index += 1
  }
  for (let bar = 0; bar < BARS; bar++) {
    const end = t0 + (span * (bar + 1)) / BARS
    while (index < valued.length && valued[index].timestamp <= end) {
      last = valued[index].valueUsd
      index += 1
    }
    points.push({ timestamp: Math.floor(end), valueUsd: last })
  }
  return points
}

/**
 * Volume/Balance history for non-revnet projects — the Overview counterpart
 * to the revnet price chart, in the homepage reserve chart's voice.
 */
export function FundingChart({
  suckerGroupId,
  accountingToken,
}: {
  suckerGroupId: string | null
  /** The group's single accounting-token shape; null (mixed contexts) hides
   *  the chart rather than mis-scaling raw amounts. */
  accountingToken: { symbol: string; decimals: number } | null
}) {
  const [moments, setMoments] = useState<BsPriceMoment[] | null>(null)
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
    return () => {
      stopped = true
    }
  }, [suckerGroupId])

  const points = useMemo(
    () =>
      moments && accountingToken
        ? bucketize(moments, metric, accountingToken.decimals, rangeSeconds)
        : [],
    [moments, metric, accountingToken, rangeSeconds],
  )

  if (!suckerGroupId || !accountingToken) return null
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
