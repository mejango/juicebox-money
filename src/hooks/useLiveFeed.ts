'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useUnmountSignal } from '@/hooks/useUnmountSignal'
import type { BsActivityEvent } from '@/lib/bendystraw'

/**
 * Merge a fetched page into the feed, deduped by id and re-sorted newest-first.
 *
 * Incoming rows are NOT simply prepended: the same merge serves both the poll (newer
 * rows, which belong at the top) and "load more" (an older page, which belongs at the
 * bottom). Sorting on the server's own ordering key is the only thing that keeps both
 * correct, with the id as a stable tiebreak for same-timestamp rows.
 */
export function mergeActivityEvents<T extends BsActivityEvent>(
  current: T[],
  incoming: T[],
): T[] {
  const incomingIds = new Set(incoming.map(event => event.id))
  return [...incoming, ...current.filter(event => !incomingIds.has(event.id))].sort(
    (a, b) => b.timestamp - a.timestamp || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
  )
}

/** One page of a feed: its rows, and the feed's indexed total or its own "more" flag. */
export type LiveFeedPage<T> = { items: T[]; total?: number; more?: boolean }

export type LiveFeedLoad = { status: 'ready' } | { status: 'loading' } | { status: 'failed'; error: string }

/**
 * An activity feed that stays fresh: its newest page is read again every
 * `pollMs` while the tab is visible (and when it becomes visible), merged on
 * top of the rows already shown, and `loadMore` appends older pages. A failed
 * older page keeps the control, with `failure` as its line, so it retries.
 */
export function useLiveFeed<T extends BsActivityEvent>({
  initial,
  initialTotal,
  initialMore = false,
  updatedAt,
  pollMs,
  pollKey,
  read,
  failure,
}: {
  initial: T[]
  /** Rows the feed has in all, when it counts them; otherwise `initialMore` says if more exist. */
  initialTotal?: number
  initialMore?: boolean
  /** When `initial` was read (epoch ms), 'mount' for this mount; unset reads the newest page at once. */
  updatedAt?: number | 'mount'
  pollMs: number
  /** The feed's identity: a new key restarts the poll. */
  pollKey: string
  read: (offset: number, signal: AbortSignal) => Promise<LiveFeedPage<T>>
  failure: string
}) {
  const [feed, setFeed] = useState({ items: initial, total: initialTotal, more: initialMore })
  const [load, setLoad] = useState<LiveFeedLoad>({ status: 'ready' })
  /** A newest-page read succeeded since `initial`. */
  const [refreshed, setRefreshed] = useState(false)
  const [mountedAt] = useState(() => Date.now())
  // Older pages load while the list is shown; leaving it stops the one under way.
  const listSignal = useUnmountSignal()
  const reader = useRef(read)
  useEffect(() => { reader.current = read })

  useEffect(() => {
    setFeed({ items: initial, total: initialTotal, more: initialMore })
    setRefreshed(false)
  }, [initial, initialTotal, initialMore])

  const firstReadAt = updatedAt === 'mount' ? mountedAt : updatedAt
  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return
    let stopped = false
    let refreshing = false
    let readAt = firstReadAt
    let timer: number | undefined
    // The poll's reads stop with it.
    const polling = new AbortController()

    const schedule = (delay: number) => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => void refresh(), delay)
    }

    const refresh = async () => {
      if (stopped || refreshing || document.visibilityState === 'hidden') return
      const age = readAt === undefined ? Infinity : Date.now() - readAt
      if (age >= 0 && age < pollMs) {
        schedule(pollMs - age)
        return
      }
      refreshing = true
      try {
        const page = await reader.current(0, polling.signal)
        if (stopped) return
        readAt = Date.now()
        // The newest page only; merging keeps whatever "Load more" already pulled in.
        setFeed(current => ({
          items: mergeActivityEvents(current.items, page.items),
          total: page.total ?? current.total,
          more: current.more,
        }))
        setRefreshed(true)
      } catch {
        // Keep the last known-good feed; the next poll retries.
      } finally {
        refreshing = false
        if (!stopped) schedule(pollMs)
      }
    }

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void refresh()
    }
    void refresh()
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      stopped = true
      polling.abort()
      window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [pollKey, firstReadAt, pollMs])

  const more = feed.total !== undefined ? feed.items.length < feed.total : feed.more
  const loading = load.status === 'loading'
  const offset = feed.items.length
  const loadMore = useCallback(async () => {
    if (loading) return
    setLoad({ status: 'loading' })
    try {
      const page = await reader.current(offset, listSignal())
      setFeed(current => ({
        items: mergeActivityEvents(current.items, page.items),
        total: page.total ?? current.total,
        more: page.more ?? current.more,
      }))
      setLoad({ status: 'ready' })
    } catch {
      setLoad({ status: 'failed', error: failure })
    }
  }, [failure, listSignal, loading, offset])

  return {
    items: feed.items,
    total: feed.total ?? feed.items.length,
    more,
    load,
    loading,
    error: load.status === 'failed' ? load.error : null,
    loadMore,
    refreshed,
  }
}
