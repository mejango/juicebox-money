import type { Metadata, Viewport } from 'next'
import localFont from 'next/font/local'
import './globals.css'
import logoIcon from '@/assets/brand/logo-icon.svg'
import { SiteFooter } from '@/components/SiteFooter'
import { SiteNavigation } from '@/components/SiteNavigation'
import { Providers } from '@/providers/Providers'

const siteOrigin =
  process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3001'
const railwayDomain = process.env.RAILWAY_PUBLIC_DOMAIN?.trim()
const assetOrigin =
  railwayDomain && /^[a-z0-9.-]+$/iu.test(railwayDomain)
    ? `https://${railwayDomain}`
    : siteOrigin
const socialImage = new URL('/assets/juicebox-social.png', assetOrigin).href
const siteTitle = 'Juicebox - fund your thing'
const siteDescription =
  'Raise money from anyone, anywhere, transparently on your terms.'

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
  metadataBase: new URL(siteOrigin),
  title: {
    default: siteTitle,
    template: '%s — Juicebox',
  },
  description: siteDescription,
  icons: {
    icon: logoIcon.src,
  },
  openGraph: {
    title: siteTitle,
    description: siteDescription,
    url: '/',
    type: 'website',
    images: [
      {
        url: socialImage,
        width: 1296,
        height: 738,
        alt: 'Juicebox — fund your thing',
        type: 'image/png',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: siteTitle,
    description: siteDescription,
    images: [socialImage],
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
            <SiteNavigation />
          </header>

          <main className="flex-1">{children}</main>

          <SiteFooter />

        </Providers>
      </body>
    </html>
  )
}
