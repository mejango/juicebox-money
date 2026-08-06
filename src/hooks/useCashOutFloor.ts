'use client'

import type { JBChainId } from '@bananapus/nana-sdk-core'
import { useQuery } from '@tanstack/react-query'
import { formatUnits, type PublicClient } from 'viem'
import { usePublicClient } from 'wagmi'
import { getCashOutContext, getContextCashOutQuote } from '@/lib/cashOut'
import { cachedQuery } from '@/lib/query-persist'

const ONE_TOKEN = 10n ** 18n

/**
 * The cash-out floor: what ONE project token reclaims from surplus right now,
 * NET of the protocol cash-out fee, in the accounting token's own terms (pair
 * per token) — the same number the confirm modal shows. Best-effort marker —
 * null when unreadable. Shares one cache entry per project across the Market
 * card and the add-liquidity flow.
 */
export function useCashOutFloor(
  chainId: JBChainId,
  projectId: number,
  enabled = true,
) {
  const publicClient = usePublicClient({ chainId }) as PublicClient | undefined
  return useQuery(
    cachedQuery({
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
      // NET of the protocol fee, matching what the confirm modal quotes and what a holder
      // actually receives. `reclaimAmount` is the pre-fee figure; the SDK already computes
      // the fee correctly (it applies only when the cash-out tax is non-zero), so reading
      // the gross field here overstated the floor on the Market card, the chart marker and
      // the LP default range alike.
      const value = Number(formatUnits(quote.reclaimAmountAfterFee, context.decimals))
      return Number.isFinite(value) && value > 0 ? value : null
    },
    }),
  )
}
