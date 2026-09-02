'use client'

import { useState } from 'react'
import type { HomepageReserves } from '@/lib/homepage-reserves'
import { chainName } from '@/lib/urn'
import { ChainIcon } from './ChainIcon'
import { SecuredReserveChart } from './SecuredReserveChart'

function amount(value: number, maximumFractionDigits: number) {
  return value.toLocaleString('en-US', { maximumFractionDigits })
}

function usd(value: number) {
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

type Metric = 'secured' | 'passedThrough' | 'fees'

const METRICS: { value: Metric; label: string; chartLabel: string }[] = [
  {
    value: 'secured',
    label: 'Secured by Juicebox',
    chartLabel:
      'Cumulative secured reserve value over time, shown as bars. Focus and use arrow keys to inspect total and per-chain values.',
  },
  {
    value: 'passedThrough',
    label: 'Total passed through Juicebox',
    chartLabel:
      'Cumulative payment volume over time, shown as bars. Focus and use arrow keys to inspect values.',
  },
  {
    value: 'fees',
    label: 'Total fees to JBX',
    chartLabel:
      'Cumulative protocol fees over time, shown as bars. Focus and use arrow keys to inspect values.',
  },
]

export function SecuredReserves({ data }: { data: HomepageReserves }) {
  const [metric, setMetric] = useState<Metric>('secured')
  const selected = METRICS.find(item => item.value === metric)!
  const totalUsd =
    metric === 'secured'
      ? data.totalUsd
      : metric === 'passedThrough'
        ? data.passedThroughUsd
        : data.feesUsd
  const points =
    metric === 'secured'
      ? data.points
      : metric === 'passedThrough'
        ? data.volumePoints
        : data.feePoints

  return (
    <section className="flex flex-col gap-3 border-b border-smoke-200 pb-4 sm:gap-4">
      <div className="flex flex-col items-center gap-1 text-center md:items-start md:text-left">
        {metric === 'secured' ? (
          <span className="group relative inline-flex font-agrandir text-3xl font-medium leading-none sm:text-4xl">
            <span
              tabIndex={0}
              aria-describedby="secured-reserves-breakdown"
              className="cursor-help tabular-nums underline decoration-dotted decoration-smoke-400 underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-bluebs-500"
            >
              {usd(data.totalUsd)}
            </span>
            <span
              id="secured-reserves-breakdown"
              role="tooltip"
              className="pointer-events-none absolute left-1/2 top-full -translate-x-1/2 md:left-0 md:translate-x-0 z-20 mt-2 hidden w-64 rounded border border-smoke-200 bg-white px-3 py-2 text-left text-xs font-normal leading-relaxed text-smoke-700 shadow-lg group-hover:block group-focus-within:block"
            >
              {data.chains.map((chain, index) => {
                const hasReserves =
                  chain.eth > 0 ||
                  chain.usdc > 0 ||
                  chain.otherAssets.length > 0
                return (
                  <span
                    key={chain.chainId}
                    className={`block py-1.5 ${
                      index ? 'border-t border-smoke-100' : ''
                    }`}
                  >
                    <span className="block font-medium text-ink">
                      {chainName(chain.chainId)}
                    </span>
                    {hasReserves ? (
                      <>
                        {chain.eth > 0 ? (
                          <span className="block tabular-nums">
                            ETH: {amount(chain.eth, 3)}
                          </span>
                        ) : null}
                        {chain.usdc > 0 ? (
                          <span className="block tabular-nums">
                            USDC: {amount(chain.usdc, 2)}
                          </span>
                        ) : null}
                        {chain.otherAssets.length ? (
                          <span className="block">
                            Other: {chain.otherAssets.join(', ')}
                          </span>
                        ) : null}
                      </>
                    ) : (
                      <span className="block text-smoke-500">No reserves</span>
                    )}
                  </span>
                )
              })}
            </span>
          </span>
        ) : (
          <span className="inline-flex font-agrandir text-3xl font-medium leading-none tabular-nums sm:text-4xl">
            {usd(totalUsd)}
          </span>
        )}
        <span className="flex items-center gap-2 font-agrandir text-xs text-smoke-500 sm:text-sm">
          <span className="relative inline-flex">
            <select
              value={metric}
              onChange={event => setMetric(event.target.value as Metric)}
              aria-label="Choose which network total to show"
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
              <svg
                viewBox="0 0 8 5"
                className="h-[5px] w-2 fill-current"
              >
                <path d="M0 0h8L4 5Z" />
              </svg>
            </span>
          </span>
          <span
            className="inline-flex items-center gap-1"
            role="img"
            aria-label="Ethereum, Arbitrum, Base, and Optimism"
          >
            {[1, 42161, 8453, 10].map(chainId => (
              <ChainIcon key={chainId} chainId={chainId} size={14} />
            ))}
          </span>
        </span>
      </div>
      <SecuredReserveChart points={points} ariaLabel={selected.chartLabel} />
    </section>
  )
}
