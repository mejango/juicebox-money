'use client'

import { useState, type ReactNode } from 'react'

type Feed = 'activity' | 'trending' | 'top'
type RankingFeed = Exclude<Feed, 'activity'>

const FEEDS: readonly { id: Feed; label: string }[] = [
  { id: 'activity', label: 'Latest' },
  { id: 'top', label: 'Top' },
  { id: 'trending', label: 'Trending' },
]

const RANKING_FEEDS = FEEDS.filter(
  (feed): feed is { id: RankingFeed; label: string } =>
    feed.id !== 'activity',
)

function FeedTabs({
  feeds,
  active,
  onChange,
  idPrefix,
  label,
  className = '',
}: {
  feeds: readonly { id: Feed; label: string }[]
  active: Feed
  onChange: (feed: Feed) => void
  idPrefix: string
  label: string
  className?: string
}) {
  return (
    <div
      className={`min-w-0 gap-5 overflow-x-auto border-b border-smoke-200 ${className}`}
      role="tablist"
      aria-label={label}
    >
      {feeds.map(feed => (
        <button
          key={feed.id}
          type="button"
          role="tab"
          id={`${idPrefix}-${feed.id}-tab`}
          aria-controls={`home-${feed.id}-panel`}
          aria-selected={active === feed.id}
          onClick={() => onChange(feed.id)}
          className={`min-h-11 shrink-0 border-b-2 font-agrandir text-sm font-medium transition-colors ${
            active === feed.id
              ? 'border-bluebs-600 text-bluebs-600'
              : 'border-transparent text-smoke-600 hover:text-ink'
          }`}
        >
          {feed.label}
        </button>
      ))}
    </div>
  )
}

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
  const [rankingFeed, setRankingFeed] = useState<RankingFeed>('top')

  return (
    <div className="grid items-start gap-5 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-[repeat(3,minmax(0,1fr))_minmax(0,1.5fr)] lg:items-stretch">
      <div className="order-1 min-w-0 sm:col-span-2 sm:row-start-1 md:col-span-1 md:col-start-3 md:row-span-2 md:row-start-1 lg:col-start-4">
        {hero}
      </div>

      <div className="order-2 min-w-0 sm:col-span-2 sm:row-start-2 md:col-start-1 md:row-start-1 lg:col-span-2">
        {summary}
      </div>

      <FeedTabs
        feeds={FEEDS}
        active={activeFeed}
        onChange={setActiveFeed}
        idPrefix="home-all"
        label="Project feeds"
        className="order-3 flex sm:hidden"
      />

      <div
        id="home-activity-panel"
        role="tabpanel"
        aria-labelledby="home-all-activity-tab"
        className={`${
          activeFeed === 'activity' ? 'block' : 'hidden'
        } order-4 min-w-0 sm:col-start-1 sm:row-start-3 sm:block md:row-start-2 lg:col-start-1`}
      >
        {activity}
      </div>

      <div className="order-5 min-w-0 sm:col-start-2 sm:row-start-3 md:row-start-2 lg:contents">
        <FeedTabs
          feeds={RANKING_FEEDS}
          active={rankingFeed}
          onChange={feed => setRankingFeed(feed as RankingFeed)}
          idPrefix="home-ranking"
          label="Project rankings"
          className="mb-4 hidden sm:flex lg:hidden"
        />

        <div
          id="home-top-panel"
          role="tabpanel"
          aria-labelledby="home-all-top-tab home-ranking-top-tab"
          className={`${activeFeed === 'top' ? 'block' : 'hidden'} ${
            rankingFeed === 'top' ? 'sm:block' : 'sm:hidden'
          } min-w-0 lg:col-start-2 lg:row-start-2 lg:block`}
        >
          {top}
        </div>

        <div
          id="home-trending-panel"
          role="tabpanel"
          aria-labelledby="home-all-trending-tab home-ranking-trending-tab"
          className={`${activeFeed === 'trending' ? 'block' : 'hidden'} ${
            rankingFeed === 'trending' ? 'sm:block' : 'sm:hidden'
          } min-w-0 lg:col-start-3 lg:row-span-2 lg:row-start-1 lg:block`}
        >
          {trending}
        </div>
      </div>
    </div>
  )
}
