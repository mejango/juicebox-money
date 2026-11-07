'use client'

import { useState, type ReactNode } from 'react'

type Feed = 'activity' | 'trending' | 'top' | 'new'
type RankingFeed = Exclude<Feed, 'activity'>

const FEEDS: readonly { id: Feed; label: string }[] = [
  { id: 'top', label: 'Top' },
  { id: 'trending', label: 'Trending' },
  { id: 'activity', label: 'Latest' },
  { id: 'new', label: 'New' },
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
      className={`min-w-0 gap-0 overflow-x-auto border-b border-smoke-200 sm:gap-5 ${className}`}
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
          // These are section headings that happen to be selectable, so they
          // carry the same type scale as the standalone "Latest" heading.
          // Phones spread the feeds edge to edge in equal thirds; wider screens
          // keep them as a left-aligned row.
          className={`min-h-11 flex-1 shrink-0 border-b-2 text-center font-agrandir text-xl font-medium transition-colors sm:flex-none sm:text-left sm:text-2xl ${
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
  newProjects,
}: {
  hero: ReactNode
  summary: ReactNode
  activity: ReactNode
  trending: ReactNode
  top: ReactNode
  newProjects: ReactNode
}) {
  const [activeFeed, setActiveFeed] = useState<Feed>('top')
  const [rankingFeed, setRankingFeed] = useState<RankingFeed>('top')

  return (
    <div className="grid items-start gap-5 sm:grid-cols-2 md:gap-x-8">
      <div className="min-w-0 sm:col-span-2 md:col-span-1">{hero}</div>

      <div className="min-w-0 sm:col-span-2 md:col-span-1 md:self-center">{summary}</div>

      <FeedTabs
        feeds={FEEDS}
        active={activeFeed}
        onChange={setActiveFeed}
        idPrefix="home-all"
        label="Project feeds"
        className="flex sm:hidden"
      />

      <div className="min-w-0">
        <FeedTabs
          feeds={RANKING_FEEDS}
          active={rankingFeed}
          onChange={feed => setRankingFeed(feed as RankingFeed)}
          idPrefix="home-ranking"
          label="Project rankings"
          className="mb-4 hidden sm:flex"
        />

        <div
          id="home-top-panel"
          role="tabpanel"
          aria-labelledby="home-all-top-tab home-ranking-top-tab"
          className={`${activeFeed === 'top' ? 'block' : 'hidden'} ${
            rankingFeed === 'top' ? 'sm:block' : 'sm:hidden'
          } min-w-0`}
        >
          {top}
        </div>

        <div
          id="home-trending-panel"
          role="tabpanel"
          aria-labelledby="home-all-trending-tab home-ranking-trending-tab"
          className={`${activeFeed === 'trending' ? 'block' : 'hidden'} ${
            rankingFeed === 'trending' ? 'sm:block' : 'sm:hidden'
          } min-w-0`}
        >
          {trending}
        </div>

        <div
          id="home-new-panel"
          role="tabpanel"
          aria-labelledby="home-all-new-tab home-ranking-new-tab"
          className={`${activeFeed === 'new' ? 'block' : 'hidden'} ${
            rankingFeed === 'new' ? 'sm:block' : 'sm:hidden'
          } min-w-0`}
        >
          {newProjects}
        </div>
      </div>

      <div
        id="home-activity-panel"
        role="tabpanel"
        aria-labelledby="home-all-activity-tab"
        className={`${activeFeed === 'activity' ? 'block' : 'hidden'} min-w-0 sm:block`}
      >
        {activity}
      </div>
    </div>
  )
}
