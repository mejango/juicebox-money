'use client'

import { jbMultiTerminalAbi, type JBChainId } from '@bananapus/nana-sdk-core'
import { getCurrentRuleset, v6Address } from '@bananapus/nana-sdk-core/v6'
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
      const client = publicClient!
      const context = await getCashOutContext(client, {
        chainId,
        projectId: BigInt(projectId),
      })
      if (!context) return null

      // The fee is conditional, so the net is only knowable with the ruleset's
      // cash-out tax rate — and, when that rate is zero, the terminal's
      // fee-free surplus counter as well. Either read failing leaves the floor
      // UNKNOWN: the gross would overstate it and zero would erase it, so the
      // marker is withheld instead.
      const ruleset = await getCurrentRuleset(client, {
        chainId,
        projectId: BigInt(projectId),
      }).catch(() => null)
      if (!ruleset) return null
      const cashOutTaxRate = BigInt(ruleset.metadata.cashOutTaxRate)

      let feeFreeSurplus: bigint | undefined
      if (cashOutTaxRate === 0n) {
        // The same JBMultiTerminal the accounting contexts were read from.
        feeFreeSurplus = await client
          .readContract({
            address: v6Address('JBMultiTerminal', chainId),
            abi: jbMultiTerminalAbi,
            functionName: 'feeFreeSurplusOf',
            args: [BigInt(projectId), context.token],
          })
          .catch(() => undefined)
        if (feeFreeSurplus === undefined) return null
      }

      const quote = await getContextCashOutQuote(client, {
        chainId,
        projectId: BigInt(projectId),
        cashOutCount: ONE_TOKEN,
        context,
        cashOutTaxRate,
        feeFreeSurplus,
      })
      const net = quote.reclaimAmountAfterFee
      if (net === undefined) return null
      const value = Number(formatUnits(net, context.decimals))
      return Number.isFinite(value) && value > 0 ? value : null
    },
    }),
  )
}
