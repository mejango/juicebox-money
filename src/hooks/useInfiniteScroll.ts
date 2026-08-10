'use client'

import { useEffect, useRef } from 'react'

export function useInfiniteScroll({
  hasMore,
  loading,
  loadMore,
}: {
  hasMore: boolean
  loading: boolean
  loadMore: () => void
}) {
  const markerRef = useRef<HTMLLIElement>(null)

  useEffect(() => {
    const marker = markerRef.current
    if (!marker || !hasMore || loading) return
    const root = marker.closest<HTMLElement>('[data-scroll-container]')

    const observer = new IntersectionObserver(
      entries => {
        if (entries.some(entry => entry.isIntersecting)) loadMore()
      },
      { root, rootMargin: '240px 0px' },
    )
    observer.observe(marker)
    return () => observer.disconnect()
  }, [hasMore, loadMore, loading])

  return markerRef
}
