'use client'

import type { JBChainId } from '@bananapus/nana-sdk-core'
import Link from 'next/link'
import { useState } from 'react'
import { activityParts, ActorLink } from '@/components/ActivityList'
import { ActivityMeta } from '@/components/ActivityMeta'
import { ProjectLogo } from '@/components/ProjectLogo'
import { useProjectTokenUnit } from '@/hooks/useProjectTokenUnit'
import { getAccountActivity, type BsAccountActivityEvent } from '@/lib/bendystraw'
import { explorerHostname } from '@/lib/chainDisplay'
import { formatDate, timeAgo } from '@/lib/format'
import { toUrn } from '@/lib/urn'

export const ACCOUNT_ACTIVITY_PAGE = 25

/**
 * Everything the account did, across projects and chains, with a load-more
 * cursor. Rows follow the multi-project Fresh-activity shape (project logo +
 * name) with the project feed's full event interpretation.
 */
export function AccountActivity({
  address,
  initialEvents,
  totalCount,
}: {
  address: string
  initialEvents: BsAccountActivityEvent[]
  totalCount: number
}) {
  const [events, setEvents] = useState(initialEvents)
  const [total, setTotal] = useState(totalCount)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadMore = async () => {
    setLoading(true)
    setError(null)
    try {
      const page = await getAccountActivity(address, {
        limit: ACCOUNT_ACTIVITY_PAGE,
        offset: events.length,
      })
      setEvents(previous => {
        const seen = new Set(previous.map(event => event.id))
        return [...previous, ...page.items.filter(event => !seen.has(event.id))]
      })
      setTotal(page.totalCount)
    } catch {
      setError('Could not load more activity. Try again.')
    } finally {
      setLoading(false)
    }
  }

  if (events.length === 0) {
    return (
      <div className="card flex min-h-[120px] items-center justify-center px-6 text-center text-sm text-smoke-600">
        No onchain activity for this account yet.
      </div>
    )
  }

  return (
    <div>
      <ul className="card divide-y divide-smoke-100 px-4 py-1">
        {events.map(event => (
          <Row key={event.id} event={event} />
        ))}
      </ul>
      {events.length < total ? (
        <div className="mt-4 flex flex-col items-center gap-2">
          <button
            onClick={loadMore}
            disabled={loading}
            className="btn-secondary min-h-[40px] px-5 text-sm"
          >
            {loading
              ? 'Loading…'
              : `Load more (${events.length} of ${total})`}
          </button>
          {error ? <p className="text-xs text-crush-600">{error}</p> : null}
        </div>
      ) : null}
    </div>
  )
}

function Row({ event }: { event: BsAccountActivityEvent }) {
  const name = event.project?.name ?? `Project ${event.projectId}`
  const isV6 = event.version === 6
  const projectHref = isV6 ? `/${toUrn(event.chainId, event.projectId)}` : null
  // The V6 token unit is resolved onchain; earlier-version rows keep the
  // generic word rather than reading the wrong protocol's contracts.
  const v6TokenUnit = useProjectTokenUnit(
    event.chainId as JBChainId,
    event.projectId,
  )
  const tokenUnit = isV6 ? v6TokenUnit : 'tokens'
  const { actor, action, direction, memo, amountUsd } = activityParts(
    event,
    tokenUnit,
  )
  const explorer = explorerHostname(event.chainId)
  const actorUrl =
    actor && explorer ? `https://${explorer}/address/${actor}` : null
  const txLink = explorer
    ? `https://${explorer}/tx/${event.txHash}`
    : null
  const relativeTime = timeAgo(event.timestamp)
  const logo = (
    <ProjectLogo
      name={name}
      logoUri={event.project?.logoUri ?? null}
      size={46}
    />
  )

  return (
    <li className="px-0 py-4">
      <div className="flex items-start gap-3">
        {projectHref ? (
          <Link
            href={projectHref}
            aria-label={`Open ${name}`}
            className="shrink-0"
          >
            {logo}
          </Link>
        ) : (
          <span className="shrink-0">{logo}</span>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2 text-xs text-smoke-500">
            {txLink ? (
              <a
                href={txLink}
                target="_blank"
                rel="noopener noreferrer"
                title={formatDate(event.timestamp)}
                className="hover:text-ink hover:underline"
                suppressHydrationWarning
              >
                {relativeTime === 'now' ? 'now' : `${relativeTime} ago`}
              </a>
            ) : (
              <span
                title={formatDate(event.timestamp)}
                suppressHydrationWarning
              >
                {relativeTime === 'now' ? 'now' : `${relativeTime} ago`}
              </span>
            )}
            <ActivityMeta
              chainId={event.chainId}
              txHash={event.txHash}
              amountUsd={amountUsd}
              direction={direction}
            />
          </div>
          {projectHref ? (
            <Link
              href={projectHref}
              className="mt-1 block min-w-0 truncate text-sm font-medium text-bluebs-600 hover:underline"
            >
              {name}
            </Link>
          ) : (
            <span className="mt-1 block min-w-0 truncate text-sm font-medium text-smoke-700">
              {name} <span className="text-xs text-smoke-500">V{event.version}</span>
            </span>
          )}
          <p className="mt-1 break-words text-[13px] leading-relaxed text-ink">
            <ActorLink href={actorUrl} actor={actor} /> {action}
          </p>
          {memo ? (
            <p className="mt-0.5 break-words text-xs italic text-smoke-500">
              “{memo}”
            </p>
          ) : null}
        </div>
      </div>
    </li>
  )
}
