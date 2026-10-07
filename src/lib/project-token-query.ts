import type { JBChainId } from '@bananapus/nana-sdk-core'
import { getTokenAddress } from '@bananapus/nana-sdk-core/v6'
import { erc20Abi, type Address, type PublicClient } from 'viem'
import { PERSIST } from '@/lib/query-persist'

/** Existing project-token cache contract, shared with every symbol consumer. */
export function projectTokenQuery(
  client: PublicClient,
  chainId: JBChainId,
  projectId: number,
) {
  return {
    queryKey: ['marketProjectSymbol', chainId, projectId] as const,
    meta: PERSIST,
    staleTime: 5 * 60_000,
    retry: 1,
    queryFn: async (): Promise<{ address: Address; symbol: string } | null> => {
      const token = await getTokenAddress(client, {
        chainId,
        projectId: BigInt(projectId),
      })
      if (!token) return null
      const symbol = await client.readContract({
        address: token,
        abi: erc20Abi,
        functionName: 'symbol',
      })
      return { address: token, symbol }
    },
  }
}
