import type { Metadata, Viewport } from 'next'
import localFont from 'next/font/local'
import './globals.css'
import logoIcon from '@/assets/brand/logo-icon.svg'
import { SiteFooter } from '@/components/SiteFooter'
import { SiteNavigation } from '@/components/SiteNavigation'
import { ViewAsBanner } from '@/components/ViewAsBanner'
import { Providers } from '@/providers/Providers'

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
    icon: logoIcon.src,
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
            <ViewAsBanner />
            <SiteNavigation />
          </header>

          <main className="flex-1">{children}</main>

          <SiteFooter />

        </Providers>
      </body>
    </html>
  )
}
