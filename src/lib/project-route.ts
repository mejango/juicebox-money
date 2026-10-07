import type { JBChainId } from '@bananapus/nana-sdk-core'
import { projectHandleFromRoute } from '@/lib/project-handles'

/** Browsing freshness only; this snapshot never authorizes a transaction. */
export const PROJECT_ROUTE_STALE_MS = 5_000

export type ProjectRouteSnapshot = {
  chainId: JBChainId
  projectId: string
  handle: string | null
  authority: string | null
  isRevnet: boolean | null
  checkedAt: number
  serverNow: number
}

export function projectRouteIdentity(route: ProjectRouteSnapshot): string {
  return `${route.chainId}:${route.projectId}:${route.authority?.toLowerCase() ?? ''}:${route.isRevnet ?? ''}`
}

export function projectRouteQueryKey(handle: string) {
  return ['projectRoute', handle] as const
}

export function projectRouteIsFresh(route: ProjectRouteSnapshot, now = Date.now()): boolean {
  return route.checkedAt <= now && now - route.checkedAt < PROJECT_ROUTE_STALE_MS
}

/** Convert server age conservatively to this browser's clock, including request transit time. */
export function localProjectRouteSnapshot(route: ProjectRouteSnapshot, requestStartedAt: number): ProjectRouteSnapshot {
  return { ...route, checkedAt: requestStartedAt - Math.max(0, route.serverNow - route.checkedAt), serverNow: requestStartedAt }
}

export function readProjectRouteSnapshot(value: unknown, handle: string, requestStartedAt: number): ProjectRouteSnapshot {
  if (!value || typeof value !== 'object') throw new Error('Project link could not be verified.')
  const row = value as ProjectRouteSnapshot
  if (
    row.handle !== handle || !projectHandleFromRoute(`@${row.handle}`) ||
    !Number.isSafeInteger(row.chainId) || row.chainId <= 0 ||
    typeof row.projectId !== 'string' || !/^[1-9]\d*$/.test(row.projectId) ||
    BigInt(row.projectId) > BigInt(Number.MAX_SAFE_INTEGER) ||
    typeof row.authority !== 'string' || !/^0x[\da-f]{40}$/i.test(row.authority) ||
    typeof row.isRevnet !== 'boolean' || !Number.isFinite(row.checkedAt) ||
    !Number.isFinite(row.serverNow) || row.serverNow < row.checkedAt
  ) throw new Error('Project link verification expired. Try again.')
  const local = localProjectRouteSnapshot(row, requestStartedAt)
  if (!projectRouteIsFresh(local)) throw new Error('Project link verification expired. Try again.')
  return local
}
