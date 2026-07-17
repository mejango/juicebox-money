'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { BsFreshActivityEvent } from '@/lib/bendystraw'
import { timeAgo, truncateAddress } from '@/lib/format'
import { toUrn } from '@/lib/urn'
import { ActivityMeta } from './ActivityMeta'
import { ProjectLogo } from './ProjectLogo'

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
  const who = truncateAddress(event.from)
  const href = `/${toUrn(event.chainId, event.projectId)}`
  const pay = event.payEvent
  const cashOut = event.cashOutTokensEvent

  if (!pay && !cashOut) return null

  const isPay = !!pay
  const relativeTime = timeAgo(event.timestamp)

  return (
    <li className="px-4 py-4 transition-colors hover:bg-smoke-25">
      <div className="flex items-start gap-3">
        <Link href={href} aria-label={`Open ${name}`} className="shrink-0">
          <ProjectLogo
            name={name}
            logoUri={event.project?.logoUri ?? null}
            size={46}
          />
        </Link>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <Link
              href={href}
              className="min-w-0 truncate text-sm font-medium text-bluebs-600 hover:underline"
            >
              {name}
            </Link>
            <ActivityMeta
              chainId={event.chainId}
              txHash={event.txHash}
              amountUsd={pay?.amountUsd ?? cashOut?.reclaimAmountUsd}
              direction={isPay ? 'in' : 'out'}
            />
          </div>
          <p className="mt-1 break-words text-[13px] leading-relaxed text-ink">
            <span className="text-smoke-700">{who}</span>{' '}
            {isPay ? 'paid' : 'cashed out'}
          </p>
          <p className="mt-1 text-xs text-smoke-500">
            <span
              // Relative times drift between server render and hydration.
              suppressHydrationWarning
            >
              {relativeTime === 'now' ? 'now' : `${relativeTime} ago`}
            </span>
          </p>
        </div>
      </div>
    </li>
  )
}
