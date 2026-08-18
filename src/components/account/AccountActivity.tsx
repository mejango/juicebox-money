'use client'

import type { JBChainId } from '@bananapus/nana-sdk-core'
import { useEffect, useState } from 'react'
import { ActorLink } from '@/components/ActorLink'
import {
  combinedActivityParts,
  groupSameTxEvents,
  mergeActivityEvents,
} from '@/components/ActivityList'
import { ActivityAmountLine } from '@/components/ActivityMeta'
import { ProjectLogo } from '@/components/ProjectLogo'
import { ProjectLink } from '@/components/ProjectLink'
import { useProjectTokenUnit } from '@/hooks/useProjectTokenUnit'
import { getAccountActivity, type BsAccountActivityEvent } from '@/lib/bendystraw'
import { explorerHostname } from '@/lib/chainDisplay'
import { formatDate, timeAgo } from '@/lib/format'
import { legacyProjectHref, toUrn } from '@/lib/urn'

const ACCOUNT_ACTIVITY_PAGE = 25
const ACTIVITY_POLL_MS = 15_000

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

  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return
    let stopped = false

    const refresh = async () => {
      if (document.visibilityState === 'hidden') return
      try {
        const page = await getAccountActivity(address, {
          limit: ACCOUNT_ACTIVITY_PAGE,
          offset: 0,
        })
        if (stopped) return
        setEvents(current => mergeActivityEvents(current, page.items))
        setTotal(page.totalCount)
      } catch {
        // Keep the last known-good page; the next poll retries.
      }
    }

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void refresh()
    }
    const timer = window.setInterval(() => void refresh(), ACTIVITY_POLL_MS)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      stopped = true
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [address])

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
        {groupSameTxEvents(events).map(group => (
          <Row key={group[0].id} group={group} />
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

function Row({ group }: { group: BsAccountActivityEvent[] }) {
  const event = group[0]
  const name = event.project?.name ?? `Project ${event.projectId}`
  const isV6 = event.version === 6
  // An account's history spans protocol versions. A V4/V5 row is still a real
  // project — it lives on the legacy app, so link it there rather than rendering
  // a dead name.
  const projectHref = isV6
    ? `/${toUrn(event.chainId, event.projectId)}`
    : legacyProjectHref(event.chainId, event.projectId, event.version)
  const projectHint = {
    name,
    logoUri: event.project?.logoUri ?? null,
  }
  // The V6 token unit is resolved onchain; earlier-version rows keep the
  // generic word rather than reading the wrong protocol's contracts.
  const v6TokenUnit = useProjectTokenUnit(
    event.chainId as JBChainId,
    event.projectId,
  )
  const tokenUnit = isV6 ? v6TokenUnit : 'tokens'
  const { actor, actions, direction, memo, amountUsd } = combinedActivityParts(
    group,
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
        {isV6 ? (
          <ProjectLink
            href={projectHref}
            projectHint={projectHint}
            aria-label={`Open ${name}`}
            className="shrink-0"
          >
            {logo}
          </ProjectLink>
        ) : (
          <a href={projectHref} aria-label={`Open ${name}`} className="shrink-0">
            {logo}
          </a>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2 text-xs text-smoke-500">
            {/* Actor left, time right, then the flow line. */}
            <span className="min-w-0 truncate">
              <ActorLink href={actorUrl} actor={actor} />
            </span>
            {txLink ? (
              <a
                href={txLink}
                target="_blank"
                rel="noopener noreferrer"
                title={formatDate(event.timestamp)}
                className="shrink-0 hover:text-ink hover:underline"
                suppressHydrationWarning
              >
                {relativeTime === 'now' ? 'now' : `${relativeTime} ago`}
              </a>
            ) : (
              <span
                className="shrink-0"
                title={formatDate(event.timestamp)}
                suppressHydrationWarning
              >
                {relativeTime === 'now' ? 'now' : `${relativeTime} ago`}
              </span>
            )}
          </div>
          <ActivityAmountLine
            chainId={event.chainId}
            txHash={event.txHash}
            amountUsd={amountUsd}
            direction={direction}
          />
          {isV6 ? (
            <ProjectLink
              href={projectHref}
              projectHint={projectHint}
              className="mt-1 block min-w-0 truncate text-sm font-medium text-bluebs-600 hover:underline"
            >
              {name}
            </ProjectLink>
          ) : (
            <a
              href={projectHref}
              className="mt-1 block min-w-0 truncate text-sm font-medium text-bluebs-600 hover:underline"
            >
              {name} <span className="text-xs text-smoke-500">V{event.version}</span>
            </a>
          )}
          {/* Same shape as the project feed: time | actor above, then the
              memo headline and the actions as fine-print bullets. */}
          {memo ? (
            <p className="mt-2 break-words text-[13px] leading-relaxed text-ink">
              “{memo}”
            </p>
          ) : null}
          <ul className={`${memo ? 'mt-1' : 'mt-2'} space-y-0.5 text-xs text-smoke-500`}>
            {actions.map((action, index) => (
              <li
                key={index}
                className="relative break-words pl-3.5 before:absolute before:left-0 before:text-smoke-300 before:content-['•']"
              >
                {action}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </li>
  )
}
