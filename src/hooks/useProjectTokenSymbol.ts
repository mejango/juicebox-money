'use client'

import type { JBChainId } from '@bananapus/nana-sdk-core'
import { getTokenAddress } from '@bananapus/nana-sdk-core/v6'
import { useQuery } from '@tanstack/react-query'
import { erc20Abi, type Address, type PublicClient } from 'viem'
import { usePublicClient } from 'wagmi'

/**
 * The project's OWN ERC-20 token address + symbol, resolved on-chain (NOT
 * bendystraw's accounting symbol). Null when no ERC-20 is deployed. Shares
 * the Market card's cache key so every panel on a project page reads it once.
 */
export function useProjectTokenSymbol(chainId: JBChainId, projectId: number) {
  const publicClient = usePublicClient({ chainId }) as PublicClient | undefined
  return useQuery({
    queryKey: ['marketProjectSymbol', chainId, projectId],
    enabled: !!publicClient,
    staleTime: 5 * 60_000,
    retry: 1,
    queryFn: async (): Promise<{ address: Address; symbol: string } | null> => {
      const token = await getTokenAddress(publicClient!, {
        chainId,
        projectId: BigInt(projectId),
      })
      if (!token) return null
      const symbol = (await publicClient!.readContract({
        address: token,
        abi: erc20Abi,
        functionName: 'symbol',
      })) as string
      return { address: token, symbol }
    },
  })
}
