import type { Metadata, Viewport } from 'next'
import localFont from 'next/font/local'
import Image from 'next/image'
import Link from 'next/link'
import '@getpara/react-sdk-lite/styles.css'
import './globals.css'
import { SearchBox } from '@/components/SearchBox'
import { WalletButton } from '@/components/WalletButton'
import { ParaHost, Providers } from '@/providers/Providers'

// The brand's three faces (DESIGN.md §Type), self-hosted from /public/fonts.
// Headings — PP Agrandir Medium.
const agrandir = localFont({
  src: '../../public/fonts/PPAgrandir-Medium.woff2',
  weight: '500',
  variable: '--font-agrandir',
  display: 'swap',
  fallback: ['-apple-system', 'Helvetica Neue', 'Arial', 'sans-serif'],
})

// Display — PP Agrandir Wide (big statements only).
const agrandirWide = localFont({
  src: [
    {
      path: '../../public/fonts/PPAgrandir-WideMedium.woff2',
      weight: '500',
      style: 'normal',
    },
    {
      path: '../../public/fonts/PPAgrandir-WideBold.woff2',
      weight: '700',
      style: 'normal',
    },
  ],
  variable: '--font-agrandir-wide',
  display: 'swap',
  fallback: ['-apple-system', 'Helvetica Neue', 'Arial', 'sans-serif'],
})

// Body & UI — Beatrice.
const beatrice = localFont({
  src: [
    {
      path: '../../public/fonts/Beatrice-Regular.woff2',
      weight: '400',
      style: 'normal',
    },
    {
      path: '../../public/fonts/Beatrice-Medium.woff2',
      weight: '500',
      style: 'normal',
    },
  ],
  variable: '--font-beatrice',
  display: 'swap',
  fallback: ['-apple-system', 'Helvetica Neue', 'Arial', 'sans-serif'],
})

export const metadata: Metadata = {
  title: {
    default: 'Juicebox — Fund your thing',
    template: '%s — Juicebox',
  },
  description:
    'Raise funds, reward supporters, and run your treasury in the open. Juicebox is programmable money for projects.',
  icons: {
    icon: '/brand/logo-icon.svg',
  },
}

export const viewport: Viewport = {
  themeColor: '#FFF7E8',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html
      lang="en"
      className={`${agrandir.variable} ${agrandirWide.variable} ${beatrice.variable}`}
    >
      <body className="flex min-h-screen flex-col">
        <Providers>
          <header className="sticky top-0 z-40 border-b border-smoke-200 bg-bone/90 backdrop-blur">
            <nav className="relative mx-auto flex h-16 max-w-6xl items-center gap-3 px-4 sm:px-6">
              <Link href="/" className="flex shrink-0 items-center">
                <Image
                  src="/brand/logo-full.svg"
                  alt="Juicebox"
                  width={124}
                  height={28}
                  priority
                  className="h-7 w-auto"
                />
              </Link>
              <SearchBox />
              {/* Desktop-only nav item; mobile keeps it in the hero. */}
              <Link
                href="/create"
                className="hidden shrink-0 text-sm font-medium text-smoke-700 transition-colors hover:text-ink md:inline"
              >
                Start a project
              </Link>
              <div className="shrink-0">
                <WalletButton />
              </div>
            </nav>
          </header>

          <main className="flex-1">{children}</main>

          <footer className="border-t border-smoke-200">
            <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-8 text-sm text-smoke-700 sm:flex-row sm:items-center sm:justify-between sm:px-6">
              <Image
                src="/brand/logo-full.svg"
                alt="Juicebox"
                width={106}
                height={24}
                className="h-6 w-auto"
              />
              <div className="flex gap-6">
                <a
                  href="https://docs.juicebox.money"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium hover:text-ink"
                >
                  Docs
                </a>
                <a
                  href="https://github.com/Bananapus"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium hover:text-ink"
                >
                  GitHub
                </a>
              </div>
            </div>
          </footer>

          {/* Para's auth modal host — renders no app content (see Providers). */}
          <ParaHost />
        </Providers>
      </body>
    </html>
  )
}
