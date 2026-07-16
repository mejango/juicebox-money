import Link from 'next/link'
import { getTrendingSuckerGroups, BsSuckerGroup } from '@/lib/bendystraw'
import { ProjectCard } from '@/components/ProjectCard'

export const revalidate = 120

export default async function HomePage() {
  let groups: BsSuckerGroup[] = []
  try {
    groups = await getTrendingSuckerGroups(12)
  } catch {
    // Bendystraw hiccup: render the page anyway with an empty grid.
  }
  // One card per omnichain project: representative = the member with the
  // richest identity (name/logo), preferring the lowest chain id on ties.
  const cards = groups
    // Trending is a storefront: skip projects with no name and no activity.
    .filter(
      group =>
        BigInt(group.volume) > 0n ||
        group.projects.items.some(m => m.name),
    )
    .map(group => {
      const members = group.projects.items
      const representative =
        members.find(m => m.name && m.logoUri) ??
        members.find(m => m.name) ??
        members[0]
      if (!representative) return null
      return {
        group,
        representative,
        chainIds: members.map(m => m.chainId),
      }
    })
    .filter(<T,>(card: T | null): card is T => card !== null)

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
            {cards.map(({ group, representative, chainIds }) => (
              <ProjectCard
                key={group.id}
                project={representative}
                chainIds={chainIds}
                volume={group.volume}
                paymentsCount={group.paymentsCount}
              />
            ))}
          </div>
        )}
      </section>
    </>
  )
}
