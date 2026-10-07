import { cache } from 'react'
import type { JBChainId } from '@bananapus/nana-sdk-core'
import type { Address } from 'viem'
import { getRevnetOperatorCandidates } from '@/lib/bendystraw'
import { SUPPORTED_CHAINS } from '@/lib/chains'
import { lookupProjectHandleTarget, lookupVerifiedProjectHandle } from '@/lib/ens'
import { projectAuthorityMatchesMainnet, readLiveProjectAuthorityContext, revnetOperatorFromPermissionHistory } from '@/lib/project-fallback'
import { decodeProjectRouteSegment, projectHandleFromRoute, verifyProjectHandleAuthorityWithFallback } from '@/lib/project-handles'
import { getProjectPageData as getPageDataCached } from '@/lib/project-server-data'
import { parseUrn } from '@/lib/urn'
import { QueryClient } from '@tanstack/react-query'
import { PROJECT_ROUTE_STALE_MS, type ProjectRouteSnapshot } from '@/lib/project-route'

const getRevnetOperatorCandidatesCached = cache(getRevnetOperatorCandidates)

export type ResolvedProjectRoute = {
  chainId: JBChainId;
  projectId: number;
  handle: string | null;
  verifiedAuthority: Address | null;
  verifiedIsRevnet: boolean | null;
  checkedAt: number;
};

/**
 * Resolve either the normal chain/project URN or the bidirectionally verified
 * `/@handle` form. ENS supplies the forward pointer; JBProjectHandles must
 * independently confirm that the project's current effective authority made
 * the matching reverse claim.
 */
const resolveProjectRouteUncached =
  async (segment: string): Promise<ResolvedProjectRoute | null> => {
    // Depending on the Next runtime, a dynamic segment containing `@` can
    // arrive as either `@handle` or `%40handle`. Decode exactly once so a
    // double-encoded input never gains route syntax by accident.
    const decodedSegment = decodeProjectRouteSegment(segment);
    if (!decodedSegment) return null;
    const urn = parseUrn(decodedSegment);
    if (urn) {
      return {
        ...urn,
        handle: null,
        verifiedAuthority: null,
        verifiedIsRevnet: null,
        checkedAt: Date.now(),
      };
    }

    const requestedHandle = projectHandleFromRoute(decodedSegment);
    if (!requestedHandle) return null;
    const target = await lookupProjectHandleTarget(requestedHandle.handle);
    if (!target) return null;
    if (!SUPPORTED_CHAINS.some((chain) => chain.id === target.chainId)) {
      return null;
    }

    const result = await getPageDataCached(target.chainId, target.projectId);
    if (!result) return null;
    // Bendystraw supplies a candidate only. Live NFT ownership below decides
    // whether this is a revnet, and REVOwner then verifies the candidate.
    const indexedCandidates = await getRevnetOperatorCandidatesCached(
      target.chainId,
      target.projectId,
    ).catch(() => []);
    const initialAuthorityContext = await readLiveProjectAuthorityContext({
      chainId: target.chainId,
      projectId: target.projectId,
      revnetOperatorCandidates: indexedCandidates,
    });
    // Bendystraw is the fast discovery path only. Enumerate authoritative
    // REVOwner-scoped JBPermissions history when no live candidate was found,
    // never when a known live authority simply has a different reverse claim.
    const authorityContext = await verifyProjectHandleAuthorityWithFallback({
      requestedHandle: requestedHandle.handle,
      authorityContext: initialAuthorityContext,
      lookupHandle: setter =>
        lookupVerifiedProjectHandle({
          chainId: target.chainId,
          projectId: target.projectId,
          setter,
        }),
      recoverAuthority: async () => {
        const permissionOperator = await revnetOperatorFromPermissionHistory({
          chainId: target.chainId,
          projectId: target.projectId,
        });
        return permissionOperator
          ? readLiveProjectAuthorityContext({
              chainId: target.chainId,
              projectId: target.projectId,
              revnetOperatorCandidates: [permissionOperator],
            })
          : null;
      },
    });
    if (!authorityContext) return null;
    if (
      !(await projectAuthorityMatchesMainnet({
        chainId: target.chainId,
        authority: authorityContext.authority,
      }))
    ) {
      return null;
    }

    return {
      chainId: target.chainId as JBChainId,
      projectId: target.projectId,
      handle: requestedHandle.handle,
      verifiedAuthority: authorityContext.authority,
      verifiedIsRevnet: authorityContext.isRevnet,
      checkedAt: Date.now(),
    };
  };

const aliasQueries = new QueryClient({
  defaultOptions: { queries: { retry: false, gcTime: 60_000 } },
})
class UnverifiedProjectAlias extends Error {}

/** Hard expiry: failed verification never serves a stale or cached negative answer. */
export async function resolveProjectRoute(segment: string, force = false) {
  const decoded = decodeProjectRouteSegment(segment)
  const requested = decoded && projectHandleFromRoute(decoded)
  if (!requested) return resolveProjectRouteUncached(segment)
  const queryKey = ['verifiedProjectAlias', requested.handle] as const
  try {
    return await aliasQueries.fetchQuery({
      queryKey,
      staleTime: force ? 0 : PROJECT_ROUTE_STALE_MS,
      queryFn: async () => {
        const route = await resolveProjectRouteUncached(`@${requested.handle}`)
        if (!route) throw new UnverifiedProjectAlias('Unverified project alias')
        return route
      },
    })
  } catch (error) {
    // A failed forced recheck invalidates an earlier success even inside its
    // lease. Mark stale without canceling another request's in-flight proof.
    void aliasQueries.invalidateQueries({ queryKey, exact: true, refetchType: 'none' })
    if (error instanceof UnverifiedProjectAlias) return null
    throw error
  }
}

export const resolveProjectRouteCached = cache(resolveProjectRoute)

export function projectRouteSnapshot(route: ResolvedProjectRoute): ProjectRouteSnapshot {
  return {
    chainId: route.chainId,
    projectId: String(route.projectId),
    handle: route.handle,
    authority: route.verifiedAuthority,
    isRevnet: route.verifiedIsRevnet,
    checkedAt: route.checkedAt,
    serverNow: Date.now(),
  }
}
