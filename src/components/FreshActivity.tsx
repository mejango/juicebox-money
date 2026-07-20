'use client'

import { JB_CHAINS, type JBChainId } from '@bananapus/nana-sdk-core'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { useProjectTokenUnit } from '@/hooks/useProjectTokenUnit'
import { BsFreshActivityEvent } from '@/lib/bendystraw'
import { formatCompactTokenAmount, timeAgo } from '@/lib/format'
import { toUrn } from '@/lib/urn'
import { ActivityMeta } from './ActivityMeta'
import { ActorLink } from './ActivityList'
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
  const href = `/${toUrn(event.chainId, event.projectId)}`
  const pay = event.payEvent
  const cashOut = event.cashOutTokensEvent
  const chainId = event.chainId as JBChainId

  const tokenUnit = useProjectTokenUnit(chainId, event.projectId)

  if (!pay && !cashOut) return null

  const isPay = !!pay
  const actor = pay?.beneficiary ?? cashOut?.beneficiary ?? event.from
  const actorUrl = JB_CHAINS[chainId]?.etherscanHostname
    ? `https://${JB_CHAINS[chainId].etherscanHostname}/address/${actor}`
    : null
  const rawTokenCount = pay?.newlyIssuedTokenCount ?? cashOut?.cashOutCount ?? '0'
  const tokenCount = formatCompactTokenAmount(rawTokenCount)
  const relativeTime = timeAgo(event.timestamp)
  const actorNode = <ActorLink href={actorUrl} actor={actor} />

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
          <div className="flex items-center justify-between gap-2 text-xs text-smoke-500">
            <span suppressHydrationWarning>
              {relativeTime === 'now' ? 'now' : `${relativeTime} ago`}
            </span>
            <ActivityMeta
              chainId={event.chainId}
              txHash={event.txHash}
              amountUsd={pay?.amountUsd ?? cashOut?.reclaimAmountUsd}
              direction={isPay ? 'in' : 'out'}
            />
          </div>
          <Link
            href={href}
            className="mt-1 block min-w-0 truncate text-sm font-medium text-bluebs-600 hover:underline"
          >
            {name}
          </Link>
          <p className="mt-1 break-words text-[13px] leading-relaxed text-ink">
            {actorNode} {isPay ? 'got' : 'cashed out'}{' '}
            <span className="font-medium text-bluebs-600">
              {tokenCount} {tokenUnit}
            </span>
          </p>
        </div>
      </div>
    </li>
  )
}
