'use client'

import type { JBChainId } from '@bananapus/nana-sdk-core'
import { useQuery } from '@tanstack/react-query'
import { formatUnits, type PublicClient } from 'viem'
import { usePublicClient } from 'wagmi'
import { getCashOutContext, getContextCashOutQuote } from '@/lib/cashOut'

const ONE_TOKEN = 10n ** 18n

/**
 * The cash-out floor: what ONE project token reclaims from surplus right now,
 * in the accounting token's own terms (pair per token). Best-effort marker —
 * null when unreadable. Shares one cache entry per project across the Market
 * card and the add-liquidity flow.
 */
export function useCashOutFloor(
  chainId: JBChainId,
  projectId: number,
  enabled = true,
) {
  const publicClient = usePublicClient({ chainId }) as PublicClient | undefined
  return useQuery({
    queryKey: ['marketFloor', chainId, projectId],
    enabled: !!publicClient && enabled,
    staleTime: 60_000,
    retry: 0,
    queryFn: async (): Promise<number | null> => {
      const context = await getCashOutContext(publicClient!, {
        chainId,
        projectId: BigInt(projectId),
      })
      if (!context) return null
      const quote = await getContextCashOutQuote(publicClient!, {
        chainId,
        projectId: BigInt(projectId),
        cashOutCount: ONE_TOKEN,
        context,
      })
      const value = Number(formatUnits(quote.reclaimAmount, context.decimals))
      return Number.isFinite(value) && value > 0 ? value : null
    },
  })
}
