import Image from 'next/image'
import Link from 'next/link'
import { Suspense, type ReactNode } from 'react'
import accountsIllustration from '@/assets/illustrations/accounts.png'
import autoIssuanceIllustration from '@/assets/illustrations/auto-issuance.png'
import extrasIllustration from '@/assets/illustrations/extras.png'
import fruitApple from '@/assets/illustrations/fruit-apple.png'
import fruitBanana from '@/assets/illustrations/fruit-banana.png'
import fruitBananas from '@/assets/illustrations/fruit-bananas.png'
import fruitCherries from '@/assets/illustrations/fruit-cherries.png'
import fruitDragon from '@/assets/illustrations/fruit-dragon.png'
import fruitLemon from '@/assets/illustrations/fruit-lemon.png'
import fruitStrawberry from '@/assets/illustrations/fruit-strawberry.png'
import fruitWatermelon from '@/assets/illustrations/fruit-watermelon.png'
import juiceboxHero from '@/assets/illustrations/juicebox-hero.png'
import loansIllustration from '@/assets/illustrations/loans.png'
import marketIllustration from '@/assets/illustrations/market.png'
import operatorIllustration from '@/assets/illustrations/operator.png'
import settlementIllustration from '@/assets/illustrations/settlement.png'
import shopIllustration from '@/assets/illustrations/shop.png'
import splitsIllustration from '@/assets/illustrations/splits.png'
import termsIllustration from '@/assets/illustrations/terms.png'
import { getTrendingCards, TrendingCard } from '@/lib/trending'
import { getRecentActivity, type BsFreshActivityEvent } from '@/lib/bendystraw'
import { getTopBalanceProjects, type TopBalanceProject } from '@/lib/top-projects'
import { AuditPromptLink } from '@/components/AuditPromptLink'
import { FreshActivity } from '@/components/FreshActivity'
import { HomepageDiscoveryLayout } from '@/components/HomepageDiscoveryLayout'
import { ProjectLogo } from '@/components/ProjectLogo'
import { ProjectLink } from '@/components/ProjectLink'
import { PowerYourPlatform } from '@/components/PowerYourPlatform'
import { TopProjectRows } from '@/components/TopProjectRows'
import { SecuredReserves } from '@/components/SecuredReserves'
import { formatTokenAmount } from '@/lib/format'
import { getHomepageReserves } from '@/lib/homepage-reserves'

export const revalidate = 120

const FRUIT_SEPARATOR = [
  { src: fruitCherries, className: '-rotate-6' },
  { src: fruitDragon, className: 'translate-y-2 rotate-6' },
  { src: fruitLemon, className: '-translate-y-1 -rotate-3' },
  { src: fruitBanana, className: 'translate-y-2 rotate-6' },
  { src: fruitStrawberry, className: '-translate-y-2 rotate-3' },
  { src: fruitBananas, className: '-rotate-6' },
  { src: fruitWatermelon, className: 'translate-y-1 rotate-6' },
  { src: fruitApple, className: '-translate-y-1 -rotate-3' },
]

const WHY_JUICEBOX_POINTS = [
  'Accept money instantly from anyone around the world.',
  'Easily issue unified, programmable incentives to your community, customers, and investors in real time.',
  'Make promises to supporters that are guaranteed to hold.',
  'Build your own website or app to access your pay and cash-out functions. No platform lock-in.',
  'Start with flexible rules, evolve them as your project changes, then lock the promises that should become permanent.',
  'Make every rule and transaction inspectable so community trust compounds over time.',
  'Keep control of your funds when you want, give up control to other mechanisms when you want.',
  'Pay a fixed fee that sustains a healthy public payment network instead of having fees change over time.',
  'Be treated as both a customer and a participating investor, sharing in the growth your usage helps create.',
  'Use AI and open-source tooling to build faster and more securely without becoming dependent on private tools.',
  'Audit the whole money system yourself. Track all transactions. Ensure integrity without permission.',
  'Fund, earn, and grow on your own terms.',
]

const JUICEBOX_FEATURES = [
  {
    title: 'Rules you can trust',
    description:
      'Keep rules flexible while you learn, then lock the promises supporters need to rely on.',
    illustration: termsIllustration,
    art: 'tall',
    wide: true,
  },
  {
    title: 'One community, everywhere',
    description:
      'Issue a unified project token and understand participation across every supported network.',
    illustration: accountsIllustration,
    art: 'tall',
  },
  {
    title: 'Automatic splits',
    description:
      'Route programmed splits of new tokens to contributors, partners, and communities.',
    illustration: splitsIllustration,
    art: 'wide',
  },
  {
    title: 'A market with guardrails',
    description:
      'Give supporters a transparent path to buy and cash out within the rules you publish.',
    illustration: marketIllustration,
    art: 'tall',
    wide: true,
    reverse: true,
  },
  {
    title: 'Linked across chains',
    description:
      'Coordinate balances and token supply across deployments without hiding how value moves.',
    illustration: settlementIllustration,
    art: 'wide',
  },
  {
    title: 'A Shop built into your project',
    description:
      'Use your shop to offer digital items and let every purchase flow directly into your project.',
    illustration: shopIllustration,
    art: 'square',
  },
  {
    title: 'Incentives on schedule',
    description:
      'Program token rewards to become available at the right stage, with anyone able to trigger distribution.',
    illustration: autoIssuanceIllustration,
    art: 'wide',
    wide: true,
  },
  {
    title: 'Liquidity without selling',
    description:
      'When enabled, let supporters borrow against project tokens instead of giving up their position.',
    illustration: loansIllustration,
    art: 'tall',
  },
  {
    title: 'Payments that fit anywhere',
    description:
      'Create dedicated payer addresses and connect Juicebox payments to the experiences you build.',
    illustration: extrasIllustration,
    art: 'wide',
  },
  {
    title: 'Control on your terms',
    description:
      'Operate from a wallet or Safe, delegate permissions, and pass responsibility on when you choose.',
    illustration: operatorIllustration,
    art: 'tall',
    wide: true,
    reverse: true,
  },
]

const HOMEPAGE_DATA_TIMEOUT_MS = 9_000

function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('Homepage data request timed out')),
      milliseconds,
    )
    promise.then(
      value => {
        clearTimeout(timeout)
        resolve(value)
      },
      error => {
        clearTimeout(timeout)
        reject(error)
      },
    )
  })
}

function FruitSeparator() {
  return (
    <div className="mt-16 py-6 sm:mt-20 sm:py-8" aria-hidden>
      <div className="grid grid-cols-4 items-center gap-x-3 gap-y-4 sm:grid-cols-8 sm:gap-x-5">
        {FRUIT_SEPARATOR.map(({ src, className }) => (
          <div key={src.src} className={`flex h-20 items-center justify-center sm:h-28 ${className}`}>
            <Image
              src={src}
              alt=""
              sizes="(min-width: 640px) 128px, 80px"
              className="h-full w-full object-contain"
            />
          </div>
        ))}
      </div>
    </div>
  )
}

async function HomepageDiscovery() {
  const [cardsResult, activityResult, topResult, reservesResult] = await Promise.allSettled([
    withTimeout(getTrendingCards(8), HOMEPAGE_DATA_TIMEOUT_MS),
    withTimeout(getRecentActivity(9), HOMEPAGE_DATA_TIMEOUT_MS),
    withTimeout(getTopBalanceProjects(9), HOMEPAGE_DATA_TIMEOUT_MS),
    withTimeout(getHomepageReserves(), HOMEPAGE_DATA_TIMEOUT_MS),
  ])
  // Data hiccups degrade to empty regions; the page always renders.
  const cards: TrendingCard[] =
    cardsResult.status === 'fulfilled' ? cardsResult.value : []
  const activity: BsFreshActivityEvent[] =
    activityResult.status === 'fulfilled' ? activityResult.value : []
  const top: TopBalanceProject[] =
    topResult.status === 'fulfilled' ? topResult.value : []
  const reserves = reservesResult.status === 'fulfilled' ? reservesResult.value : null

  return (
    <section
      id="trending"
      className="mx-auto max-w-[1800px] px-4 pb-0 pt-8 sm:px-6 sm:pt-12"
    >
      <HomepageDiscoveryLayout
        hero={<HeroColumn />}
        summary={reserves ? <SecuredReserves data={reserves} /> : null}
        activity={
          <DashboardColumn title="Fresh activity" headingClassName="hidden md:flex">
            <FreshActivity
              initialEvents={activity.slice(0, 8)}
              initialHasMore={activity.length > 8}
            />
          </DashboardColumn>
        }
        trending={
          <DashboardColumn title="Trending" headingClassName="hidden 2xl:flex">
            <ProjectRows cards={cards} />
          </DashboardColumn>
        }
        top={
          <DashboardColumn title="Top projects" headingClassName="hidden 2xl:flex">
            <TopProjectRows
              initialProjects={top.slice(0, 8)}
              initialHasMore={top.length > 8}
            />
          </DashboardColumn>
        }
      />
    </section>
  )
}

function DashboardColumn({
  title,
  children,
  headingClassName,
}: {
  title: string
  children: ReactNode
  headingClassName: string
}) {
  return (
    <section aria-labelledby={`home-${title.replaceAll(' ', '-').toLowerCase()}`}>
      <h2
        id={`home-${title.replaceAll(' ', '-').toLowerCase()}`}
        className={`mb-4 min-h-11 items-center font-agrandir text-xl font-medium sm:text-2xl ${headingClassName}`}
      >
        {title}
      </h2>
      <div className="card max-h-[70svh] min-h-[420px] overflow-y-auto md:h-[calc(100svh-12rem)] md:max-h-none md:min-h-[520px]">
        {children}
      </div>
    </section>
  )
}

function ProjectRows({ cards }: { cards: TrendingCard[] }) {
  if (!cards.length) return <EmptyProjects />
  return (
    <ol className="divide-y divide-smoke-100">
      {cards.map((card, index) => (
        <li key={card.key}>
          <ProjectLink
            href={card.href}
            projectHint={{ name: card.name, logoUri: card.logoUri, tagline: card.tagline }}
            className="group flex h-28 items-center gap-3 px-4 py-3"
          >
            <span className="w-5 shrink-0 text-xs tabular-nums text-smoke-500">
              {index + 1}
            </span>
            <ProjectLogo
              name={card.name}
              logoUri={card.logoUri}
              size={40}
              eager={index < 4}
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium group-hover:text-bluebs-600">
                {card.name}
              </span>
              <span className="mt-0.5 block text-xs leading-snug text-smoke-600">
                <span className="block">
                  Recent payments:{' '}
                  <span className="tabular-nums text-smoke-700">
                    {card.paymentsCount.toLocaleString('en-US')}
                  </span>
                </span>
                <span className="block">
                  Recent volume:{' '}
                  <span className="tabular-nums text-smoke-700">
                    {formatRecentVolume(card)}
                  </span>
                </span>
              </span>
            </span>
          </ProjectLink>
        </li>
      ))}
    </ol>
  )
}

function formatRecentVolume(card: TrendingCard): string {
  if (card.decimals === null || card.symbol === null) return '—'
  return `${formatTokenAmount(card.volume, card.decimals)} ${card.symbol.replace(/^\$+/, '')}`
}

function EmptyProjects() {
  return (
    <p className="flex min-h-[420px] items-center justify-center px-6 text-center text-sm text-smoke-600">
      Projects are temporarily unavailable.
    </p>
  )
}

function HeroColumn() {
  return (
    <section className="flex min-h-[460px] flex-col overflow-hidden p-6 text-center xl:h-[calc(100svh-9rem)] xl:min-h-0 xl:justify-center xl:p-3 xl:text-left">
      <div className="xl:mb-3 xl:flex xl:min-h-0 xl:flex-1 xl:items-center xl:justify-center">
        <Image
          src={juiceboxHero}
          alt=""
          priority
          sizes="(min-width: 1280px) 360px, 280px"
          className="mx-auto mb-8 h-auto w-full max-w-[330px] xl:mb-0 xl:h-full xl:max-h-[360px] xl:max-w-[360px] xl:object-contain"
        />
      </div>
      <div>
        <h1 className="font-agrandir-wide text-4xl font-bold leading-[1.05] sm:text-5xl xl:text-[clamp(2.5rem,5.5svh,3.75rem)]">
          Fund your thing<span className="text-split-500">.</span>
        </h1>
        <p className="mt-5 text-base leading-relaxed text-smoke-700 xl:mt-2">
          Raise money from anyone, anywhere, transparently on your terms.
        </p>
        <Link
          href="/create"
          className="btn-primary mt-7 inline-flex min-h-[48px] items-center px-7 text-sm xl:mt-4"
        >
          Start a project
        </Link>
        <AuditPromptLink className="mt-5 text-sm text-smoke-600 xl:mt-3" />
      </div>
    </section>
  )
}

export default function HomePage() {
  return (
    <>
      <Suspense fallback={<div className="mx-auto min-h-[520px] max-w-[1800px] animate-pulse px-4 pt-8 sm:px-6" />}>
        <HomepageDiscovery />
      </Suspense>
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <FruitSeparator />
      </div>

      <section aria-labelledby="why-juicebox">
        <div className="mx-auto max-w-6xl px-4 pb-16 pt-16 sm:px-6 sm:pb-24 sm:pt-20">
          <h2
            id="why-juicebox"
            className="font-agrandir-wide text-4xl font-bold leading-tight sm:text-6xl"
          >
            Why Juicebox?
          </h2>
          <p className="mt-5 max-w-4xl font-agrandir text-xl font-medium leading-snug text-smoke-700 sm:text-2xl">
            What open source businesses, campaigns, and indie projects actually
            want:
          </p>

          <ol className="mt-10 max-w-5xl list-decimal space-y-5 pl-8 marker:font-agrandir marker:text-lg marker:font-medium marker:text-bluebs-600">
            {WHY_JUICEBOX_POINTS.map(point => (
              <li key={point} className="pl-2 text-sm leading-relaxed text-smoke-800 sm:text-base">
                {point}
              </li>
            ))}
          </ol>

          <div className="mt-20 sm:mt-28">
            <h3 className="mx-auto max-w-5xl text-center font-agrandir-wide text-3xl font-bold leading-tight sm:text-5xl">
              For all projects, from startup{' '}
              <span className="whitespace-nowrap">to scale.</span>
            </h3>
            <p className="mx-auto mt-4 max-w-3xl text-center text-base leading-relaxed text-smoke-700 sm:text-lg">
              Start simply, add powerful tools when you need them, and keep the
              important rules visible to everyone along the way. Easy enough for
              a group of friends, powerful enough for a global network of anons.
            </p>

            <div className="mt-12 grid gap-x-16 gap-y-20 md:grid-cols-2 sm:mt-16 sm:gap-y-28">
              {JUICEBOX_FEATURES.map(feature => {
                const isWide = 'wide' in feature && feature.wide
                const isReversed = 'reverse' in feature && feature.reverse
                const art = feature.art
                const imageSizeClass =
                  art === 'wide'
                    ? isWide
                      ? 'max-w-[560px]'
                      : 'max-w-[480px]'
                    : art === 'tall'
                      ? isWide
                        ? 'max-w-[420px]'
                        : 'max-w-[320px]'
                      : isWide
                        ? 'max-w-[440px]'
                        : 'max-w-[340px]'

                return (
                  <article
                    key={feature.title}
                    className={`grid items-center px-2 sm:px-6 ${
                      isWide
                        ? 'min-h-[400px] gap-10 py-8 md:col-span-2 sm:py-10 lg:grid-cols-[minmax(0,1fr)_minmax(300px,520px)]'
                        : 'content-between gap-10 py-10 sm:min-h-[500px] sm:grid-rows-[1fr_auto] sm:py-14'
                    }`}
                  >
                    <div
                      className={
                        isWide
                          ? isReversed
                            ? 'order-2 lg:order-2'
                            : 'order-2 lg:order-1'
                          : 'order-2'
                      }
                    >
                      <h4 className="font-agrandir text-2xl font-medium text-ink">
                        {feature.title}
                      </h4>
                      <p className="mt-4 text-base leading-relaxed text-smoke-700 sm:text-lg">
                        {feature.description}
                      </p>
                    </div>
                    <Image
                      src={feature.illustration}
                      alt=""
                      aria-hidden
                      sizes={
                        isWide
                          ? '(min-width: 1024px) 520px, (min-width: 640px) 44vw, 84vw'
                          : '(min-width: 768px) 40vw, 84vw'
                      }
                      className={`order-1 h-auto w-full justify-self-center select-none object-contain ${imageSizeClass} ${
                        isWide ? (isReversed ? 'lg:order-1' : 'lg:order-2') : ''
                      }`}
                    />
                  </article>
                )
              })}
            </div>
          </div>
        </div>
      </section>
      <PowerYourPlatform />
    </>
  )
}
