'use client'

import type { JBChainId } from '@bananapus/nana-sdk-core'
import { useCallback, useEffect, useState } from 'react'
import { useProjectTokenUnit } from '@/hooks/useProjectTokenUnit'
import { useInfiniteScroll } from '@/hooks/useInfiniteScroll'
import type { BsFreshActivityEvent } from '@/lib/bendystraw'
import { explorerHostname } from '@/lib/chainDisplay'
import { timeAgo } from '@/lib/format'
import { toUrn } from '@/lib/urn'
import { ActorLink } from './ActorLink'
import { activityParts } from './ActivityList'
import { ActivityMeta } from './ActivityMeta'
import { ProjectLogo } from './ProjectLogo'
import { ProjectLink } from './ProjectLink'

const POLL_MS = 15_000
const PAGE_SIZE = 8

function hasPositiveIndexedAmount(value: string | null | undefined): boolean {
  if (!value) return false
  try {
    return BigInt(value) > 0n
  } catch {
    return false
  }
}

/**
 * The "Fresh activity" rail: latest project-oriented V6 events. Server-renders the initial rows,
 * then a lightweight poll keeps them fresh.
 */
export function FreshActivity({
  initialEvents,
  initialHasMore,
}: {
  initialEvents: BsFreshActivityEvent[]
  initialHasMore: boolean
}) {
  const [events, setEvents] = useState(initialEvents)
  const [hasMore, setHasMore] = useState(initialHasMore)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let stopped = false
    const tick = async () => {
      if (document.visibilityState === 'hidden') return
      try {
        const res = await fetch(`/api/activity?limit=${PAGE_SIZE}&offset=0`)
        if (!res.ok) return
        const json = (await res.json()) as {
          events?: BsFreshActivityEvent[]
        }
        if (!stopped && json.events?.length) {
          setEvents(current => [
            ...json.events!,
            ...current.filter(
              event => !json.events!.some(fresh => fresh.id === event.id),
            ),
          ])
        }
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

  const loadMore = useCallback(async () => {
    if (loading || !hasMore) return
    setLoading(true)
    try {
      const response = await fetch(
        `/api/activity?limit=${PAGE_SIZE}&offset=${events.length}`,
      )
      if (!response.ok) throw new Error('Activity unavailable')
      const page = (await response.json()) as {
        events?: BsFreshActivityEvent[]
        hasMore?: boolean
      }
      const next = page.events ?? []
      setEvents(current => [
        ...current,
        ...next.filter(
          event => !current.some(existing => existing.id === event.id),
        ),
      ])
      setHasMore(Boolean(page.hasMore))
    } catch {
      setHasMore(false)
    } finally {
      setLoading(false)
    }
  }, [events.length, hasMore, loading])
  const markerRef = useInfiniteScroll({ hasMore, loading, loadMore })

  return (
    <ul className="min-h-[420px] divide-y divide-smoke-100">
      {events.length === 0 ? (
        <li className="flex min-h-[420px] items-center justify-center px-6 text-center text-sm text-smoke-600">
          No recent activity yet.
        </li>
      ) : (
        <>
          {events.map((event, index) => (
            <Row key={event.id} event={event} eagerLogo={index < 4} />
          ))}
          {(hasMore || loading) && (
            <li
              ref={markerRef}
              className="flex h-16 items-center justify-center text-xs text-smoke-500"
              aria-live="polite"
            >
              <span className={loading ? 'animate-pulse' : ''}>
                {loading ? 'Loading more activity…' : 'More activity'}
              </span>
            </li>
          )}
        </>
      )}
    </ul>
  )
}

function Row({
  event,
  eagerLogo,
}: {
  event: BsFreshActivityEvent
  eagerLogo: boolean
}) {
  const name = event.project?.name ?? `Project ${event.projectId}`
  const href = `/${toUrn(event.chainId, event.projectId)}`
  const projectHint = {
    name,
    logoUri: event.project?.logoUri ?? null,
  }
  // Bendystraw's project.tokenSymbol is the accounting token (ETH/USDC),
  // not the project's issued token. Resolve the latter on-chain so projects
  // without an ERC-20 correctly say "token credits".
  const tokenUnit = useProjectTokenUnit(
    event.chainId as JBChainId,
    event.projectId,
  )

  const parts = activityParts(event, tokenUnit)
  const rawAmountFallback =
    !hasPositiveIndexedAmount(parts.amountUsd) &&
    event.project?.tokenSymbol &&
    event.project.decimals !== null
      ? {
          raw: parts.amountRaw,
          symbol: event.project.tokenSymbol.replace(/^\$+/, ''),
          decimals: event.project.decimals,
        }
      : null
  const actor = parts.actor
  const explorer = explorerHostname(event.chainId)
  const actorUrl = explorer
    ? `https://${explorer}/address/${actor}`
    : null
  const relativeTime = timeAgo(event.timestamp)
  const actorNode = <ActorLink href={actorUrl} actor={actor} />

  return (
    <li className="h-28 overflow-hidden px-4 py-3 transition-colors hover:bg-smoke-25">
      <div className="flex items-start gap-3">
        <ProjectLink
          href={href}
          projectHint={projectHint}
          aria-label={`Open ${name} activity`}
          className="shrink-0"
        >
          <ProjectLogo
            name={name}
            logoUri={event.project?.logoUri ?? null}
            size={46}
            eager={eagerLogo}
          />
        </ProjectLink>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2 text-xs text-smoke-500">
            <span suppressHydrationWarning>
              {relativeTime === 'now' ? 'now' : `${relativeTime} ago`}
            </span>
            <ActivityMeta
              chainId={event.chainId}
              txHash={event.txHash}
              amountUsd={parts.amountUsd}
              amountToken={rawAmountFallback}
              direction={parts.direction}
            />
          </div>
          <ProjectLink
            href={href}
            projectHint={projectHint}
            className="mt-1 block min-w-0 truncate text-sm font-medium text-bluebs-600 hover:underline"
          >
            {name}
          </ProjectLink>
          <p className="mt-1 line-clamp-2 break-words text-[13px] leading-relaxed text-ink">
            {actorNode} {parts.action}
          </p>
        </div>
      </div>
    </li>
  )
}
