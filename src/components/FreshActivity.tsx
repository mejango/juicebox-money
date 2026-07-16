'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { BsFreshActivityEvent } from '@/lib/bendystraw'
import { formatTokenAmount, timeAgo, truncateAddress } from '@/lib/format'
import { toUrn } from '@/lib/urn'
import { ChainBadge } from './ChainBadge'

const POLL_MS = 15_000

/**
 * The "Fresh activity" rail (DESIGN.md §Activity rail): latest V6 pay and
 * cash-out events across every project. Server-renders the initial rows,
 * then a lightweight poll keeps them fresh.
 */
export function FreshActivity({
  initialEvents,
}: {
  initialEvents: BsFreshActivityEvent[]
}) {
  const [events, setEvents] = useState(initialEvents)

  useEffect(() => {
    let stopped = false
    const tick = async () => {
      if (document.visibilityState === 'hidden') return
      try {
        const res = await fetch('/api/activity')
        if (!res.ok) return
        const json = (await res.json()) as {
          events?: BsFreshActivityEvent[]
        }
        if (!stopped && json.events?.length) setEvents(json.events)
      } catch {
        // Transient — the next tick retries.
      }
    }
    const t = setInterval(tick, POLL_MS)
    return () => {
      stopped = true
      clearInterval(t)
    }
  }, [])

  if (events.length === 0) {
    return (
      <p className="px-4 py-6 text-sm text-smoke-700">
        The chain is quiet right now — check back in a moment.
      </p>
    )
  }

  return (
    <ul className="divide-y divide-smoke-100">
      {events.map(event => (
        <Row key={event.id} event={event} />
      ))}
    </ul>
  )
}

function Row({ event }: { event: BsFreshActivityEvent }) {
  const name = event.project?.name ?? `Project ${event.projectId}`
  const decimals = event.project?.decimals ?? 18
  const symbol = event.project?.tokenSymbol ?? 'ETH'
  const who = truncateAddress(event.from)

  let line: React.ReactNode = null
  if (event.payEvent) {
    line = (
      <>
        <span className="text-smoke-700">{who}</span> paid{' '}
        <span className="font-bold text-ink">
          {formatTokenAmount(event.payEvent.amount, decimals)} {symbol}
        </span>{' '}
        <span aria-hidden className="text-smoke-500">
          →
        </span>{' '}
        <span className="font-medium text-bluebs-600">{name}</span>
      </>
    )
  } else if (event.cashOutTokensEvent) {
    line = (
      <>
        <span className="text-smoke-700">{who}</span> cashed out{' '}
        <span className="font-bold text-bluebs-600">
          {formatTokenAmount(event.cashOutTokensEvent.cashOutCount, 18)} tokens
        </span>{' '}
        <span aria-hidden className="text-smoke-500">
          →
        </span>{' '}
        <span className="font-medium text-bluebs-600">{name}</span>
      </>
    )
  } else {
    return null
  }

  return (
    <li>
      <Link
        href={`/${toUrn(event.chainId, event.projectId)}`}
        className="flex items-start justify-between gap-3 px-4 py-3 transition-colors hover:bg-smoke-25"
      >
        <span className="min-w-0 break-words text-[13px] leading-relaxed">
          {line}
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1.5">
          <ChainBadge chainId={event.chainId} />
          <span
            className="text-xs text-smoke-500"
            // Relative times drift between server render and hydration.
            suppressHydrationWarning
          >
            {timeAgo(event.timestamp)}
          </span>
        </span>
      </Link>
    </li>
  )
}
