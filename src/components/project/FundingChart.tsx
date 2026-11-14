'use client'

import { useEffect, useMemo, useState } from 'react'
import { SecuredReserveChart } from '@/components/SecuredReserveChart'
import { ChartRangeSelect } from '@/components/project/StepChartBase'
import { JBCoreContracts, jbV6ContractAddress, type JBChainId } from '@bananapus/nana-sdk-core'
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { formatUnits, type Address, type PublicClient } from 'viem'
import { useConfig } from 'wagmi'
import { getPublicClient } from 'wagmi/actions'
import { readTreasuryUsdPrice } from '@/components/project/ProjectStats'
import {
  getDeploymentTokenBalanceMoments,
  getSuckerGroupAddToBalance,
  getSuckerGroupMoments,
  type BsAddToBalance,
  type BsPriceMoment,
  type BsTokenBalanceMoment,
} from '@/lib/bendystraw'
import { accountingContextsQuery } from '@/lib/project-display-queries'
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
      'What the project held over time at today’s prices, shown as bars. Focus and use arrow keys to inspect values.',
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

type UsdEvent = { timestamp: number; key?: string; base?: number; add?: number }

/**
 * Even time buckets from the first event to now, forward-filling quiet
 * stretches so the bars read as a continuous history like the homepage chart.
 * Each keyed event replaces that key's standing value; the bar is the sum of
 * the standing values plus every unkeyed addition so far.
 */
export function bucketize(events: UsdEvent[], rangeSeconds: number): ReservePoint[] {
  events = [...events].sort((a, b) => a.timestamp - b.timestamp)
  if (!events.length) return []

  const t1 = Math.floor(Date.now() / 1000)
  const t0 = Math.max(
    events[0].timestamp,
    rangeSeconds > 0 ? t1 - rangeSeconds : events[0].timestamp,
  )
  const span = Math.max(t1 - t0, 1)
  const points: ReservePoint[] = []
  const standing = new Map<string, number>()
  let index = 0
  let total = 0
  const consume = (limit: number) => {
    while (index < events.length && events[index].timestamp <= limit) {
      const event = events[index]
      if (event.base !== undefined) {
        const key = event.key ?? ''
        total += event.base - (standing.get(key) ?? 0)
        standing.set(key, event.base)
      }
      if (event.add !== undefined) total += event.add
      index += 1
    }
  }
  // Seed with the state standing when the window opens.
  consume(t0)
  for (let bar = 0; bar < BARS; bar++) {
    const end = t0 + (span * (bar + 1)) / BARS
    consume(end)
    points.push({ timestamp: Math.floor(end), valueUsd: Math.max(0, total) })
  }
  return points
}

const usd18 = (raw: string) => Number(BigInt(raw)) / 1e18

/**
 * Cumulative intake: indexed payment volume plus funds added straight to the
 * terminal, each at its own time's USD value, so it only rises.
 */
export function volumeEvents(moments: BsPriceMoment[], adds: BsAddToBalance[]): UsdEvent[] {
  const events: UsdEvent[] = []
  for (const moment of moments) {
    try {
      events.push({ timestamp: moment.timestamp, base: usd18(moment.volumeUsd) })
    } catch {
      // Skip an unparseable row.
    }
  }
  for (const add of adds) {
    try {
      events.push({ timestamp: add.timestamp, add: usd18(add.amountUsd) })
    } catch {
      // Skip an unparseable row.
    }
  }
  return events
}

export const rateKey = (chainId: number, token: string) => `${chainId}:${token.toLowerCase()}`

/**
 * What the project held over time, every amount at today's price, so the
 * curve moves only when funds move and ends on what the project holds now.
 * `todayRates` is USD per whole token by `rateKey`; a token with no live
 * price uses the newest rate the indexer recorded for it.
 */
export function holdingsEvents(
  moments: BsTokenBalanceMoment[],
  todayRates: ReadonlyMap<string, number>,
): UsdEvent[] {
  const indexed = new Map<string, number>()
  for (const moment of moments) {
    if (moment.tokenUsdRate) indexed.set(rateKey(moment.chainId, moment.token), usd18(moment.tokenUsdRate))
  }
  const events: UsdEvent[] = []
  for (const moment of moments) {
    const key = rateKey(moment.chainId, moment.token)
    const rate = todayRates.get(key) ?? indexed.get(key) ?? 0
    try {
      events.push({
        timestamp: moment.timestamp,
        key: `${moment.projectId}:${key}`,
        base: Number(formatUnits(BigInt(moment.balance), moment.decimals)) * rate,
      })
    } catch {
      // Skip an unparseable row.
    }
  }
  return events
}

/**
 * What to say beside the Balance figure when it is not every holding at a
 * live price: a token with no price at all is left out of the dollars, and a
 * token priced from the indexer's newest rate is recent, not live.
 */
export function holdingsNote(
  moments: BsTokenBalanceMoment[],
  todayRates: ReadonlyMap<string, number>,
): string | null {
  const indexed = new Set<string>()
  for (const moment of moments) {
    if (moment.tokenUsdRate) indexed.add(rateKey(moment.chainId, moment.token))
  }
  const keys = [...new Set(moments.map(moment => rateKey(moment.chainId, moment.token)))]
  if (keys.some(key => !todayRates.has(key) && !indexed.has(key))) return 'Leaves out tokens with no dollar price.'
  if (keys.some(key => !todayRates.has(key))) return 'Some prices are recent, not live.'
  return null
}

/** Today's USD price of each token the deployments accept. A failed read leaves the token out. */
async function readTodayRates(
  config: ReturnType<typeof useConfig>,
  reader: Pick<QueryClient, 'fetchQuery'>,
  chains: [number, number][],
): Promise<Map<string, number>> {
  const rates = new Map<string, number>()
  await Promise.all(
    chains.map(async ([rawChainId, rawProjectId]) => {
      const chainId = rawChainId as JBChainId
      const client = getPublicClient(config, { chainId }) as PublicClient | undefined
      const prices = jbV6ContractAddress[JBCoreContracts.JBPrices][chainId] as Address | undefined
      if (!client || !prices) return
      try {
        const projectId = BigInt(rawProjectId)
        const contexts = await reader.fetchQuery(accountingContextsQuery(client, { chainId, projectId }))
        await Promise.all(
          contexts.map(async context => {
            const price = await readTreasuryUsdPrice(client, prices, projectId, context.currency).catch(() => null)
            if (price != null) rates.set(rateKey(chainId, context.token), Number(formatUnits(price, 18)))
          }),
        )
      } catch {
        // The indexed rate stands in.
      }
    }),
  )
  return rates
}

/**
 * Volume/Balance history for non-revnet projects — the Overview counterpart
 * to the revnet price chart, in the homepage reserve chart's voice.
 */
export function FundingChart({
  suckerGroupId,
  chains,
}: {
  suckerGroupId: string | null
  /** [chainId, projectId] pairs across the sucker group. */
  chains: [number, number][]
}) {
  const config = useConfig()
  const queryClient = useQueryClient()
  const [moments, setMoments] = useState<BsPriceMoment[] | null>(null)
  const [adds, setAdds] = useState<BsAddToBalance[]>([])
  const [held, setHeld] = useState<BsTokenBalanceMoment[]>([])
  const chainsKey = JSON.stringify(chains)
  const { data: todayRates } = useQuery({
    queryKey: ['fundingChartRates', chainsKey],
    staleTime: 60_000,
    queryFn: () => readTodayRates(config, queryClient, chains),
  })
  const [metric, setMetric] = useState<Metric>('volume')
  // A quarter, like the price chart's default window.
  const [rangeSeconds, setRangeSeconds] = useState(91 * DAY)

  useEffect(() => {
    if (!suckerGroupId) return
    let stopped = false
    // Leaving the chart stops its indexed reads.
    const left = new AbortController()
    const { signal } = left
    getSuckerGroupMoments(suckerGroupId, { signal })
      .then(items => {
        if (!stopped) setMoments(items)
      })
      .catch(() => {
        if (!stopped) setMoments([])
      })
    getSuckerGroupAddToBalance(suckerGroupId, { signal })
      .then(items => {
        if (!stopped) setAdds(items)
      })
      .catch(() => {
        // Without the add-to-balance rows the volume series still shows
        // indexed payment volume; it just understates direct additions.
      })
    getDeploymentTokenBalanceMoments(JSON.parse(chainsKey) as [number, number][], { signal })
      .then(items => {
        if (!stopped) setHeld(items)
      })
      .catch(() => {
        // Without the holdings history the balance series stays empty.
      })
    return () => {
      stopped = true
      left.abort()
    }
  }, [suckerGroupId, chainsKey])

  const points = useMemo(
    () =>
      moments
        ? bucketize(
            metric === 'volume'
              ? volumeEvents(moments, adds)
              : holdingsEvents(held, todayRates ?? new Map()),
            rangeSeconds,
          )
        : [],
    [moments, adds, held, todayRates, metric, rangeSeconds],
  )

  if (!suckerGroupId) return null
  if (moments !== null && moments.length === 0 && held.length === 0) return null

  const selected = METRICS.find(item => item.value === metric)!
  // Until the live prices answer, nothing is said about them.
  const note = metric === 'balance' && todayRates ? holdingsNote(held, todayRates) : null
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
      {note ? <p className="mt-2 text-xs text-smoke-500">{note}</p> : null}
    </div>
  )
}
