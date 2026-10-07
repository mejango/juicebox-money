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

const getRevnetOperatorCandidatesCached = cache(getRevnetOperatorCandidates)

export type ResolvedProjectRoute = {
  chainId: JBChainId;
  projectId: number;
  handle: string | null;
  verifiedAuthority: Address | null;
  verifiedIsRevnet: boolean | null;
};

/**
 * Resolve either the normal chain/project URN or the bidirectionally verified
 * `/@handle` form. ENS supplies the forward pointer; JBProjectHandles must
 * independently confirm that the project's current effective authority made
 * the matching reverse claim.
 */
export const resolveProjectRouteCached = cache(
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
    };
  },
);

