'use client'

import {
  JB_CHAINS,
  JBCoreContracts,
  USD_CURRENCY_ID,
  jbContractAddress,
  jbTokensAbi,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import {
  getAccountingContexts,
  getAllRulesets,
} from '@bananapus/nana-sdk-core/v6'
import { useQuery } from '@tanstack/react-query'
import { erc20Abi, zeroAddress, type PublicClient } from 'viem'
import { usePublicClient } from 'wagmi'
import { PriceChart } from '@/components/project/PriceChart'
import type { ChartStage } from '@/components/project/chartUtils'

const NATIVE = '0x000000000000000000000000000000000000eeee'

/**
 * Overview price chart for revnets (website/ parity: renderPriceChart) — the
 * issuance price ceiling over time. Fetches the stages client-side (the
 * Overview is a server component). Cash-out floor + AMM reference lines wire
 * in with the Market data later; the ceiling is the chart's core.
 */
export function RevnetPriceCard({
  chainId,
  projectId,
}: {
  chainId: JBChainId
  projectId: number
}) {
  const publicClient = usePublicClient({ chainId }) as PublicClient | undefined
  const nativeSymbol = JB_CHAINS[chainId]?.nativeTokenSymbol ?? 'ETH'

  const { data } = useQuery({
    queryKey: ['revnetPriceCard', chainId, projectId],
    enabled: !!publicClient,
    staleTime: 60_000,
    retry: 1,
    queryFn: async () => {
      const args = { chainId, projectId: BigInt(projectId) }
      const [all, contexts, projectSymbol] = await Promise.all([
        getAllRulesets(publicClient!, { ...args, size: 50n }),
        getAccountingContexts(publicClient!, args).catch(() => [] as const),
        (async () => {
          const token = (await publicClient!.readContract({
            abi: jbTokensAbi,
            address: jbContractAddress['6'][JBCoreContracts.JBTokens][chainId],
            functionName: 'tokenOf',
            args: [BigInt(projectId)],
          })) as `0x${string}`
          if (!token || token === zeroAddress) return null
          return (await publicClient!.readContract({
            address: token,
            abi: erc20Abi,
            functionName: 'symbol',
          })) as string
        })().catch(() => null),
      ])
      // Resolve token-keyed base currencies (uint32(uint160(token))) to their
      // real symbols so a DAI/USDC-based revnet isn't mislabeled.
      const contextSymbols = await Promise.all(
        contexts.map(async ctx => ({
          currency: ctx.currency,
          symbol:
            ctx.token.toLowerCase() === NATIVE
              ? nativeSymbol
              : await publicClient!
                  .readContract({
                    address: ctx.token,
                    abi: erc20Abi,
                    functionName: 'symbol',
                  })
                  .catch(() => null),
        })),
      )
      return { all, contexts, contextSymbols, projectSymbol }
    },
  })

  const stages: ChartStage[] = (data?.all ?? []).map(s => ({
    start: s.ruleset.start,
    duration: s.ruleset.duration,
    weight: s.ruleset.weight,
    weightCutPercent: s.ruleset.weightCutPercent,
  }))

  if (stages.length === 0 || stages.every(s => s.weight === 0n)) return null

  // The base currency: 1 → native, 2 → USD, else token-keyed → that token's
  // resolved symbol (a DAI/USDC-based revnet).
  const baseCurrency = data?.all?.[0]?.metadata.baseCurrency ?? 1
  const baseSymbol =
    baseCurrency === 1
      ? nativeSymbol
      : baseCurrency === USD_CURRENCY_ID(6)
        ? 'USD'
        : (data?.contextSymbols.find(c => c.currency === baseCurrency)
            ?.symbol ?? nativeSymbol)

  return (
    <div className="card p-5">
      <span className="field-label">Token price over time</span>
      <p className="mt-1 text-xs leading-relaxed text-smoke-700">
        Issuance sets the ceiling price — it rises on schedule as issuance
        cuts, so earlier supporters get more tokens per {baseSymbol}.
      </p>
      <div className="mt-3">
        <PriceChart
          stages={stages}
          symbol={data?.projectSymbol || 'tokens'}
          baseSymbol={baseSymbol}
        />
      </div>
    </div>
  )
}
