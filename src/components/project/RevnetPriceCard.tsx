'use client'

import {
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
  type CashOutTaxPoint,
} from '@/components/project/PriceChart'
import { PriceChartSkeleton } from '@/components/LoadingSkeletons'
import {
  basePerAccountingToken,
  toBaseAxis,
} from '@/lib/base-currency-axis'
import type { ChartStage } from '@/components/project/chartUtils'
import { resolveMarket } from '@/components/project/MarketSection'
import type { BsRevnetPriceHistory } from '@/lib/bendystraw'
import {
  cashOutPriceFromTotals,
} from '@/lib/cashOut'
import {
  explainCashOutChange,
  type CashOutObservation,
} from '@/lib/cashOutChange'
import { ammSeriesFrom, type PricePoint } from '@/lib/price-series'
import { cachedQuery, immutableQuery } from '@/lib/query-persist'
import { tokenSymbol } from '@/lib/token-symbol'

const PRICE_REFRESH_MS = 15_000

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
  const nativeSymbol = 'ETH'

  // A revnet's stage schedule is queued once at deployFor and no revnet actor
  // holds QUEUE_RULESETS, so every stage — past, current and future — is fixed
  // for the project's lifetime. Read it once, ever.
  const { data: allRulesets, isPending: stagesPending } = useQuery(
    immutableQuery({
      queryKey: ['revnetStages', chainId, projectId],
      enabled: !!publicClient,
      retry: 1,
      queryFn: () =>
        getAllRulesets(publicClient!, {
          chainId,
          projectId: BigInt(projectId),
          size: 50n,
        }),
    }),
  )

  const { data, isPending: metaPending } = useQuery(
    cachedQuery({
      queryKey: ['revnetPriceMeta', chainId, projectId],
      enabled: !!publicClient,
      staleTime: 60_000,
      retry: 1,
      queryFn: async () => {
      const args = { chainId, projectId: BigInt(projectId) }
      const [contexts, projectSymbol] = await Promise.all([
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
      return { contexts, contextSymbols, projectSymbol }
      },
    }),
  )

  const all = useMemo(() => allRulesets ?? [], [allRulesets])
  const isPending = stagesPending || metaPending

  const { data: references, isFetching: referencesFetching } = useQuery(
    cachedQuery({
    queryKey: ['revnetPriceReferences', chainId, projectId, chains],
    enabled: !!publicClient,
    staleTime: 60_000,
    refetchInterval: PRICE_REFRESH_MS,
    refetchOnWindowFocus: true,
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
                  ? Promise.resolve('ETH')
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
                /** Accounting-context currency, for the base-currency axis conversion. */
                currency: Number(context.currency),
                baseCurrency: Number(currentRuleset.metadata.baseCurrency),
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

          const totals = {
            balance: pricedRows.reduce((sum, row) => sum + row.balance, 0n),
            tokenSupply: pricedRows.reduce(
              (sum, row) => sum + row.supply,
              0n,
            ),
            cashOutTaxRate: current.cashOutTaxRate,
            balanceDecimals: current.decimals,
          }
          return {
            price: cashOutPriceFromTotals(totals),
            cashOutTaxRate: current.cashOutTaxRate,
            currency: current.currency,
            baseCurrency: current.baseCurrency,
          }
        })().catch(error => {
          if (process.env.NODE_ENV !== 'production') {
            console.warn('Unable to resolve omnichain cash-out price', error)
          }
          return null
        }),
      ])

      // The chart's axis is the ruleset's BASE currency, which the issuance ladder is
      // already denominated in. The pool price and the cash-out floor are denominated in
      // the ACCOUNTING token, so they have to be converted onto it — otherwise two
      // different units share one axis under a single base-currency label.
      // See lib/base-currency-axis.ts. Same-currency projects resolve to a rate of 1
      // without an RPC call, so the common case is unaffected.
      const baseCurrency = floor?.baseCurrency ?? 1
      const accountingCurrency = floor?.currency ?? baseCurrency
      const rate = await basePerAccountingToken(publicClient!, {
        chainId,
        projectId: BigInt(projectId),
        baseCurrency,
        accountingCurrency,
      })

      return {
        floor: toBaseAxis(floor?.price ?? null, rate),
        cashOutTaxRate: floor?.cashOutTaxRate,
        amm: toBaseAxis(
          market?.status === 'pool' ? market.price : null,
          rate,
        ),
        /** Converted from the accounting token rather than natively on-axis. */
        converted: rate !== null && rate !== 1,
        /** No feed, so the accounting-denominated lines are omitted. */
        rateUnavailable: rate === null,
        poolId: market?.status === 'pool' ? market.poolId : null,
        pairDecimals:
          market?.status === 'pool' ? market.pair.decimals : null,
      }
    },
    }),
  )

  const { data: history } = useQuery(
    cachedQuery({
    queryKey: ['revnetPriceHistory', suckerGroupId],
    enabled: !!suckerGroupId,
    staleTime: 30_000,
    refetchInterval: PRICE_REFRESH_MS,
    refetchOnWindowFocus: true,
    retry: 1,
    queryFn: async (): Promise<BsRevnetPriceHistory> => {
      // chainId is an endpoint-routing hint (testnet groups live on the
      // testnet indexer); it never filters the group.
      const response = await fetch(
        `/api/price-history?suckerGroupId=${encodeURIComponent(suckerGroupId!)}&chainId=${chainId}`,
      )
      if (!response.ok) throw new Error('Price history is unavailable.')
      return response.json() as Promise<BsRevnetPriceHistory>
    },
    }),
  )

  // Historical points are ACCOUNTING-token denominated. When the axis (the ruleset's base
  // currency) is a different unit, each point would need the rate in force at ITS OWN
  // timestamp — the live feed only prices now, and reusing it would restate the past. Until
  // per-timestamp rates are wired through /api/price-history, the honest move is to omit the
  // historical series rather than draw it in the wrong unit; the live converted reference
  // lines still show. Untouched for same-currency projects, where the rate is exactly 1.
  const historyOnAxis = references ? !references.converted && !references.rateUnavailable : true

  const floorHistory = useMemo<PricePoint[]>(() => {
    const decimals = data?.contexts[0]?.decimals
    if (
      !historyOnAxis ||
      decimals === undefined ||
      !references?.floor ||
      !history?.moments.length ||
      !all.length
    ) {
      return []
    }

    const taxSchedule = [...all].sort(
      (a, b) => a.ruleset.start - b.ruleset.start,
    )
    let previous: CashOutObservation | undefined
    return [...history.moments]
      .sort((a, b) => Number(a.timestamp) - Number(b.timestamp))
      .flatMap(moment => {
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
        if (!value) return []
        const observation: CashOutObservation = {
          balance: BigInt(moment.balance),
          tokenSupply: BigInt(moment.tokenSupply),
          cashOutTax: tax,
          price: value,
        }
        const reason = explainCashOutChange(previous, observation)
        previous = observation
        return [{ timestamp, value, reason }]
      } catch {
        return []
      }
      })
  }, [all, data, history?.moments, historyOnAxis, references?.floor])

  const cashOutTaxHistory = useMemo<CashOutTaxPoint[]>(() => {
    const byTimestamp = new Map<number, number>()
    for (const ruleset of all) {
      byTimestamp.set(
        ruleset.ruleset.start,
        ruleset.metadata.cashOutTaxRate,
      )
    }
    return [...byTimestamp].map(([timestamp, cashOutTaxRate]) => ({
      timestamp,
      cashOutTaxRate,
    }))
  }, [all])

  const ammHistory = useMemo<PricePoint[]>(
    () =>
      historyOnAxis
        ? ammSeriesFrom({
            history,
            chainId,
            poolId: references?.poolId ?? null,
            pairDecimals: references?.pairDecimals ?? null,
          })
        : [],
    [chainId, history, historyOnAxis, references?.pairDecimals, references?.poolId],
  )

  const stages: ChartStage[] = all.map(s => ({
    start: s.ruleset.start,
    duration: s.ruleset.duration,
    weight: s.ruleset.weight,
    weightCutPercent: s.ruleset.weightCutPercent,
  }))

  // Stages restore from disk, so a return visit paints the chart immediately
  // and only the live overlays are still resolving.
  if (isPending && all.length === 0) return <PriceChartSkeleton />

  if (stages.length === 0 || stages.every(s => s.weight === 0n)) return null

  // The base currency: 1 → native, 2 → USD, else token-keyed → that token's
  // resolved symbol (a DAI/USDC-based revnet).
  const baseCurrency = all[0]?.metadata.baseCurrency ?? 1
  const baseSymbol =
    baseCurrency === 1
      ? nativeSymbol
      : baseCurrency === USD_CURRENCY_ID(6)
        ? 'USD'
        : (data?.contextSymbols.find(c => c.currency === baseCurrency)
            ?.symbol ?? nativeSymbol)

  return (
    <div>
      <PriceChart
        stages={stages}
        symbol={data?.projectSymbol || 'tokens'}
        baseSymbol={baseSymbol}
        floorHistory={floorHistory}
        ammHistory={ammHistory}
        cashOutTaxHistory={cashOutTaxHistory}
        referencesPending={referencesFetching && !!references}
        floorPrice={
          references?.floor
            ? {
                value: references.floor,
                label: 'Cash out price',
                cashOutTaxRate: references.cashOutTaxRate,
              }
            : null
        }
        ammPrice={
          references?.amm ? { value: references.amm, label: 'AMM price' } : null
        }
      />
      {references?.converted ? (
        <p className="mt-2 text-xs text-grey-500">
          Market and cash-out prices are converted into {baseSymbol}, this revnet&apos;s
          issuance currency. History is shown only for the issuance ceiling, which is
          natively denominated in it.
        </p>
      ) : null}
      {references?.rateUnavailable ? (
        <p className="mt-2 text-xs text-grey-500">
          No price feed converts this revnet&apos;s treasury token into {baseSymbol}, so only
          the issuance ceiling is shown.
        </p>
      ) : null}
      {history?.sampled ? (
        <p className="mt-2 text-xs text-grey-500">
          Historical series are shape-preserving samples of the complete
          indexed history. The latest observation is always included.
        </p>
      ) : null}
    </div>
  )
}
