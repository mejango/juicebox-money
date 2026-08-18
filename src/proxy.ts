import { NextResponse, type NextRequest } from 'next/server'
import { LEGACY_SITE, parseUrn } from '@/lib/urn'

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
])

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl
  const [first, ...rest] = pathname.split('/').filter(Boolean)
  if (!first || APP_ROUTES.has(first)) return
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
  return NextResponse.redirect(`${LEGACY_SITE}${pathname}${search}`, 307)
}

export const config = {
  // Skip Next internals and dot-containing paths (static assets, favicon,
  // llms.txt/robots.txt/sitemap.xml).
  matcher: ['/((?!_next/|.*\\..*).*)'],
}
