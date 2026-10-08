import type { Route } from '@playwright/test'
import sharp from 'sharp'

const prefix = 'https://juicebox.center/ipfs/QmbWqxBEKC3P8tqsKc98xmWNzrzDtRLMiMPL8wBuTGsMnR/homepage-'
const feeds = new Set(['top-1', 'top-2', 'top-3', 'top-4', 'top-5', 'trending', 'new', 'activity'])
const pixels = sharp({ create: { width: 512, height: 512, channels: 4, background: '#7463ff' } }).png().toBuffer()

/** Exact synthetic feed sources only; unrelated network requests retain the caller's policy. */
export function homepageImageFeed(url: string): string | undefined {
  const requested = new URL(url)
  const original = requested.pathname === '/_next/image' ? requested.searchParams.get('url') : requested.href
  if (!original?.startsWith(prefix)) return
  const feed = original.slice(prefix.length)
  return feeds.has(feed) ? feed : undefined
}

export async function fulfillHomepageImage(route: Route): Promise<boolean> {
  if (!homepageImageFeed(route.request().url())) return false
  // This fixture proves native loading/visibility, not optimizer encoding or
  // transfer quality; responsive-images.spec owns the real decoder proof.
  await route.fulfill({ status: 200, contentType: 'image/png', body: await pixels })
  return true
}
