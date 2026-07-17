'use client'

import Image from 'next/image'
import Link from 'next/link'
import { useState } from 'react'
import { SearchBox } from './SearchBox'
import { ThemeToggle } from './ThemeToggle'
import { WalletButton } from './WalletButton'

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

function LanguageIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-6 w-6"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M4 5h8M8 3v2c0 4-2 7-5 9M5 9c1.4 2.1 3.3 3.8 5.6 5" />
      <path d="m13 21 4-10 4 10M14.3 18h5.4" />
    </svg>
  )
}

function HamburgerIcon({ open }: { open: boolean }) {
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

function Logo() {
  return (
    <Link href="/" className="flex shrink-0 items-center" aria-label="Juicebox home">
      <Image
        src="/brand/logo-full.svg"
        alt="Juicebox"
        width={144}
        height={33}
        priority
        className="h-8 w-auto dark:brightness-0 dark:invert"
      />
    </Link>
  )
}

const resourceLinks = [
  { label: 'Docs', href: 'https://docs.juicebox.money' },
  { label: 'GitHub', href: 'https://github.com/Bananapus' },
  { label: 'Discord', href: 'https://discord.com/invite/wFTh4QnDzk' },
]

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
            className="block px-4 py-3 text-sm font-medium text-ink hover:bg-smoke-25 hover:text-bluebs-600"
          >
            {link.label}
          </a>
        ))}
      </div>
    </details>
  )
}

function LanguageMenu() {
  return (
    <details className="group relative">
      <summary
        aria-label="Language"
        title="Language"
        className="icon-button cursor-pointer list-none [&::-webkit-details-marker]:hidden"
      >
        <LanguageIcon />
      </summary>
      <div className="card absolute right-0 top-full z-50 mt-1 flex w-40 items-center justify-between px-4 py-3 text-sm shadow-lg">
        <span>English</span>
        <span className="text-bluebs-600" aria-hidden>
          ✓
        </span>
      </div>
    </details>
  )
}

function DesktopNavigation() {
  return (
    <nav className="hidden h-[72px] w-full items-center gap-10 px-6 md:flex xl:px-20">
      <Logo />
      <div className="flex items-center gap-8">
        <Link href="/#trending" className="nav-link">
          Explore
        </Link>
        <ResourcesMenu />
        <Link href="/create" className="nav-link">
          Create a project
        </Link>
      </div>
      <div className="ml-auto flex items-center gap-1.5">
        <SearchBox />
        <LanguageMenu />
        <ThemeToggle />
        <div className="ml-2">
          <WalletButton />
        </div>
      </div>
    </nav>
  )
}

function MobileNavigation() {
  const [open, setOpen] = useState(false)

  return (
    <nav className="md:hidden">
      <div className="flex h-[72px] items-center justify-between px-5">
        <Logo />
        <button
          type="button"
          onClick={() => setOpen(value => !value)}
          aria-label={open ? 'Close menu' : 'Open menu'}
          aria-expanded={open}
          aria-controls="mobile-site-menu"
          className="icon-button"
        >
          <HamburgerIcon open={open} />
        </button>
      </div>

      {open ? (
        <div
          id="mobile-site-menu"
          className="absolute inset-x-0 top-full max-h-[calc(100vh-72px)] overflow-y-auto border-y border-smoke-200 bg-surface px-5 py-5 shadow-lg"
        >
          <SearchBox expanded />
          <div className="mt-4 flex flex-col">
            <Link href="/" onClick={() => setOpen(false)} className="nav-link">
              Home
            </Link>
            <Link
              href="/#trending"
              onClick={() => setOpen(false)}
              className="nav-link"
            >
              Explore
            </Link>
            <Link href="/create" onClick={() => setOpen(false)} className="nav-link">
              Create a project
            </Link>
          </div>

          <div className="mt-3 border-t border-smoke-200 pt-3">
            <p className="field-label mb-1">Resources</p>
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

          <div className="mt-3 border-t border-smoke-200 pt-3">
            <ThemeToggle showLabel />
          </div>
          <div className="mt-4">
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

