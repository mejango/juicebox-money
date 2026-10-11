'use client'

import { useQuery } from '@tanstack/react-query'
import { getProjectNftInventory } from '@bananapus/nana-sdk-core/v6'
import type { JBChainId } from '@bananapus/nana-sdk-core'
import type { PublicClient } from 'viem'
import { usePublicClient } from 'wagmi'

/** Protocol identity is independent of optional tier metadata and full shop reads. */
export function useProjectNftProtocol(chainId: JBChainId, projectId: number, isRevnet: boolean) {
  const publicClient = usePublicClient({ chainId }) as PublicClient | undefined
  return useQuery({
    queryKey: ['payNftProtocol', chainId, projectId, isRevnet],
    enabled: !!publicClient,
    staleTime: 60_000,
    retry: 1,
    queryFn: () => getProjectNftInventory(publicClient!, {
      chainId, projectId: BigInt(projectId), isRevnet, tierLimit: 1,
    }),
  })
}
