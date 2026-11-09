'use client'

import type { JBChainId } from '@bananapus/nana-sdk-core'
import { useLiveFeed } from '@/hooks/useLiveFeed'
import { useProjectTokenUnit } from '@/hooks/useProjectTokenUnit'
import type { BsFreshActivityEvent } from '@/lib/bendystraw'
import { timeAgo } from '@/lib/format'
import { toUrn } from '@/lib/urn'
import { ActorLink } from './ActorLink'
import { combinedActivityParts, feedAmountToken, groupSameTxEvents } from './ActivityList'
import { ActivityMeta } from './ActivityMeta'
import { LoadMoreRow } from './LoadMoreRow'
import { ProjectLogo } from './ProjectLogo'
import { ProjectLink } from './ProjectLink'

const POLL_MS = 15_000
const PAGE_SIZE = 8

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
  const feed = useLiveFeed({
    initial: initialEvents,
    initialMore: initialHasMore,
    updatedAt: 'mount',
    pollMs: POLL_MS,
    pollKey: 'fresh',
    read: async (offset, signal) => {
      const response = await fetch(`/api/activity?limit=${PAGE_SIZE}&offset=${offset}`, { signal })
      if (!response.ok) throw new Error('Activity unavailable')
      const page = (await response.json()) as { events?: BsFreshActivityEvent[]; hasMore?: boolean }
      return { items: page.events ?? [], more: Boolean(page.hasMore) }
    },
    failure: 'Could not load more activity. Try again.',
  })
  const events = feed.items

  return (
    <ul className="min-h-[420px] divide-y divide-smoke-100">
      {events.length === 0 ? (
        <li className="flex min-h-[420px] items-center justify-center px-6 text-center text-sm text-smoke-600">
          No recent activity yet.
        </li>
      ) : (
        <>
          {groupSameTxEvents(events).map((group, index) => (
            <Row key={group[0].id} group={group} eagerLogo={index < 4} />
          ))}
          {(feed.more || feed.loading) && (
            <LoadMoreRow label="More activity" loading={feed.loading} error={feed.error} onLoadMore={feed.loadMore} />
          )}
        </>
      )}
    </ul>
  )
}

function Row({
  group,
  eagerLogo,
}: {
  group: BsFreshActivityEvent[]
  eagerLogo: boolean
}) {
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
  const amountToken = feedAmountToken(parts, event.project, event.chainId)
  const actor = parts.actor
  const relativeTime = timeAgo(event.timestamp)
  const actorNode = <ActorLink actor={actor} />

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
            <span className="shrink-0 whitespace-nowrap" suppressHydrationWarning>
              {relativeTime === 'now' ? 'now' : `${relativeTime} ago`}
            </span>
            <ActivityMeta
              chainId={event.chainId}
              txHash={event.txHash}
              amountUsd={parts.amountUsd}
              amountToken={amountToken}
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
