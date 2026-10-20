import { normalizeProjectHandle, type NormalizedProjectHandle } from '@/lib/project-handles'

/** Next may expose a dynamic path segment in either encoded or decoded form. */
export function decodeProjectRouteSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment)
  } catch {
    return null
  }
}

/**
 * Read a top-level project route from a client pathname and decode it exactly
 * once. A residual percent escape is a double-encoded route (for example,
 * `/%2540design` -> `%40design`) and must not be decoded again downstream.
 */
export function projectRouteSegmentFromPathname(
  pathname: string,
): string | null {
  const segments = pathname.split('/').filter(Boolean)
  if (segments.length !== 1) return null

  const decoded = decodeProjectRouteSegment(segments[0])
  if (decoded === null || /%[0-9a-f]{2}/i.test(decoded)) return null
  return decoded
}

/** Parse only the explicit `/@handle` route syntax. */
export function projectHandleFromRoute(
  segment: string,
): NormalizedProjectHandle | null {
  return segment.trim().startsWith('@')
    ? normalizeProjectHandle(segment)
    : null
}

/**
 * Navigate through the document for a mutable alias. Browsers treat an anchor
 * to the current pathname (for example `/@foo` from `/@foo#operator`) as an
 * in-document fragment change, so explicitly reload that case to force the
 * server to resolve ENS again.
 */
export function navigateToProjectHandle(path: string): void {
  const targetPathname = path.split(/[?#]/u, 1)[0] || '/'
  const currentSegment = projectRouteSegmentFromPathname(
    window.location.pathname,
  )
  const targetSegment = projectRouteSegmentFromPathname(targetPathname)
  const currentHandle = currentSegment
    ? projectHandleFromRoute(currentSegment)?.handle
    : null
  const targetHandle = targetSegment
    ? projectHandleFromRoute(targetSegment)?.handle
    : null

  if (currentHandle && targetHandle === currentHandle) {
    window.history.replaceState(window.history.state, '', path)
    window.location.reload()
    return
  }
  window.location.assign(path)
}
