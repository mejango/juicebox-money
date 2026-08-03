/**
 * Cache headers for public, project-scoped read endpoints.
 *
 * These all read the indexer, which routinely takes seconds and has taken 13s
 * under load. Without a shared cache every visitor pays that latency
 * independently, on the critical path, for data nobody can change by asking
 * for it.
 *
 * `stale-while-revalidate` is the important half: past the fresh window the
 * CDN serves the previous body instantly and refreshes in the background, so
 * exactly one request ever waits on a slow indexer.
 *
 * Only ever put this on a successful response to a request with no
 * account-scoped parameters — an error must not be cached, and anything keyed
 * to a wallet must not be shared between visitors.
 */
export const PUBLIC_READ_CACHE_CONTROL =
  'public, s-maxage=60, stale-while-revalidate=86400'

export const publicReadHeaders = {
  'Cache-Control': PUBLIC_READ_CACHE_CONTROL,
} as const
