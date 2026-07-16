import type { Metadata, Viewport } from 'next'
import localFont from 'next/font/local'
import Link from 'next/link'
import '@getpara/react-sdk-lite/styles.css'
import './globals.css'
import { SearchBox } from '@/components/SearchBox'
import { WalletButton } from '@/components/WalletButton'
import { ParaHost, Providers } from '@/providers/Providers'

// Voice 3 — the Silkscreen bitmap face (OFL, license in src/fonts).
// Buttons, badges, and tiny labels ONLY.
const silkscreen = localFont({
  src: [
    { path: '../fonts/silkscreen-400.woff2', weight: '400', style: 'normal' },
    { path: '../fonts/silkscreen-700.woff2', weight: '700', style: 'normal' },
  ],
  variable: '--font-pixel',
  display: 'swap',
  fallback: ['ui-monospace', 'Menlo', 'monospace'],
})

export const metadata: Metadata = {
  title: {
    default: 'Juicebox — Fund your thing',
    template: '%s — Juicebox',
  },
  description:
    'Raise funds, reward supporters, and run your treasury in the open. Juicebox is programmable money for projects.',
}

export const viewport: Viewport = {
  themeColor: '#141217',
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
        rx="1.5"
        className="fill-juice"
      />
      <rect x="4" y="7" width="13" height="5" rx="1.5" className="fill-juice-600" />
      <path
        d="M14 8 L19 2.5"
        stroke="#F2EFE6"
        strokeWidth="2"
        strokeLinecap="round"
        fill="none"
      />
      <circle cx="8.5" cy="15.5" r="1.3" fill="#141217" />
      <circle cx="12.5" cy="15.5" r="1.3" fill="#141217" />
    </svg>
  )
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className={silkscreen.variable}>
      <body className="flex min-h-screen flex-col">
        <Providers>
          <header className="sticky top-0 z-40 border-b-2 border-frame bg-bg/90 backdrop-blur">
            <nav className="relative mx-auto flex h-16 max-w-6xl items-center gap-3 px-4 sm:px-6">
              <Link
                href="/"
                className="flex shrink-0 items-center gap-2 font-display text-lg font-extrabold tracking-tight text-ink"
              >
                <JuiceboxMark />
                Juicebox
              </Link>
              <SearchBox />
              {/* Desktop-only nav item; mobile keeps it in the hero. */}
              <Link
                href="/create"
                className="hidden shrink-0 font-pixel text-xs uppercase tracking-wider text-dim transition-colors hover:text-juice md:inline"
              >
                Start a project
              </Link>
              <div className="shrink-0">
                <WalletButton />
              </div>
            </nav>
          </header>

          <main className="flex-1">{children}</main>

          <footer className="border-t-2 border-frame">
            <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-8 text-sm text-dim sm:flex-row sm:items-center sm:justify-between sm:px-6">
              <p className="flex items-center gap-2 font-display font-bold text-ink">
                <JuiceboxMark />
                Juicebox
              </p>
              <div className="flex gap-6">
                <a
                  href="https://docs.juicebox.money"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-pixel text-xs uppercase tracking-wider hover:text-juice"
                >
                  Docs
                </a>
                <a
                  href="https://github.com/Bananapus"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-pixel text-xs uppercase tracking-wider hover:text-juice"
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
