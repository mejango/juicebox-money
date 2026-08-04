import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  LIVE_PUBLIC_READ_CACHE_CONTROL,
  PUBLIC_READ_CACHE_CONTROL,
} from '@/lib/api-cache'

/**
 * These endpoints all read the indexer, which routinely takes seconds. The
 * shared cache is what keeps that off every visitor's critical path, so a
 * route quietly losing its header is a real regression.
 */
const CACHED_ROUTES = [
  'src/app/api/price-history/route.ts',
  'src/app/api/participants/route.ts',
  'src/app/api/auto-issuances/route.ts',
  'src/app/api/activity/route.ts',
]

/** Account-scoped or poll-driven: must never be shared between visitors. */
const UNCACHED_ROUTES = [
  'src/app/api/shop-customers/route.ts',
  'src/app/api/project-ready/route.ts',
]

describe('public read cache headers', () => {
  it('serves stale instantly while revalidating, so one request waits at most', () => {
    expect(PUBLIC_READ_CACHE_CONTROL).toContain('public')
    expect(PUBLIC_READ_CACHE_CONTROL).toContain('s-maxage=')
    expect(PUBLIC_READ_CACHE_CONTROL).toContain('stale-while-revalidate=')
    expect(LIVE_PUBLIC_READ_CACHE_CONTROL).toContain('s-maxage=15')
  })

  it.each(CACHED_ROUTES)('%s sends the shared cache header', route => {
    expect(readFileSync(route, 'utf8')).toMatch(
      /(?:publicReadHeaders|livePublicReadHeaders)/,
    )
  })

  it.each(UNCACHED_ROUTES)('%s is never shared-cached', route => {
    expect(readFileSync(route, 'utf8')).not.toContain('publicReadHeaders')
  })

  it.each(CACHED_ROUTES)('%s does not cache its error response', route => {
    const source = readFileSync(route, 'utf8')
    for (const line of source.split('\n')) {
      if (line.includes('status: 4') || line.includes('status: 5')) {
        expect(line).not.toMatch(/(?:publicReadHeaders|livePublicReadHeaders)/)
      }
    }
  })
})
