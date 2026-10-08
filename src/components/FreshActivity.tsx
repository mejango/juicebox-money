'use client'

import type { JBChainId } from '@bananapus/nana-sdk-core'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useProjectTokenUnit } from '@/hooks/useProjectTokenUnit'
import { useInfiniteScroll } from '@/hooks/useInfiniteScroll'
import type { BsFreshActivityEvent } from '@/lib/bendystraw'
import { explorerHostname } from '@/lib/chainDisplay'
import { timeAgo } from '@/lib/format'
import { toUrn } from '@/lib/urn'
import { ActorLink } from './ActorLink'
import { combinedActivityParts, groupSameTxEvents } from './ActivityList'
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
  const listRef = useRef<HTMLUListElement>(null)
  const [events, setEvents] = useState(initialEvents)
  const [hasMore, setHasMore] = useState(initialHasMore)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const list = listRef.current
    if (!list) return
    const isVisible = () =>
      document.visibilityState !== 'hidden' && list.getClientRects().length > 0
    let active = isVisible()
    let stopped = false
    let timer: ReturnType<typeof setInterval> | undefined
    let inFlight: AbortController | undefined
    let refreshOnResume = false

    const tick = async () => {
      if (stopped || !active || inFlight) return
      if (!isVisible()) {
        updateVisibility()
        return
      }
      refreshOnResume = false
      const controller = new AbortController()
      inFlight = controller
      try {
        const res = await fetch(`/api/activity?limit=${PAGE_SIZE}&offset=0`, {
          signal: controller.signal,
        })
        if (!res.ok) return
        const json = (await res.json()) as {
          events?: BsFreshActivityEvent[]
        }
        if (!stopped && !controller.signal.aborted && isVisible() && json.events?.length) {
          setEvents(current => [
            ...json.events!,
            ...current.filter(
              event => !json.events!.some(fresh => fresh.id === event.id),
            ),
          ])
        }
      } catch {
        // Transient — the next visible tick retries.
      } finally {
        inFlight = undefined
        // A reveal may have happened while an aborted request was still settling.
        if (refreshOnResume && !stopped && active) void tick()
      }
    }
    function updateVisibility() {
      if (stopped) return
      const visible = isVisible()
      if (visible === active) return
      active = visible
      clearInterval(timer)
      refreshOnResume = visible
      if (visible) {
        timer = setInterval(tick, POLL_MS)
        void tick()
      } else {
        inFlight?.abort()
      }
    }

    // Preserve server rows without an immediate duplicate fetch on initial display.
    if (active) timer = setInterval(tick, POLL_MS)
    const observer = typeof ResizeObserver === 'undefined'
      ? undefined
      : new ResizeObserver(updateVisibility)
    observer?.observe(list)
    // Older browsers still detect hidden ancestor classes and viewport changes.
    const fallback = !observer && typeof MutationObserver !== 'undefined'
      ? new MutationObserver(updateVisibility)
      : undefined
    for (let node: HTMLElement | null = list; fallback && node; node = node.parentElement) {
      fallback.observe(node, { attributes: true, attributeFilter: ['class', 'style', 'hidden'] })
    }
    if (!observer) window.addEventListener('resize', updateVisibility)
    document.addEventListener('visibilitychange', updateVisibility)
    return () => {
      stopped = true
      clearInterval(timer)
      inFlight?.abort()
      observer?.disconnect()
      fallback?.disconnect()
      if (!observer) window.removeEventListener('resize', updateVisibility)
      document.removeEventListener('visibilitychange', updateVisibility)
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
    <ul ref={listRef} className="min-h-[420px] divide-y divide-smoke-100">
      {events.length === 0 ? (
        <li className="flex min-h-[420px] items-center justify-center px-6 text-center text-sm text-smoke-600">
          No recent activity yet.
        </li>
      ) : (
        <>
          {groupSameTxEvents(events).map(group => (
            <Row key={group[0].id} group={group} />
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

function Row({ group }: { group: BsFreshActivityEvent[] }) {
  const event = group[0]
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

  const parts = combinedActivityParts(group, tokenUnit)
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
          />
        </ProjectLink>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2 text-xs text-smoke-500">
            <span className="shrink-0 whitespace-nowrap" suppressHydrationWarning>
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
