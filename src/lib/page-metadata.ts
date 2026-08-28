import type { Metadata } from 'next'

const siteOrigin = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3001'
// Preview deployments have no canonical domain, so they fall back to the Railway host
// that actually serves them.
const railwayDomain = process.env.RAILWAY_PUBLIC_DOMAIN?.trim()
const assetOrigin =
  process.env.NEXT_PUBLIC_SITE_URL ??
  (railwayDomain && /^[a-z0-9.-]+$/iu.test(railwayDomain)
    ? `https://${railwayDomain}`
    : siteOrigin)
const socialImage = new URL('/assets/juicebox-social.png', assetOrigin).href

/**
 * Title, description and a complete link-preview card for a static page.
 *
 * Next replaces the whole `openGraph` object rather than merging it, so a page that
 * sets only a title silently drops the root layout's image and downgrades the Twitter
 * card to `summary`. Every page that wants its own title has to restate the image.
 *
 * `title` is the bare page name; the tab title gets ' — Juicebox' from the layout's
 * title template, and the card title has to spell it out because Next does not apply
 * that template to `og:title`.
 */
export function pageMetadata({
  title,
  description,
}: {
  title: string
  description: string
}): Metadata {
  const cardTitle = `${title} — Juicebox`
  return {
    title,
    description,
    openGraph: {
      title: cardTitle,
      description,
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
      title: cardTitle,
      description,
      images: [socialImage],
    },
  }
}
