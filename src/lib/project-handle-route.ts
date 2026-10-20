import type { NormalizedProjectHandle } from '@/lib/project-handles'

type ProjectHandles = typeof import('@/lib/project-handles')
let projectHandles: ProjectHandles | undefined
let loadingProjectHandles: Promise<ProjectHandles> | undefined

/**
 * Handle routes normalize with ENSIP-15, whose tables (~26 KiB) load with the
 * handle module on the first `@` segment instead of with every page.
 */
function loadProjectHandles(): Promise<ProjectHandles> {
  loadingProjectHandles ??= import('@/lib/project-handles').then(
    module => (projectHandles = module),
    error => {
      // Webpack forgets a failed chunk, so the next call requests it again.
      loadingProjectHandles = undefined
      throw error
    },
  )
  return loadingProjectHandles
}

function isHandleSegment(segment: string): boolean {
  return segment.trim().startsWith('@')
}

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
export async function projectHandleFromRoute(
  segment: string,
): Promise<NormalizedProjectHandle | null> {
  if (!isHandleSegment(segment)) return null
  return (await loadProjectHandles()).normalizeProjectHandle(segment)
}

/**
 * projectHandleFromRoute's answer without waiting: `undefined` for a handle
 * segment until the normalizer has loaded.
 */
export function peekProjectHandleFromRoute(
  segment: string,
): NormalizedProjectHandle | null | undefined {
  if (!isHandleSegment(segment)) return null
  return projectHandles?.normalizeProjectHandle(segment)
}

/**
 * Navigate through the document for a mutable alias. Browsers treat an anchor
 * to the current pathname (for example `/@foo` from `/@foo#operator`) as an
 * in-document fragment change, so explicitly reload that case to force the
 * server to resolve ENS again. Only the same decoded segment is a fragment
 * change, so this needs no normalizer and never waits.
 */
export function navigateToProjectHandle(path: string): void {
  const targetPathname = path.split(/[?#]/u, 1)[0] || '/'
  const current = projectRouteSegmentFromPathname(window.location.pathname)
  const target = projectRouteSegmentFromPathname(targetPathname)
  if (current && isHandleSegment(current) && target === current) {
    window.history.replaceState(window.history.state, '', path)
    window.location.reload()
    return
  }
  window.location.assign(path)
}
