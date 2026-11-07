'use client'

import { useKeptQuery } from '@/hooks/useKeptQuery'

import type { JBChainId } from '@bananapus/nana-sdk-core'
import { usePayPublicClient } from '@/hooks/usePayPublicClient'
import { projectTokenQuery } from '@/lib/project-token-query'

/**
 * The project's OWN ERC-20 token address + symbol, resolved on-chain (NOT
 * bendystraw's accounting symbol). Null when no ERC-20 is deployed. Shares
 * the Market card's cache key so every panel on a project page reads it once.
 */
export function useProjectTokenSymbol(chainId: JBChainId, projectId: number) {
  // The Pay receipt names the token, so this read goes with the reads a payer waits on.
  const publicClient = usePayPublicClient(chainId)
  return useKeptQuery({
    ...projectTokenQuery(publicClient!, chainId, projectId),
    enabled: !!publicClient,
  })
}
