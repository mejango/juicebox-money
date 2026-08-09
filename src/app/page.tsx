import Image from 'next/image'
import Link from 'next/link'
import { Suspense } from 'react'
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
import { AuditPromptLink } from '@/components/AuditPromptLink'
import { FreshActivity } from '@/components/FreshActivity'
import { HomepageDiscoveryTabs } from '@/components/HomepageDiscoveryTabs'
import { ProjectCard } from '@/components/ProjectCard'
import { HomepageDiscoverySkeleton } from '@/components/LoadingSkeletons'
import { PowerYourPlatform } from '@/components/PowerYourPlatform'

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
  const [cardsResult, activityResult] = await Promise.allSettled([
    withTimeout(getTrendingCards(12), HOMEPAGE_DATA_TIMEOUT_MS),
    withTimeout(getRecentActivity(12), HOMEPAGE_DATA_TIMEOUT_MS),
  ])
  // Data hiccups degrade to empty regions; the page always renders.
  const cards: TrendingCard[] =
    cardsResult.status === 'fulfilled' ? cardsResult.value : []
  const activity: BsFreshActivityEvent[] =
    activityResult.status === 'fulfilled' ? activityResult.value : []

  return (
    <section
      id="trending"
      className="mx-auto max-w-6xl px-4 pb-0 pt-8 sm:px-6 sm:pb-0 sm:pt-16"
    >
      <HomepageDiscoveryTabs
        trending={
          <>
            <h2 className="mb-5 hidden font-agrandir text-2xl font-medium sm:text-3xl lg:block">
              Trending projects
            </h2>
            {cards.length === 0 ? (
              <p className="card p-8 text-sm text-smoke-700">
                Projects are temporarily unavailable. Please try again shortly.
              </p>
            ) : (
              <>
                <div className="space-y-3 sm:hidden">
                  {cards.map(card => (
                    <ProjectCard key={card.key} card={card} />
                  ))}
                </div>
                <div className="hidden items-start gap-3 sm:grid sm:grid-cols-2">
                  {[0, 1].map(column => (
                    <div key={column} className="flex flex-col gap-3">
                      {cards
                        .filter((_, index) => index % 2 === column)
                        .map(card => (
                          <ProjectCard key={card.key} card={card} />
                        ))}
                    </div>
                  ))}
                </div>
              </>
            )}
          </>
        }
        activity={
          <>
            <h2 className="mb-5 hidden font-agrandir text-2xl font-medium sm:text-3xl lg:block">
              Fresh activity
            </h2>
            <div className="card overflow-hidden">
              <FreshActivity initialEvents={activity} />
            </div>
          </>
        }
      />
    </section>
  )
}

export default function HomePage() {
  return (
    <>
      {/* Hero band — statement, actions, and one brand illustration. */}
      <section>
        <div className="mx-auto grid max-w-6xl items-center gap-10 px-4 pb-16 pt-16 sm:px-6 sm:pb-24 sm:pt-24 lg:grid-cols-[minmax(0,1fr)_400px]">
          <div className="text-center lg:text-left">
            <h1 className="mx-auto max-w-3xl font-agrandir-wide text-4xl font-bold leading-[1.08] sm:text-6xl lg:mx-0 lg:text-7xl">
              Fund your thing<span className="text-split-500">.</span>
            </h1>
            <p className="mx-auto mt-6 max-w-2xl text-base leading-relaxed text-smoke-700 sm:text-lg lg:mx-0">
              Raise money from anyone, anywhere,{' '}
              <br className="lg:hidden" />
              transparently on your terms.
            </p>
            <div className="mt-9 flex flex-wrap justify-center gap-3 lg:justify-start">
              <Link href="/create" className="btn-primary min-h-[48px] px-7 text-sm">
                Start a project
              </Link>
            </div>
            <AuditPromptLink className="mt-5 text-sm text-smoke-600" />
          </div>
          <div
            className="order-first mx-auto w-full max-w-[280px] lg:order-none lg:max-w-none"
            aria-hidden
          >
            <Image
              src={juiceboxHero}
              alt=""
              priority
              sizes="(min-width: 1024px) 400px, 280px"
              className="h-auto w-full"
            />
          </div>
        </div>
      </section>

      <Suspense fallback={<HomepageDiscoverySkeleton />}>
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
