'use client'

import { useState, type ReactNode } from 'react'

type Feed = 'activity' | 'trending' | 'top'

const FEEDS: readonly { id: Feed; label: string }[] = [
  { id: 'activity', label: 'Fresh activity' },
  { id: 'top', label: 'Top projects' },
  { id: 'trending', label: 'Trending' },
]

export function HomepageDiscoveryLayout({
  hero,
  summary,
  activity,
  trending,
  top,
}: {
  hero: ReactNode
  summary: ReactNode
  activity: ReactNode
  trending: ReactNode
  top: ReactNode
}) {
  const [activeFeed, setActiveFeed] = useState<Feed>('activity')
  const panels: Record<Feed, ReactNode> = { activity, trending, top }

  return (
    <div className="grid items-start gap-5 xl:grid-cols-[repeat(3,minmax(0,1fr))_minmax(0,1.5fr)]">
      <div className="order-1 min-w-0 xl:col-start-4 xl:row-span-2 xl:row-start-1">{hero}</div>

      <div className="order-2 min-w-0 xl:col-span-2 xl:row-start-1">{summary}</div>

      <div
        className="order-3 flex min-w-0 gap-5 overflow-x-auto border-b border-smoke-200 xl:hidden"
        role="tablist"
        aria-label="Project feeds"
      >
        {FEEDS.map(feed => (
          <button
            key={feed.id}
            type="button"
            role="tab"
            id={`home-${feed.id}-tab`}
            aria-controls={`home-${feed.id}-panel`}
            aria-selected={activeFeed === feed.id}
            onClick={() => setActiveFeed(feed.id)}
            className={`min-h-11 shrink-0 border-b-2 font-agrandir text-sm font-medium transition-colors ${
              activeFeed === feed.id
                ? 'border-bluebs-600 text-bluebs-600'
                : 'border-transparent text-smoke-600 hover:text-ink'
            }`}
          >
            {feed.label}
          </button>
        ))}
      </div>

      {FEEDS.map(feed => (
        <div
          key={feed.id}
          id={`home-${feed.id}-panel`}
          role="tabpanel"
          aria-labelledby={`home-${feed.id}-tab`}
          className={`${activeFeed === feed.id ? 'block' : 'hidden'} order-4 min-w-0 xl:block ${
            feed.id === 'activity'
              ? 'xl:col-start-1 xl:row-start-2'
              : feed.id === 'top'
                ? 'xl:col-start-2 xl:row-start-2'
                : 'xl:col-start-3 xl:row-span-2 xl:row-start-1'
          }`}
        >
          {panels[feed.id]}
        </div>
      ))}
    </div>
  )
}
