'use client'

import { useKeptQuery } from '@/hooks/useKeptQuery'

import type { JBChainId } from '@bananapus/nana-sdk-core'
import type { PublicClient } from 'viem'
import { usePublicClient } from 'wagmi'
import { projectTokenQuery } from '@/lib/project-token-query'

/**
 * The project's OWN ERC-20 token address + symbol, resolved on-chain (NOT
 * bendystraw's accounting symbol). Null when no ERC-20 is deployed. Shares
 * the Market card's cache key so every panel on a project page reads it once.
 */
export function useProjectTokenSymbol(chainId: JBChainId, projectId: number) {
  const publicClient = usePublicClient({ chainId }) as PublicClient | undefined
  return useKeptQuery({
    ...projectTokenQuery(publicClient!, chainId, projectId),
    enabled: !!publicClient,
  })
}
