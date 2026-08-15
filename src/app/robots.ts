import type { MetadataRoute } from 'next'

const siteOrigin = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3001'

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        // One thin page per wallet address is unbounded crawl space with nothing
        // to rank. /api stays crawlable: Twitterbot and friends honour robots.txt
        // when fetching og:image, which is served from /api/project-og.
        disallow: ['/account/'],
      },
    ],
    sitemap: new URL('/sitemap.xml', siteOrigin).href,
  }
}
