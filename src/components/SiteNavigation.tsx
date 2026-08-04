'use client'

import Image from 'next/image'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import logoFull from '@/assets/brand/logo-full.svg'
import logoIcon from '@/assets/brand/logo-icon.svg'
import { SearchBox } from './SearchBox'
import { WalletButton } from './WalletButton'

function Logo({ iconOnly }: { iconOnly: boolean }) {
  return (
    <Link
      href="/"
      className="flex min-h-11 min-w-11 shrink-0 items-center justify-center"
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
  )
}

function DesktopNavigation({ iconOnly }: { iconOnly: boolean }) {
  return (
    <nav className="mx-auto hidden h-[72px] w-full max-w-6xl grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-6 px-6 md:grid">
      <div className="justify-self-start">
        <Logo iconOnly={iconOnly} />
      </div>
      <div className="w-full min-w-0 max-w-96 justify-self-center">
        <SearchBox expanded compactPlaceholder="Search" />
      </div>
      <div className="justify-self-end">
        <WalletButton />
      </div>
    </nav>
  )
}

function MobileNavigation() {
  return (
    <nav className="mx-auto grid h-[72px] max-w-6xl grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 px-4 md:hidden">
      <Logo iconOnly={false} />
      <div className="w-full max-w-[280px] min-w-0 justify-self-center">
        <SearchBox expanded placeholder="Search" />
      </div>
      <div className="justify-self-end">
        <WalletButton />
      </div>
    </nav>
  )
}

export function SiteNavigation() {
  const pathname = usePathname()
  const iconOnly = /^\/[^/]+:\d+$/.test(pathname)

  return (
    <>
      <DesktopNavigation iconOnly={iconOnly} />
      <MobileNavigation />
    </>
  )
}
