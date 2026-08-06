/**
 * Project identity already rendered by the current page. Project links seed
 * this tiny in-memory cache before Next starts the destination transition so
 * the route fallback can keep showing useful information while authoritative
 * project data is fetched.
 */
export type ProjectNavigationHint = {
  name: string
  logoUri: string | null
  tagline?: string | null
}

const MAX_HINTS = 24
const hints = new Map<string, ProjectNavigationHint>()

function routeKey(href: string): string {
  const path = href.split('#', 1)[0]?.split('?', 1)[0] ?? ''
  return path.length > 1 ? path.replace(/\/+$/, '') : path
}

function normalizedHint(
  hint: ProjectNavigationHint,
): ProjectNavigationHint | null {
  const name = hint.name.trim().slice(0, 200)
  if (!name) return null
  const logoUri = hint.logoUri?.trim().slice(0, 2_048) || null
  const tagline = hint.tagline?.trim().slice(0, 500) || null
  return { name, logoUri, tagline }
}

export function rememberProjectNavigation(
  href: string,
  hint: ProjectNavigationHint,
): void {
  const key = routeKey(href)
  const normalized = normalizedHint(hint)
  if (!key.startsWith('/') || !normalized) return

  // Refresh insertion order so the least recently used hint is evicted.
  hints.delete(key)
  hints.set(key, normalized)
  if (hints.size > MAX_HINTS) {
    const oldest = hints.keys().next().value
    if (typeof oldest === 'string') hints.delete(oldest)
  }
}

export function getProjectNavigationHint(
  href: string,
): ProjectNavigationHint | null {
  return hints.get(routeKey(href)) ?? null
}

/** Test-only reset for the module-local navigation cache. */
export function clearProjectNavigationHints(): void {
  hints.clear()
}
