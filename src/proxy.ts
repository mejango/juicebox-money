import { NextResponse, type NextRequest } from 'next/server'
import { legacyHref, legacyPageExists, parseUrn } from '@/lib/urn'

/**
 * First path segments this app serves. Anything else may be a legacy V1–V5 URL
 * (/@handle aside — see below) on the app now running on old.juicebox.money.
 * Hand it over only when that app has the page; otherwise it is a bad path, and
 * bad paths 404 here.
 *
 * Deciding before rendering is what gives these a real HTTP status. Routes only
 * resolvable with live data — /@handle lookups and dot-containing paths the
 * matcher skips — are decided by the [urn] page instead, which streams.
 */
const APP_ROUTES = new Set([
  'account',
  'api',
  'audit',
  'build',
  'create',
  'learn',
  'modal-proof',
  ...(process.env.NEXT_PUBLIC_DETERMINISTIC_BROWSER === 'true'
    ? ['ipfs-proof', 'project-diagnostics-proof', 'defifa-inventory-proof', 'tall-confirm-proof']
    : []),
])

/** Project tabs a slash path can name, the form revnet.money links use. */
const PROJECT_TABS = new Set([
  'activity', 'extras', 'funds', 'operator', 'overview', 'owner', 'owners', 'rulesets', 'shop', 'terms', 'tokens',
])

/** A tab's subtabs, as tabSlug writes their labels into the hash. */
const OWNERS_SUBTABS = new Set(['accounts', 'market', 'settlement', 'splits', 'reserved', 'autoissuance', 'loans'])
const PROJECT_SUBTABS: Record<string, Set<string>> = {
  owners: OWNERS_SUBTABS,
  tokens: OWNERS_SUBTABS,
  shop: new Set(['inventory', 'customers']),
}
const isProjectTabPath = ([tab, subtab, ...more]: string[]) =>
  !more.length && PROJECT_TABS.has(tab?.toLowerCase()) &&
  (!subtab || !!PROJECT_SUBTABS[tab.toLowerCase()]?.has(subtab.toLowerCase()))

// Two segments under no app route, so Next renders app/not-found.tsx with a 404.
const NO_ROUTE_PATH = '/_/not-found'

export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl
  const [first, ...rest] = pathname.split('/').filter(Boolean)
  if (!first || APP_ROUTES.has(first)) return
  let decoded = first
  try {
    decoded = decodeURIComponent(first)
  } catch {
    // Malformed encoding: leave as-is; it won't parse as a urn or handle.
  }
  // /eth:3/owners/market is the project's #owners/market tab.
  if (isProjectTabPath(rest) && (decoded.startsWith('@') || parseUrn(decoded))) {
    const target = new URL(`/${first}${search}#${rest.join('/').toLowerCase()}`, request.url)
    return NextResponse.redirect(target, 307)
  }
  // Single-segment urn (/eth:1) and @handle routes are this app's.
  if (rest.length === 0 && (decoded.startsWith('@') || parseUrn(decoded))) {
    return
  }
  const legacy = legacyHref(pathname, search)
  if (await legacyPageExists(legacy)) return NextResponse.redirect(legacy, 307)
  const notFound = request.nextUrl.clone()
  notFound.pathname = NO_ROUTE_PATH
  return NextResponse.rewrite(notFound)
}

export const config = {
  // Skip Next internals and dot-containing paths (static assets, favicon,
  // llms.txt/robots.txt/sitemap.xml).
  matcher: ['/((?!_next/|.*\\..*).*)'],
}
