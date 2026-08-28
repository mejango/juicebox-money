import { NextResponse, type NextRequest } from 'next/server'
import { legacyHref, parseUrn } from '@/lib/urn'

/**
 * First path segments this app serves. Anything else is a legacy V1–V5 URL
 * (/@handle aside — see below) that belongs to the app now running on
 * old.juicebox.money, so hand it over with the same path and query.
 *
 * This catches the syntactically-obvious cases with a real HTTP redirect
 * before rendering starts. Routes only resolvable with live data — /@handle
 * lookups and dot-containing paths the matcher skips — fall through to the
 * page-level redirects, which stream instead.
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
    ? ['ipfs-proof']
    : []),
])

/**
 * Files this app serves whose names contain a dot. The matcher used to skip every
 * dotted path so these would resolve, which also let `/anything.txt` fall through to
 * the [urn] route — that streams a shell, so the redirect arrived mid-response and the
 * status stayed 200. An unbounded supply of soft 404s; these are the real ones.
 */
const STATIC_ROUTES = new Set([
  'assets',
  'fonts',
  'llms.txt',
  'manifest.json',
  'robots.txt',
  'sitemap.xml',
])

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl
  const [first, ...rest] = pathname.split('/').filter(Boolean)
  if (!first || APP_ROUTES.has(first) || STATIC_ROUTES.has(first)) return
  let decoded = first
  try {
    decoded = decodeURIComponent(first)
  } catch {
    // Malformed encoding: leave as-is; it won't parse as a urn or handle.
  }
  // Single-segment urn (/eth:1) and @handle routes are this app's. Handles
  // that fail live verification still redirect, from the route itself.
  if (rest.length === 0 && (decoded.startsWith('@') || parseUrn(decoded))) {
    return
  }
  return NextResponse.redirect(legacyHref(pathname, search), 307)
}

export const config = {
  // Skip Next internals only. Dotted paths are handled in `proxy` via STATIC_ROUTES so
  // that an unknown one still gets a real redirect status instead of a 200 shell.
  matcher: ['/((?!_next/).*)'],
}
