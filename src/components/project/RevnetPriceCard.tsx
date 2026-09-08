'use client'

import {
  JBCoreContracts,
  NATIVE_TOKEN,
  USD_CURRENCY_ID,
  jbContractAddress,
  jbControllerAbi,
  JB_CHAINS,
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
import {
  readLpPositions,
  resolveMarket,
  type MarketResult,
} from '@/components/project/MarketSection'
import type { BsRevnetPriceHistory } from '@/lib/bendystraw'
import {
  cashOutPriceFromTotals,
  netCashOutDisplayValue,
} from '@/lib/cashOut'
import {
  explainCashOutChange,
  type CashOutObservation,
} from '@/lib/cashOutChange'
import { fetchIndexedPoolLiquidityEvents } from '@/lib/lp-positions-queries'
import {
  ammSeriesFrom,
  poolReservesSeriesFrom,
  usdRateOf,
  type PricePoint,
} from '@/lib/price-series'
import { BASE_CURRENCY_USD } from '@bananapus/nana-sdk-core/v6'
import { cachedQuery, immutableQuery } from '@/lib/query-persist'
import { formatCompactTokenAmount, formatTokenAmount } from '@/lib/format'
import { tokenSymbol } from '@/lib/token-symbol'

const PRICE_REFRESH_MS = 15_000

/**
 * Overview price chart for revnets (website/ parity: renderPriceChart) — the
 * issuance price ceiling over time. Fetches the stages client-side (the
 * Overview is a server component), then reads the live omnichain cash-out
 * floor and Uniswap V4 AMM price as current reference points.
 */
/** The rate to convert one historical point with: its own if the indexer recorded one and the
 *  axis is the unit that rate measures, otherwise the live feed. */
function axisRate(
  perPointRates: boolean,
  pointRate: number | undefined,
  live: number,
): number {
  return (perPointRates ? pointRate : undefined) ?? live
}

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

  // The axis unit, straight from the immutable stage data the axis LABEL is
  // built from further down. Both must read the same source or the lines and
  // the label describe different currencies.
  const axisBaseCurrency = all[0]?.metadata.baseCurrency ?? null

  const { data: references, isFetching: referencesFetching } = useQuery(
    cachedQuery({
    queryKey: [
      'revnetPriceReferences',
      chainId,
      projectId,
      chains,
      axisBaseCurrency,
    ],
    enabled: !!publicClient && axisBaseCurrency !== null,
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
          const readRow = async ([rawChainId, rawProjectId]: [
            number,
            number,
          ]) => {
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
          }

          // Local first. `scopeCashOutsToLocalBalances` prices from THIS
          // chain's balance alone, so fanning out to every peer up front let a
          // single unreachable peer null the whole floor — dropping the
          // cash-out line, the floor history and the tax tooltip on a revnet
          // whose own numbers had already resolved.
          const localEntry =
            chains.find(([rawChainId]) => rawChainId === chainId) ?? chains[0]
          if (!localEntry) return null
          const current = await readRow(localEntry)
          const pricedRows = current.scopeLocal
            ? [current]
            : await Promise.all(
                chains.map(entry =>
                  entry === localEntry ? current : readRow(entry),
                ),
              )
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
            // Ambient displays quote what a holder would RECEIVE, matching the confirm
            // modal — the pure helper is a gross contract mirror by design.
            price: netCashOutDisplayValue(
              cashOutPriceFromTotals(totals),
              current.cashOutTaxRate,
            ),
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
      //
      // The axis unit comes from the STAGE data the label is drawn from, never
      // from the floor read: falling back to native(1) when that read failed
      // drew the pool price in accounting units under a USD label. And with no
      // floor there is no known accounting denomination either, so there is no
      // rate to convert with — omit the lines rather than guess.
      const baseCurrency = axisBaseCurrency!
      const accountingCurrency = floor?.currency ?? null
      const rate =
        accountingCurrency === null
          ? null
          : await basePerAccountingToken(publicClient!, {
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
        rateUnavailable: accountingCurrency !== null && rate === null,
        /** The live reads that say what those lines are denominated in failed. */
        scaleUnknown: accountingCurrency === null,
        /** The factor history is converted with, exposed so the series can use it too. */
        rate,
        /** The axis unit. Only a USD axis can use the indexer's per-point USD rate. */
        baseCurrency,
        poolId: market?.status === 'pool' ? market.poolId : null,
        pairDecimals:
          market?.status === 'pool' ? market.pair.decimals : null,
        pool: market?.status === 'pool' ? market : null,
      }
    },
    }),
  )

  // Same key as MarketSection's query so the two share one read of the pool.
  const pool = references?.pool ?? null
  const { data: lp } = useQuery(
    cachedQuery({
      queryKey: [
        'marketLp',
        chainId,
        projectId,
        pool?.poolId ?? null,
        pool ? (pool.sqrtP >> 32n).toString() : null,
      ],
      enabled: !!publicClient && !!pool,
      staleTime: 60_000,
      retry: 0,
      queryFn: () =>
        readLpPositions(
          publicClient!,
          chainId,
          pool as Extract<MarketResult, { status: 'pool' }>,
        ),
    }),
  )
  const ammLiquidity =
    lp?.status === 'positions' && (lp.totalTok > 0n || lp.totalPair > 0n)
      ? {
          token: `${formatCompactTokenAmount(lp.totalTok)} ${data?.projectSymbol || 'tokens'}`,
          pair: `${formatTokenAmount(lp.totalPair, lp.pairDecimals)} ${lp.pairSymbol}`,
        }
      : null

  // Every liquidity change the pool has seen, for the reserve bars: the live
  // read above only knows what the pool holds NOW.
  const { data: liquidityEvents } = useQuery(
    cachedQuery({
      queryKey: ['poolLiquidityEvents', chainId, pool?.poolId ?? null],
      enabled: !!pool,
      staleTime: 60_000,
      retry: 0,
      queryFn: () =>
        fetchIndexedPoolLiquidityEvents({ chainId, poolId: pool!.poolId }),
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

  // Historical points are ACCOUNTING-token denominated, so they need the same factor the
  // reference lines get. `null` means no feed at all — nothing to draw them with.
  const historyRate = references?.rate ?? null
  // The indexer records USD per accounting token at each point's own block, which is the rate
  // that was actually in force there. It is only the AXIS rate when the axis IS USD, so an
  // ETH-denominated ruleset must keep using the live base/accounting feed rather than reading
  // a USD number as if it were ETH. Per-point where available, live rate everywhere else.
  const perPointRates = references?.baseCurrency === BASE_CURRENCY_USD

  const floorHistory = useMemo<PricePoint[]>(() => {
    const decimals = data?.contexts[0]?.decimals
    // The history stands on its own: a revnet whose CURRENT floor is null —
    // surplus at ~0, or a peer read that failed — still has a real recorded
    // series, and dropping it lost the whole chart line. The rate is the only
    // real requirement, and it is null exactly when the denomination is
    // unknown (see the reference query above).
    if (
      historyRate === null ||
      decimals === undefined ||
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
        const value = netCashOutDisplayValue(
          cashOutPriceFromTotals({
            balance: BigInt(moment.balance),
            tokenSupply: BigInt(moment.tokenSupply),
            cashOutTaxRate: tax,
            balanceDecimals: decimals,
          }),
          tax,
        )
        if (!value) return []
        const onAxis = value * axisRate(perPointRates, usdRateOf(moment.accountingTokenUsdRate), historyRate)
        const observation: CashOutObservation = {
          balance: BigInt(moment.balance),
          tokenSupply: BigInt(moment.tokenSupply),
          cashOutTax: tax,
          price: value,
        }
        const reason = explainCashOutChange(previous, observation)
        previous = observation
        return [{ timestamp, value: onAxis, reason }]
      } catch {
        return []
      }
      })
  }, [all, data, history?.moments, historyRate, perPointRates])

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
      historyRate === null
        ? []
        : ammSeriesFrom({
            history,
            chainId,
            poolId: references?.poolId ?? null,
            pairDecimals: references?.pairDecimals ?? null,
          }).map(point => ({ ...point, value: point.value * axisRate(perPointRates, point.rate, historyRate) })),
    [chainId, history, historyRate, perPointRates, references?.pairDecimals, references?.poolId],
  )

  const ammReservesHistory = useMemo(
    () =>
      poolReservesSeriesFrom({
        history,
        chainId,
        poolId: references?.poolId ?? null,
        pairDecimals: references?.pairDecimals ?? null,
        liquidityEvents: liquidityEvents ?? null,
      }),
    [chainId, history, liquidityEvents, references?.pairDecimals, references?.poolId],
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
  const baseCurrency = axisBaseCurrency ?? 1
  const baseSymbol =
    baseCurrency === 1
      ? nativeSymbol
      : baseCurrency === USD_CURRENCY_ID(6)
        ? 'USD'
        : (data?.contextSymbols.find(c => c.currency === baseCurrency)
            ?.symbol ?? nativeSymbol)

  // Caveats that are ALWAYS true of this chart's data go behind the (!). The two notices left
  // inline below say a series is MISSING, which the reader must not have to hover to discover.
  const chartNote =
    [
      references?.converted
        ? `Market and cash-out prices are converted into ${baseSymbol}, this revnet's issuance currency, at the current exchange rate — so earlier points are approximate. The issuance ceiling is natively denominated in ${baseSymbol} and is exact.`
        : null,
      history?.sampled
        ? 'Historical series are shape-preserving samples of the complete indexed history. The latest observation is always included.'
        : null,
    ]
      .filter(Boolean)
      .join(' ') || null

  return (
    <div>
      <PriceChart
        stages={stages}
        symbol={data?.projectSymbol || 'tokens'}
        baseSymbol={baseSymbol}
        floorHistory={floorHistory}
        ammHistory={ammHistory}
        ammReservesHistory={ammReservesHistory}
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
        ammLiquidity={ammLiquidity}
        pairSymbol={pool?.pair.symbol ?? null}
        note={chartNote}
      />
      {references?.rateUnavailable ? (
        <p className="mt-2 text-xs text-grey-600">
          No price feed converts this revnet&apos;s treasury token into {baseSymbol}, so only
          the issuance ceiling is shown.
        </p>
      ) : null}
      {references?.scaleUnknown ? (
        <p className="mt-2 text-xs text-grey-600">
          The live cash-out and market prices couldn&apos;t be read just now, so
          there is no way to tell what unit they are in — only the issuance
          ceiling is shown.
        </p>
      ) : null}

    </div>
  )
}
