import type { Metadata, Viewport } from 'next'
import Link from 'next/link'
import '@getpara/react-sdk-lite/styles.css'
import './globals.css'
import { SearchBox } from '@/components/SearchBox'
import { WalletButton } from '@/components/WalletButton'
import { ParaHost, Providers } from '@/providers/Providers'

export const metadata: Metadata = {
  title: {
    default: 'Juicebox — Fund your thing',
    template: '%s — Juicebox',
  },
  description:
    'Raise funds, reward supporters, and run your treasury in the open. Juicebox is programmable money for projects.',
}

export const viewport: Viewport = {
  themeColor: '#FFB32C',
}

function JuiceboxMark() {
  // A tiny juicebox: carton + straw.
  return (
    <svg viewBox="0 0 24 24" className="h-7 w-7" aria-hidden>
      <rect
        x="4"
        y="7"
        width="13"
        height="14"
        rx="2.5"
        className="fill-juice-400"
      />
      <rect x="4" y="7" width="13" height="5" rx="2.5" className="fill-juice-500" />
      <path
        d="M14 8 L19 2.5"
        stroke="#201E1A"
        strokeWidth="2"
        strokeLinecap="round"
        fill="none"
      />
      <circle cx="8.5" cy="15.5" r="1.3" fill="#201E1A" />
      <circle cx="12.5" cy="15.5" r="1.3" fill="#201E1A" />
    </svg>
  )
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body className="flex min-h-screen flex-col">
        <Providers>
          <header className="sticky top-0 z-40 border-b border-ink/10 bg-cream/90 backdrop-blur">
            <nav className="relative mx-auto flex h-16 max-w-6xl items-center gap-3 px-4 sm:px-6">
              <Link
                href="/"
                className="flex shrink-0 items-center gap-2 text-lg font-extrabold tracking-tight"
              >
                <JuiceboxMark />
                Juicebox
              </Link>
              <SearchBox />
              {/* Desktop-only nav item; mobile keeps it in the hero. */}
              <Link
                href="/create"
                className="hidden shrink-0 text-sm font-semibold text-ink/70 transition-colors hover:text-ink md:inline"
              >
                Start a project
              </Link>
              <div className="shrink-0">
                <WalletButton />
              </div>
            </nav>
          </header>

          <main className="flex-1">{children}</main>

          <footer className="border-t border-ink/10">
            <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-8 text-sm text-ink/60 sm:flex-row sm:items-center sm:justify-between sm:px-6">
              <p className="flex items-center gap-2 font-semibold text-ink/80">
                <JuiceboxMark />
                Juicebox
              </p>
              <div className="flex gap-6">
                <a
                  href="https://docs.juicebox.money"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-ink"
                >
                  Docs
                </a>
                <a
                  href="https://github.com/Bananapus"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-ink"
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
