'use client'

import Image from 'next/image'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState } from 'react'
import logoFull from '@/assets/brand/logo-full.svg'
import logoIcon from '@/assets/brand/logo-icon.svg'
import { projectRouteSegmentFromPathname } from '@/lib/project-handles'
import { MagnifierIcon, SearchBox } from './SearchBox'
import { WalletButton } from './WalletButton'

function GuideLinks({ className = '' }: { className?: string }) {
  const pathname = usePathname()
  return (
    <div
      className={`flex items-center gap-1.5 whitespace-nowrap font-agrandir text-xs font-medium leading-normal text-smoke-700 sm:gap-2 sm:text-sm ${className}`}
    >
      <Link
        href="/learn"
        aria-current={pathname === '/learn' ? 'page' : undefined}
        className="inline-flex min-h-11 min-w-11 items-center justify-center underline-offset-4 hover:text-bluebs-700 hover:underline aria-[current=page]:text-bluebs-700 aria-[current=page]:underline"
      >
        Learn
      </Link>
      <span aria-hidden>|</span>
      <Link
        href="/build"
        aria-current={pathname === '/build' ? 'page' : undefined}
        className="inline-flex min-h-11 min-w-11 items-center justify-center underline-offset-4 hover:text-bluebs-700 hover:underline aria-[current=page]:text-bluebs-700 aria-[current=page]:underline"
      >
        Build
      </Link>
      <span aria-hidden>|</span>
      <Link
        href="/audit"
        aria-current={pathname === '/audit' ? 'page' : undefined}
        className="inline-flex min-h-11 min-w-11 items-center justify-center underline-offset-4 hover:text-bluebs-700 hover:underline aria-[current=page]:text-bluebs-700 aria-[current=page]:underline"
      >
        Audit
      </Link>
    </div>
  )
}

function Logo({
  iconOnly,
  inlineOnMobile = false,
  showGuideLinks = true,
}: {
  iconOnly: boolean
  inlineOnMobile?: boolean
  showGuideLinks?: boolean
}) {
  return (
    <div
      className={`flex shrink-0 md:flex-row md:items-center md:gap-3 ${
        inlineOnMobile ? 'flex-row items-center gap-2' : 'flex-col items-start'
      }`}
    >
      <Link
        href="/"
        className="flex min-h-10 min-w-11 items-center justify-start md:min-w-0"
        aria-label="Juicebox home"
      >
        <Image
          src={iconOnly ? logoIcon : logoFull}
          alt="Juicebox"
          width={iconOnly ? 25 : 144}
          height={iconOnly ? 32 : 33}
          priority
          className="h-8 w-auto"
        />
      </Link>
      {showGuideLinks ? (
        <GuideLinks
          // Stacked under the wordmark, the links sit tight against it so the
          // two lines read as one block centered on the search bar.
          className={`md:h-10 md:self-center md:pl-0 ${
            inlineOnMobile ? 'h-10 self-center pl-0' : 'min-h-11 self-start md:mt-0'
          }`}
        />
      ) : null}
    </div>
  )
}

function DesktopNavigation({ iconOnly, isWide }: { iconOnly: boolean; isWide: boolean }) {
  return (
    <nav
      aria-label="Main navigation"
      className={`mx-auto hidden min-h-[84px] w-full grid-cols-[minmax(max-content,1fr)_minmax(10rem,24rem)_minmax(max-content,1fr)] items-center gap-x-[clamp(0.5rem,1.5vw,1.5rem)] px-6 py-2 md:grid ${
        isWide ? 'max-w-[1800px]' : 'max-w-6xl'
      }`}
    >
      <div className="col-start-1 row-start-1 flex flex-col items-start gap-y-1 justify-self-start md:flex-row md:items-center md:gap-x-5">
        <Logo iconOnly={iconOnly} showGuideLinks={false} />
        <GuideLinks className="h-10 translate-y-0.5 md:self-center" />
      </div>
      <div className="col-start-2 row-start-1 w-full min-w-0 max-w-96 justify-self-center">
        <SearchBox expanded compactPlaceholder="Search" />
      </div>
      <div className="col-start-3 row-start-1 justify-self-end">
        <WalletButton />
      </div>
    </nav>
  )
}

function MobileNavigation({ iconOnly }: { iconOnly: boolean }) {
  const [searchFocused, setSearchFocused] = useState(false)
  // The search column can get too narrow for even the word "Search" once the
  // wallet pill takes its share; then it collapses to an icon at the right,
  // and tapping it opens the full-width field the focused state already uses.
  const [searchOpen, setSearchOpen] = useState(false)
  const expanded = searchFocused || searchOpen

  return (
    // The logo alone shares row one with the search and wallet, so it centers
    // on them; the guide links hang in a second row underneath.
    <nav aria-label="Main navigation" className="mx-auto grid min-h-[84px] max-w-6xl grid-cols-[auto_minmax(0,1fr)_auto] grid-rows-[auto_auto] items-center gap-x-2 px-4 py-2 md:hidden">
      <div className={expanded ? 'hidden' : 'row-start-1 justify-self-start'}>
        <Logo iconOnly={iconOnly} inlineOnMobile={iconOnly} showGuideLinks={iconOnly} />
      </div>
      {!expanded && !iconOnly ? (
        <GuideLinks className="col-span-3 col-start-1 row-start-2 min-h-11 justify-self-start" />
      ) : null}
      <div
        className={`row-start-1 w-full min-w-0 @container ${
          expanded
            ? 'col-span-2 col-start-1 max-w-none justify-self-center'
            : 'col-start-2 max-w-[280px] justify-self-end'
        }`}
      >
        {expanded ? (
          <SearchBox
            expanded
            placeholder="Search"
            autoFocus={searchOpen}
            onFocusChange={focused => {
              setSearchFocused(focused)
              if (!focused) setSearchOpen(false)
            }}
          />
        ) : (
          <>
            <div className="@max-[7.5rem]:hidden">
              <SearchBox expanded placeholder="Search" onFocusChange={setSearchFocused} />
            </div>
            <div className="hidden justify-end @max-[7.5rem]:flex">
              <button
                type="button"
                aria-label="Search"
                onClick={() => setSearchOpen(true)}
                className="input-well flex h-11 w-11 shrink-0 items-center justify-center text-smoke-600 hover:text-ink"
              >
                <MagnifierIcon className="h-4 w-4" />
              </button>
            </div>
          </>
        )}
      </div>
      <div className="col-start-3 row-start-1 justify-self-end">
        {expanded ? (
          <Logo iconOnly inlineOnMobile showGuideLinks={false} />
        ) : (
          <WalletButton />
        )}
      </div>
    </nav>
  )
}

export function SiteNavigation() {
  const pathname = usePathname()
  const routeSegment = projectRouteSegmentFromPathname(pathname)
  const iconOnly = !!routeSegment && /^(?:[^/]+:\d+|@[^/]+)$/.test(routeSegment)
  const isWide = pathname === '/' || iconOnly

  return (
    <>
      <DesktopNavigation iconOnly={iconOnly} isWide={isWide} />
      <MobileNavigation iconOnly={iconOnly} />
    </>
  )
}
