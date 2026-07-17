'use client'

import Image from 'next/image'
import Link from 'next/link'
import { useState } from 'react'
import { SearchBox } from './SearchBox'
import { WalletButton } from './WalletButton'

const resourceLinks = [
  { label: 'Docs', href: 'https://docs.juicebox.money' },
  { label: 'GitHub', href: 'https://github.com/Bananapus' },
  { label: 'Discord', href: 'https://discord.com/invite/wFTh4QnDzk' },
]

function ChevronIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 20 20"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="m5 7.5 5 5 5-5" />
    </svg>
  )
}

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

function Logo({ closeMenu }: { closeMenu?: () => void }) {
  return (
    <Link
      href="/"
      onClick={closeMenu}
      className="flex shrink-0 items-center"
      aria-label="Juicebox home"
    >
      <Image
        src="/brand/logo-full.svg"
        alt="Juicebox"
        width={144}
        height={33}
        priority
        className="h-8 w-auto"
      />
    </Link>
  )
}

function ResourcesMenu() {
  return (
    <details className="group relative">
      <summary className="nav-link cursor-pointer list-none gap-1.5 [&::-webkit-details-marker]:hidden">
        Resources
        <ChevronIcon className="h-4 w-4 transition-transform group-open:rotate-180" />
      </summary>
      <div className="card absolute left-0 top-full z-50 mt-1 w-52 overflow-hidden py-1.5 shadow-lg">
        {resourceLinks.map(link => (
          <a
            key={link.label}
            href={link.href}
            target="_blank"
            rel="noopener noreferrer"
            className="menu-item"
          >
            {link.label}
          </a>
        ))}
      </div>
    </details>
  )
}

function DesktopNavigation() {
  return (
    <nav className="mx-auto hidden h-[72px] w-full max-w-6xl items-center gap-9 px-6 md:flex">
      <Logo />
      <div className="flex items-center gap-5 lg:gap-7">
        <Link href="/#trending" className="nav-link">
          Explore
        </Link>
        <ResourcesMenu />
        <Link href="/create" className="nav-link">
          Create a project
        </Link>
      </div>
      <div className="ml-auto flex items-center gap-2">
        <SearchBox />
        <WalletButton />
      </div>
    </nav>
  )
}

function MobileNavigation() {
  const [open, setOpen] = useState(false)
  const closeMenu = () => setOpen(false)

  return (
    <nav className="mx-auto max-w-6xl md:hidden">
      <div className="flex h-[72px] items-center justify-between px-4 sm:px-6">
        <Logo closeMenu={closeMenu} />
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
          <div className="mt-4 flex flex-col">
            <Link href="/" onClick={closeMenu} className="nav-link w-full">
              Home
            </Link>
            <Link
              href="/#trending"
              onClick={closeMenu}
              className="nav-link w-full"
            >
              Explore
            </Link>
            <Link href="/create" onClick={closeMenu} className="nav-link w-full">
              Create a project
            </Link>
          </div>

          <div className="mt-3 border-t border-smoke-200 pt-3">
            <p className="mb-1 text-sm font-medium text-grey-500">Resources</p>
            {resourceLinks.map(link => (
              <a
                key={link.label}
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
                className="nav-link w-full"
              >
                {link.label}
              </a>
            ))}
          </div>
          <div className="mt-4 border-t border-smoke-200 pt-4">
            <WalletButton />
          </div>
        </div>
      ) : null}
    </nav>
  )
}

export function SiteNavigation() {
  return (
    <>
      <DesktopNavigation />
      <MobileNavigation />
    </>
  )
}
