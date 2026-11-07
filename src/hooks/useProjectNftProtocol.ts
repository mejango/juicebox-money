'use client'

import { useQuery } from '@tanstack/react-query'
import { getProjectNftInventory } from '@bananapus/nana-sdk-core/v6'
import type { JBChainId } from '@bananapus/nana-sdk-core'
import { usePayPublicClient } from '@/hooks/usePayPublicClient'
import { recoveringRead } from '@/lib/read-recovery'

/** Protocol identity is independent of optional tier metadata and full shop reads. */
export function useProjectNftProtocol(chainId: JBChainId, projectId: number, isRevnet: boolean) {
  const publicClient = usePayPublicClient(chainId)
  return useQuery({
    queryKey: ['payNftProtocol', chainId, projectId, isRevnet],
    enabled: !!publicClient,
    staleTime: 60_000,
    ...recoveringRead,
    queryFn: () => getProjectNftInventory(publicClient!, {
      chainId, projectId: BigInt(projectId), isRevnet, tierLimit: 1,
    }),
  })
}
