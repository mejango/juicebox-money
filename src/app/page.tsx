import Link from 'next/link'
import { getTrendingCards, TrendingCard } from '@/lib/trending'
import { BsFreshActivityEvent, getRecentActivity } from '@/lib/bendystraw'
import { FreshActivity } from '@/components/FreshActivity'
import { ProjectCard } from '@/components/ProjectCard'

export const revalidate = 120

export default async function HomePage() {
  const [cardsResult, activityResult] = await Promise.allSettled([
    getTrendingCards(12),
    getRecentActivity(12),
  ])
  // Data hiccups degrade to empty regions; the page always renders.
  const cards: TrendingCard[] =
    cardsResult.status === 'fulfilled' ? cardsResult.value : []
  const activity: BsFreshActivityEvent[] =
    activityResult.status === 'fulfilled' ? activityResult.value : []

  return (
    <>
      {/* Hero band — restrained: statement, one line, two buttons. */}
      <section className="border-b border-smoke-200">
        <div className="mx-auto max-w-6xl px-4 pb-16 pt-16 sm:px-6 sm:pb-24 sm:pt-24">
          <h1 className="max-w-3xl font-agrandir-wide text-5xl font-bold leading-[1.08] sm:text-6xl lg:text-7xl">
            Fund your thing<span className="text-split-500">.</span>
          </h1>
          <p className="mt-6 max-w-xl text-base leading-relaxed text-smoke-700 sm:text-lg">
            Raise money from anyone, anywhere. Supporters get tokens, you get
            a transparent treasury — everything happens in the open.
          </p>
          <div className="mt-9 flex flex-wrap gap-3">
            <a href="#trending" className="btn-primary min-h-[48px] px-7 text-sm">
              Explore projects
            </a>
            <Link href="/create" className="btn-secondary min-h-[48px] px-7 text-sm">
              Start a project
            </Link>
          </div>
        </div>
      </section>

      {/* Trending mosaic + fresh activity rail. */}
      <section id="trending" className="mx-auto max-w-6xl px-4 py-14 sm:px-6 sm:py-16">
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          {/* Trending mosaic */}
          <div className="min-w-0 lg:col-span-2">
            <h2 className="mb-5 font-agrandir text-2xl font-medium sm:text-3xl">
              Trending projects
            </h2>
            {cards.length === 0 ? (
              <p className="card p-8 text-sm text-smoke-700">
                Projects are loading slowly right now — check back in a moment.
              </p>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {cards.map(card => (
                  <ProjectCard key={card.key} card={card} />
                ))}
              </div>
            )}
          </div>

          {/* Fresh activity rail — right column on desktop, stacks below on mobile. */}
          <aside className="min-w-0 lg:col-span-1">
            <h2 className="mb-5 font-agrandir text-2xl font-medium sm:text-3xl">
              Fresh activity
            </h2>
            <div className="card overflow-hidden">
              <p className="field-label border-b border-smoke-200 px-4 py-2.5">
                Live · all projects
              </p>
              <FreshActivity initialEvents={activity} />
            </div>
          </aside>
        </div>
      </section>
    </>
  )
}
