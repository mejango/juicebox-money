'use client'

import Image from 'next/image'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState } from 'react'
import logoFull from '@/assets/brand/logo-full.svg'
import logoIcon from '@/assets/brand/logo-icon.svg'
import { SearchBox } from './SearchBox'
import { WalletButton } from './WalletButton'

function GuideLinks({ className = '' }: { className?: string }) {
  return (
    <div
      className={`flex items-center gap-1.5 whitespace-nowrap font-agrandir text-xs font-medium leading-none text-smoke-600 sm:gap-2 sm:text-sm ${className}`}
    >
      <Link href="/learn" className="hover:text-bluebs-600">
        Learn
      </Link>
      <span aria-hidden>|</span>
      <Link href="/build" className="hover:text-bluebs-600">
        Build
      </Link>
      <span aria-hidden>|</span>
      <Link href="/audit" className="hover:text-bluebs-600">
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
          className={`md:self-center md:pl-0 ${
            inlineOnMobile ? 'self-center pl-0' : 'self-start pl-0.5'
          }`}
        />
      ) : null}
    </div>
  )
}

function DesktopNavigation({ iconOnly, isHomepage }: { iconOnly: boolean; isHomepage: boolean }) {
  return (
    <nav
      className={`mx-auto hidden min-h-[84px] w-full grid-cols-[minmax(max-content,1fr)_minmax(10rem,24rem)_minmax(max-content,1fr)] items-center gap-x-[clamp(0.5rem,1.5vw,1.5rem)] px-6 py-2 md:grid ${
        isHomepage ? 'max-w-[1800px]' : 'max-w-6xl'
      }`}
    >
      <div className="col-start-1 row-start-1 flex flex-col items-start gap-y-1 justify-self-start min-[900px]:flex-row min-[900px]:items-center min-[900px]:gap-x-3">
        <Logo iconOnly={iconOnly} showGuideLinks={false} />
        <GuideLinks className="min-[900px]:self-stretch" />
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

  return (
    <nav className="mx-auto grid min-h-[84px] max-w-6xl grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 px-4 py-2 md:hidden">
      <div className={searchFocused ? 'hidden' : 'justify-self-start'}>
        <Logo iconOnly={iconOnly} inlineOnMobile={iconOnly} />
      </div>
      <div
        className={`w-full min-w-0 justify-self-center ${
          searchFocused ? 'col-span-2 col-start-1 max-w-none' : 'col-start-2 max-w-[280px]'
        }`}
      >
        <SearchBox
          expanded
          placeholder="Search"
          onFocusChange={setSearchFocused}
        />
      </div>
      <div className="col-start-3 justify-self-end">
        {searchFocused ? (
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
  const iconOnly = /^\/[^/]+:\d+$/.test(pathname)
  const isHomepage = pathname === '/'

  return (
    <>
      <DesktopNavigation iconOnly={iconOnly} isHomepage={isHomepage} />
      <MobileNavigation iconOnly={iconOnly} />
    </>
  )
}
