'use client'

import {
  JB_CHAINS,
  JBCoreContracts,
  NATIVE_TOKEN,
  USD_CURRENCY_ID,
  jbContractAddress,
  jbControllerAbi,
  jbDirectoryAbi,
  jbTerminalStoreAbi,
  jbTokensAbi,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import {
  getAccountingContexts,
  getAllRulesets,
  getCurrentRuleset,
} from '@bananapus/nana-sdk-core/v6'
import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import {
  erc20Abi,
  zeroAddress,
  type Address,
  type PublicClient,
} from 'viem'
import { getPublicClient } from 'wagmi/actions'
import { useConfig, usePublicClient } from 'wagmi'
import {
  PriceChart,
  type PricePoint,
} from '@/components/project/PriceChart'
import { PriceChartSkeleton } from '@/components/LoadingSkeletons'
import type { ChartStage } from '@/components/project/chartUtils'
import { resolveMarket } from '@/components/project/MarketSection'
import type { BsRevnetPriceHistory } from '@/lib/bendystraw'
import { cashOutPriceFromTotals } from '@/lib/cashOut'
import { tokenSymbol } from '@/lib/token-symbol'
import { poolPriceFromSqrt } from '@/lib/uniswap-v4'

/**
 * Overview price chart for revnets (website/ parity: renderPriceChart) — the
 * issuance price ceiling over time. Fetches the stages client-side (the
 * Overview is a server component), then reads the live omnichain cash-out
 * floor and Uniswap V4 AMM price as current reference points.
 */
export function RevnetPriceCard({
  chainId,
  projectId,
  chains,
  suckerGroupId,
}: {
  chainId: JBChainId
  projectId: number
  chains: [number, number][]
  suckerGroupId: string | null
}) {
  const publicClient = usePublicClient({ chainId }) as PublicClient | undefined
  const config = useConfig()
  const nativeSymbol = JB_CHAINS[chainId]?.nativeTokenSymbol ?? 'ETH'

  const { data, isPending } = useQuery({
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
          symbol: await tokenSymbol(publicClient!, ctx.token, { nativeSymbol }),
        })),
      )
      return { all, contexts, contextSymbols, projectSymbol }
    },
  })

  const { data: references } = useQuery({
    queryKey: ['revnetPriceReferences', chainId, projectId, chains],
    enabled: !!publicClient,
    staleTime: 60_000,
    retry: 1,
    queryFn: async () => {
      const [market, floor] = await Promise.all([
        resolveMarket(publicClient!, chainId, projectId, nativeSymbol).catch(
          () => null,
        ),
        (async () => {
          const rows = await Promise.all(
            chains.map(async ([rawChainId, rawProjectId]) => {
              const rowChainId = rawChainId as JBChainId
              const client = getPublicClient(config, {
                chainId: rowChainId,
              }) as PublicClient | undefined
              if (!client) throw new Error(`Unsupported chain ${rawChainId}`)

              const directory = jbContractAddress['6'][
                JBCoreContracts.JBDirectory
              ][rowChainId] as Address | undefined
              const store = jbContractAddress['6'][
                JBCoreContracts.JBTerminalStore
              ][rowChainId] as Address | undefined
              if (!directory || !store) {
                throw new Error(`V6 contracts unavailable on ${rawChainId}`)
              }

              const pid = BigInt(rawProjectId)
              const [contexts, currentRuleset, controller] = await Promise.all([
                getAccountingContexts(client, {
                  chainId: rowChainId,
                  projectId: pid,
                }),
                getCurrentRuleset(client, {
                  chainId: rowChainId,
                  projectId: pid,
                }),
                client.readContract({
                  address: directory,
                  abi: jbDirectoryAbi,
                  functionName: 'controllerOf',
                  args: [pid],
                }),
              ])
              const context = contexts[0]
              if (!context) {
                throw new Error(`No accounting context on ${rawChainId}`)
              }

              const [supply, balance, contextSymbol] = await Promise.all([
                client.readContract({
                  address: controller,
                  abi: jbControllerAbi,
                  functionName: 'totalTokenSupplyWithReservedTokensOf',
                  args: [pid],
                }),
                client.readContract({
                  address: store,
                  abi: jbTerminalStoreAbi,
                  functionName: 'currentSurplusOf',
                  args: [
                    pid,
                    [],
                    [],
                    BigInt(context.decimals),
                    BigInt(context.currency),
                  ],
                }),
                context.token.toLowerCase() === NATIVE_TOKEN.toLowerCase()
                  ? Promise.resolve(
                      JB_CHAINS[rowChainId]?.nativeTokenSymbol ?? 'ETH',
                    )
                  : client.readContract({
                      address: context.token,
                      abi: erc20Abi,
                      functionName: 'symbol',
                    }),
              ])

              return {
                chainId: rowChainId,
                supply,
                balance,
                decimals: context.decimals,
                contextSymbol,
                isNative:
                  context.token.toLowerCase() ===
                  NATIVE_TOKEN.toLowerCase(),
                cashOutTaxRate: currentRuleset.metadata.cashOutTaxRate,
                scopeLocal:
                  currentRuleset.metadata.scopeCashOutsToLocalBalances,
              }
            }),
          )

          const current = rows.find(row => row.chainId === chainId) ?? rows[0]
          if (!current) return null
          const pricedRows = current.scopeLocal ? [current] : rows
          const homogeneous = pricedRows.every(
            row =>
              row.decimals === current.decimals &&
              row.contextSymbol === current.contextSymbol &&
              row.isNative === current.isNative &&
              row.cashOutTaxRate === current.cashOutTaxRate,
          )
          if (!homogeneous) return null

          return cashOutPriceFromTotals({
            balance: pricedRows.reduce((sum, row) => sum + row.balance, 0n),
            tokenSupply: pricedRows.reduce(
              (sum, row) => sum + row.supply,
              0n,
            ),
            cashOutTaxRate: current.cashOutTaxRate,
            balanceDecimals: current.decimals,
          })
        })().catch(error => {
          if (process.env.NODE_ENV !== 'production') {
            console.warn('Unable to resolve omnichain cash-out price', error)
          }
          return null
        }),
      ])

      return {
        floor,
        amm: market?.status === 'pool' ? market.price : null,
        poolId: market?.status === 'pool' ? market.poolId : null,
        pairDecimals:
          market?.status === 'pool' ? market.pair.decimals : null,
      }
    },
  })

  const { data: history } = useQuery({
    queryKey: ['revnetPriceHistory', suckerGroupId],
    enabled: !!suckerGroupId,
    staleTime: 30_000,
    retry: 1,
    queryFn: async (): Promise<BsRevnetPriceHistory> => {
      const response = await fetch(
        `/api/price-history?suckerGroupId=${encodeURIComponent(suckerGroupId!)}`,
      )
      if (!response.ok) throw new Error('Price history is unavailable.')
      return response.json() as Promise<BsRevnetPriceHistory>
    },
  })

  const floorHistory = useMemo<PricePoint[]>(() => {
    const decimals = data?.contexts[0]?.decimals
    if (
      decimals === undefined ||
      !references?.floor ||
      !history?.moments.length ||
      !data?.all.length
    ) {
      return []
    }

    const taxSchedule = [...data.all].sort(
      (a, b) => a.ruleset.start - b.ruleset.start,
    )
    return history.moments.flatMap(moment => {
      const timestamp = Number(moment.timestamp)
      let tax = taxSchedule[0]?.metadata.cashOutTaxRate ?? 0
      for (const ruleset of taxSchedule) {
        if (ruleset.ruleset.start > timestamp) break
        tax = ruleset.metadata.cashOutTaxRate
      }
      try {
        const value = cashOutPriceFromTotals({
          balance: BigInt(moment.balance),
          tokenSupply: BigInt(moment.tokenSupply),
          cashOutTaxRate: tax,
          balanceDecimals: decimals,
        })
        return value ? [{ timestamp, value }] : []
      } catch {
        return []
      }
    })
  }, [data, history?.moments, references?.floor])

  const ammHistory = useMemo<PricePoint[]>(() => {
    if (
      !references?.poolId ||
      references.pairDecimals === null ||
      (!history?.swaps.length && !history?.pools?.length)
    ) {
      return []
    }

    const poolId = references.poolId.toLowerCase()
    const pairScale = 10 ** references.pairDecimals
    const spotPrice = (
      sqrtPriceX96: string | null,
      projectTokenIsCurrency0: boolean | null,
    ) => {
      if (!sqrtPriceX96 || projectTokenIsCurrency0 === null) return null
      try {
        return poolPriceFromSqrt(
          BigInt(sqrtPriceX96),
          !projectTokenIsCurrency0,
          references.pairDecimals!,
        )
      }
      catch {
        return null
      }
    }
    const initial = (history.pools ?? []).flatMap(pool => {
      if (
        pool.chainId !== chainId ||
        pool.poolId.toLowerCase() !== poolId
      ) {
        return []
      }
      const value = spotPrice(
        pool.initialSqrtPriceX96,
        pool.projectTokenIsCurrency0,
      )
      return value ? [{ timestamp: Number(pool.timestamp), value }] : []
    })
    const swaps = history.swaps.flatMap(swap => {
      if (
        swap.chainId !== chainId ||
        swap.direction === 'mint' ||
        swap.poolId.toLowerCase() !== poolId
      ) {
        return []
      }
      try {
        const spot = spotPrice(
          swap.sqrtPriceX96,
          swap.projectTokenIsCurrency0,
        )
        if (spot) return [{ timestamp: Number(swap.timestamp), value: spot }]

        // Compatibility for pre-sqrtPriceX96 rows while Bendystraw reindexes.
        const terminalAmount =
          Number(BigInt(swap.terminalTokenAmount)) / pairScale
        const projectAmount = Number(BigInt(swap.projectTokenAmount)) / 1e18
        const value = terminalAmount / projectAmount
        return Number.isFinite(value) && value > 0
          ? [{ timestamp: Number(swap.timestamp), value }]
          : []
      } catch {
        return []
      }
    })
    return [...initial, ...swaps].sort((a, b) => a.timestamp - b.timestamp)
  }, [
    chainId,
    history?.pools,
    history?.swaps,
    references?.pairDecimals,
    references?.poolId,
  ])

  const stages: ChartStage[] = (data?.all ?? []).map(s => ({
    start: s.ruleset.start,
    duration: s.ruleset.duration,
    weight: s.ruleset.weight,
    weightCutPercent: s.ruleset.weightCutPercent,
  }))

  if (isPending) return <PriceChartSkeleton />

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
    <PriceChart
      stages={stages}
      symbol={data?.projectSymbol || 'tokens'}
      baseSymbol={baseSymbol}
      floorHistory={floorHistory}
      ammHistory={ammHistory}
      floorPrice={
        references?.floor
          ? { value: references.floor, label: 'Cash out price' }
          : null
      }
      ammPrice={
        references?.amm ? { value: references.amm, label: 'AMM price' } : null
      }
    />
  )
}
