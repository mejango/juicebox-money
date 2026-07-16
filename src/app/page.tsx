import Link from 'next/link'
import { getTrendingCards, TrendingCard } from '@/lib/trending'
import { ProjectCard } from '@/components/ProjectCard'

export const revalidate = 120

export default async function HomePage() {
  let cards: TrendingCard[] = []
  try {
    cards = await getTrendingCards(12)
  } catch {
    // Data hiccup: render the page anyway with an empty grid.
  }

  return (
    <>
      {/* Hero */}
      <section className="relative overflow-hidden">
        <div
          aria-hidden
          className="pointer-events-none absolute -right-40 -top-52 h-[28rem] w-[28rem] rounded-full bg-gradient-to-br from-juice-400/50 to-juice-500/20 blur-3xl"
        />
        <div className="mx-auto max-w-6xl px-4 pb-16 pt-16 sm:px-6 sm:pb-24 sm:pt-24">
          <h1 className="max-w-3xl text-5xl font-extrabold leading-[1.05] tracking-tight sm:text-6xl lg:text-7xl">
            Fund <span className="juice-underline">your thing</span>.
          </h1>
          <p className="mt-5 max-w-xl text-lg text-ink/60 sm:text-xl">
            Raise money from anyone, anywhere. Supporters get tokens, you get
            a transparent treasury — everything happens in the open.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <a
              href="#trending"
              className="inline-flex min-h-[48px] items-center rounded-full bg-juice-500 px-7 text-base font-bold text-ink transition-colors hover:bg-juice-600"
            >
              Explore projects
            </a>
            <Link
              href="/create"
              className="inline-flex min-h-[48px] items-center rounded-full border-2 border-ink/15 px-7 text-base font-bold transition-colors hover:border-ink/40"
            >
              Start a project
            </Link>
          </div>
        </div>
      </section>

      {/* Trending */}
      <section id="trending" className="mx-auto max-w-6xl px-4 pb-20 sm:px-6">
        <h2 className="mb-6 text-2xl font-extrabold tracking-tight sm:text-3xl">
          Trending projects
        </h2>
        {cards.length === 0 ? (
          <p className="rounded-2xl border border-ink/10 bg-white p-8 text-ink/60">
            Projects are loading slowly right now — check back in a moment.
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {cards.map(card => (
              <ProjectCard key={card.key} card={card} />
            ))}
          </div>
        )}
      </section>
    </>
  )
}
