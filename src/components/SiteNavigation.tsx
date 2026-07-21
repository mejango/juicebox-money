'use client'

import Image from 'next/image'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState } from 'react'
import logoFull from '@/assets/brand/logo-full.svg'
import logoIcon from '@/assets/brand/logo-icon.svg'
import { SearchBox } from './SearchBox'
import { WalletButton } from './WalletButton'

function MenuIcon({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-7 w-7"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      aria-hidden
    >
      {open ? (
        <>
          <path d="M5 5l14 14" />
          <path d="M19 5 5 19" />
        </>
      ) : (
        <>
          <path d="M4 7h16" />
          <path d="M4 12h16" />
          <path d="M4 17h16" />
        </>
      )}
    </svg>
  )
}

function Logo({
  closeMenu,
  iconOnly,
}: {
  closeMenu?: () => void
  iconOnly: boolean
}) {
  return (
    <Link
      href="/"
      onClick={closeMenu}
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
    <nav className="mx-auto hidden h-[72px] w-full max-w-6xl grid-cols-[minmax(0,1fr)_minmax(240px,384px)_minmax(0,1fr)] items-center gap-6 px-6 md:grid">
      <div className="justify-self-start">
        <Logo iconOnly={iconOnly} />
      </div>
      <div className="w-full">
        <SearchBox expanded />
      </div>
      <div className="justify-self-end">
        <WalletButton />
      </div>
    </nav>
  )
}

function MobileNavigation({ iconOnly }: { iconOnly: boolean }) {
  const [open, setOpen] = useState(false)
  const closeMenu = () => setOpen(false)

  return (
    <nav className="mx-auto max-w-6xl md:hidden">
      <div className="flex h-[72px] items-center justify-between px-4 sm:px-6">
        <Logo closeMenu={closeMenu} iconOnly={iconOnly} />
        <button
          type="button"
          onClick={() => setOpen(value => !value)}
          aria-label={open ? 'Close menu' : 'Open menu'}
          aria-expanded={open}
          aria-controls="mobile-site-menu"
          className="icon-button"
        >
          <MenuIcon open={open} />
        </button>
      </div>

      {open ? (
        <div
          id="mobile-site-menu"
          className="absolute inset-x-0 top-full max-h-[calc(100vh-72px)] overflow-y-auto border-y border-smoke-200 bg-bone px-4 py-5 shadow-lg sm:px-6"
        >
          <SearchBox expanded />
          <div className="mt-4 border-t border-smoke-200 pt-4">
            <WalletButton />
          </div>
        </div>
      ) : null}
    </nav>
  )
}

export function SiteNavigation() {
  const pathname = usePathname()
  const iconOnly = /^\/[^/]+:\d+$/.test(pathname)

  return (
    <>
      <DesktopNavigation iconOnly={iconOnly} />
      <MobileNavigation iconOnly={iconOnly} />
    </>
  )
}
