'use client'

import {
  JB_CHAINS,
  JBCoreContracts,
  NATIVE_TOKEN,
  SPLITS_TOTAL_PERCENT,
  USD_CURRENCY_ID,
  jbContractAddress,
  jbFundAccessLimitsAbi,
  jbMultiTerminalAbi,
  jbPricesAbi,
  jbProjectsAbi,
  jbSplitsAbi,
  jbTerminalStoreAbi,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import {
  BASE_CURRENCY_ETH,
  BASE_CURRENCY_USD,
  getAccountingContexts,
  getCurrentRuleset,
  payoutSplitGroupId,
  type JBAccountingContext,
} from '@bananapus/nana-sdk-core/v6'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import {
  formatUnits,
  parseUnits,
  type Abi,
  type Address,
  type PublicClient,
} from 'viem'
import { useConfig, usePublicClient, useReadContract } from 'wagmi'
import { FundsTabSkeleton } from '@/components/LoadingSkeletons'
import { getPublicClient } from 'wagmi/actions'
import { ChainIcon } from '@/components/ChainIcon'
import { SplitRecipient, type Split } from '@/components/project/SplitRecipient'
import { TxError } from '@/components/ui/TxError'
import { txPhaseLabel, useSafeTx } from '@/hooks/useSafeTx'
import { useWallet } from '@/hooks/useWallet'
import { FlowError, shortError } from '@/lib/errors'
import {
  USD_SCALE,
  fmtPct,
  formatTokenAmount,
  formatUsd18,
} from '@/lib/format'
import { tokenSymbol } from '@/lib/token-symbol'
import { chainName } from '@/lib/urn'

/** A payout limit or surplus allowance entry with its live usage. */
type LimitLine = {
  /** The configured limit, in the currency's fixed-point terms. */
  amount: bigint
  /** The currency the limit is denominated in. */
  currency: number
  /** How much of the limit has been used this cycle/ruleset. */
  used: bigint
  /** amount - used, floored at zero. */
  remaining: bigint
}

/** Amounts in a currency use the token's decimals when the currency is the
 *  token's own accounting-context currency, and 18-dec fixed point for the
 *  standard ETH/USD base currencies. */
function currencyDecimals(currency: number, ctx: JBAccountingContext): number {
  return currency === ctx.currency ? ctx.decimals : 18
}

function currencyLabel(
  currency: number,
  ctx: JBAccountingContext,
  tokenSymbol: string,
): string {
  if (currency === ctx.currency) return tokenSymbol
  if (currency === BASE_CURRENCY_ETH) return 'ETH'
  if (currency === BASE_CURRENCY_USD) return 'USD'
  return `currency #${currency}`
}

function formatPercent(percent: number): string {
  return fmtPct((percent / SPLITS_TOTAL_PERCENT) * 100)
}

function bigintMin(a: bigint, b: bigint): bigint {
  return a < b ? a : b
}

type FundsKindDescriptor = {
  key: string
  homeToken: Address
  native: boolean
  symbol: string
  decimals: number
}

type ChainFundsSnapshot = {
  chainId: JBChainId
  projectId: number
  ctx: JBAccountingContext
  tokenSymbol: string
  balance: bigint
  usd: bigint | null
  surplus: bigint
  payoutLines: LimitLine[]
  allowanceLines: LimitLine[]
  splits: readonly Split[]
  rulesetId: number
  rulesetCycleNumber: number
  ownerMustSendPayouts: boolean
  terminal: Address
  store: Address
  limitsAddress: Address
  etherscanHost?: string
}

type ChainFundsResult = {
  chainId: JBChainId
  projectId: number
  verified: boolean
  snapshot: ChainFundsSnapshot | null
}

type FundsKind = FundsKindDescriptor & {
  snapshots: ChainFundsResult[]
  totalBalance: bigint
  totalUsd: bigint
  readsVerified: boolean
  fullyPriced: boolean
}

async function readChainFunds(
  config: ReturnType<typeof useConfig>,
  pair: readonly [number, number],
  descriptor: FundsKindDescriptor,
  homeChainId: JBChainId,
): Promise<ChainFundsResult> {
  const chainId = pair[0] as JBChainId
  const projectId = pair[1]
  const client = getPublicClient(config, { chainId }) as
    | PublicClient
    | undefined
  const terminal = jbContractAddress['6'][JBCoreContracts.JBMultiTerminal][
    chainId
  ] as Address | undefined
  const store = jbContractAddress['6'][JBCoreContracts.JBTerminalStore][
    chainId
  ] as Address | undefined
  const limitsAddress = jbContractAddress['6'][
    JBCoreContracts.JBFundAccessLimits
  ][chainId] as Address | undefined
  const splitsAddress = jbContractAddress['6'][JBCoreContracts.JBSplits][
    chainId
  ] as Address | undefined
  const pricesAddress = jbContractAddress['6'][JBCoreContracts.JBPrices][
    chainId
  ] as Address | undefined

  if (!client || !terminal || !store || !limitsAddress || !splitsAddress) {
    return { chainId, projectId, verified: false, snapshot: null }
  }

  try {
    const pid = BigInt(projectId)
    const [contexts, current] = await Promise.all([
      getAccountingContexts(client, { chainId, projectId: pid }),
      getCurrentRuleset(client, { chainId, projectId: pid }),
    ])
    const candidates = await Promise.all(
      contexts.map(async ctx => ({
        ctx,
        symbol: await tokenSymbol(client, ctx.token, { chainId }),
      })),
    )
    const match = candidates.find(({ ctx, symbol }) => {
      const native = ctx.token.toLowerCase() === NATIVE_TOKEN.toLowerCase()
      if (chainId === homeChainId && ctx.token === descriptor.homeToken) return true
      return descriptor.native
        ? native
        : !native &&
            ctx.decimals === descriptor.decimals &&
            symbol.toLowerCase() === descriptor.symbol.toLowerCase()
    })
    if (!match) return { chainId, projectId, verified: true, snapshot: null }

    const { ctx, symbol } = match
    const rulesetId = current.ruleset.id
    const cycleNumber = current.ruleset.cycleNumber
    const [balance, payoutLimits, surplusAllowances, surplus, splits] =
      await Promise.all([
        client.readContract({
          address: store,
          abi: jbTerminalStoreAbi,
          functionName: 'balanceOf',
          args: [terminal, pid, ctx.token],
        }),
        client.readContract({
          address: limitsAddress,
          abi: jbFundAccessLimitsAbi,
          functionName: 'payoutLimitsOf',
          args: [pid, BigInt(rulesetId), terminal, ctx.token],
        }),
        client.readContract({
          address: limitsAddress,
          abi: jbFundAccessLimitsAbi,
          functionName: 'surplusAllowancesOf',
          args: [pid, BigInt(rulesetId), terminal, ctx.token],
        }),
        client
          .readContract({
            address: store,
            abi: jbTerminalStoreAbi,
            functionName: 'currentSurplusOf',
            args: [
              pid,
              [terminal],
              [ctx.token],
              BigInt(ctx.decimals),
              BigInt(ctx.currency),
            ],
          })
          .catch(() => 0n),
        client
          .readContract({
            address: splitsAddress,
            abi: jbSplitsAbi,
            functionName: 'splitsOf',
            args: [pid, BigInt(rulesetId), payoutSplitGroupId(ctx.token)],
          })
          .catch(() => [] as readonly Split[]),
      ])

    const payoutUsage = await Promise.all(
      payoutLimits.map(limit =>
        client.readContract({
          address: store,
          abi: jbTerminalStoreAbi,
          functionName: 'usedPayoutLimitOf',
          args: [
            terminal,
            pid,
            ctx.token,
            BigInt(cycleNumber),
            BigInt(limit.currency),
          ],
        }),
      ),
    )
    const allowanceUsage = await Promise.all(
      surplusAllowances.map(allowance =>
        client.readContract({
          address: store,
          abi: jbTerminalStoreAbi,
          functionName: 'usedSurplusAllowanceOf',
          args: [
            terminal,
            pid,
            ctx.token,
            BigInt(rulesetId),
            BigInt(allowance.currency),
          ],
        }),
      ),
    )
    const payoutLines = payoutLimits.map((limit, index) => {
      const used = payoutUsage[index] ?? 0n
      return {
        amount: limit.amount,
        currency: limit.currency,
        used,
        remaining: limit.amount > used ? limit.amount - used : 0n,
      }
    })
    const allowanceLines = surplusAllowances.map((allowance, index) => {
      const used = allowanceUsage[index] ?? 0n
      return {
        amount: allowance.amount,
        currency: allowance.currency,
        used,
        remaining: allowance.amount > used ? allowance.amount - used : 0n,
      }
    })
    const usdPrice = pricesAddress
      ? await client
          .readContract({
            address: pricesAddress,
            abi: jbPricesAbi,
            functionName: 'pricePerUnitOf',
            args: [
              pid,
              BigInt(USD_CURRENCY_ID(6)),
              BigInt(ctx.currency),
              18n,
            ],
          })
          .catch(() => null)
      : null
    // JBPrices is the source of truth. USDC can still be valued safely at its
    // accounting unit when a price lookup is temporarily unavailable. Never
    // interpret a zero oracle response as a real $0 quote for a held token.
    const resolvedUsdPrice =
      usdPrice != null && usdPrice > 0n
        ? usdPrice
        : symbol.toUpperCase() === 'USDC' && ctx.decimals === 6
          ? USD_SCALE
          : null
    const usd =
      balance === 0n
        ? 0n
        : resolvedUsdPrice == null
          ? null
          : (balance * resolvedUsdPrice) / 10n ** BigInt(ctx.decimals)

    return {
      chainId,
      projectId,
      verified: true,
      snapshot: {
        chainId,
        projectId,
        ctx,
        tokenSymbol: symbol,
        balance,
        usd,
        surplus,
        payoutLines,
        allowanceLines,
        splits,
        rulesetId,
        rulesetCycleNumber: cycleNumber,
        ownerMustSendPayouts: current.metadata.ownerMustSendPayouts,
        terminal,
        store,
        limitsAddress,
        etherscanHost: JB_CHAINS[chainId]?.etherscanHostname,
      },
    }
  } catch {
    return { chainId, projectId, verified: false, snapshot: null }
  }
}

function remainingLabel(
  lines: LimitLine[],
  ctx: JBAccountingContext,
  tokenSymbol: string,
  balance?: bigint,
): string {
  const configured = lines.filter(line => line.amount > 0n)
  if (!configured.length) return 'None'
  return configured
    .map(line => {
      const remaining =
        balance !== undefined && line.currency === ctx.currency
          ? bigintMin(line.remaining, balance)
          : line.remaining
      return `${formatTokenAmount(
        remaining,
        currencyDecimals(line.currency, ctx),
      )} ${currencyLabel(line.currency, ctx, tokenSymbol)}`
    })
    .join(' + ')
}

/**
 * A single, token-tabbed Funds surface matching website/: the selected
 * accounting token is aggregated across every deployment, then broken down
 * by chain. Writes remain scoped to the project's home deployment.
 */
export function FundsTab({
  chainId,
  projectId,
  chains,
}: {
  chainId: JBChainId
  projectId: number
  chains: readonly [number, number][]
}) {
  const config = useConfig()
  const { address } = useWallet()
  const [selectedKey, setSelectedKey] = useState('')
  const chainPairs = useMemo<readonly [number, number][]>(() => {
    const homePair: [number, number] = [chainId, projectId]
    const supplied: readonly [number, number][] = chains.length
      ? chains
      : [homePair]
    return supplied.some(([id, pid]) => id === chainId && pid === projectId)
      ? supplied
      : [homePair, ...supplied]
  }, [chains, chainId, projectId])

  const {
    data: matrix,
    isLoading,
    refetch,
  } = useQuery({
    queryKey: ['fundsMatrix', chainPairs, chainId, projectId],
    staleTime: 30_000,
    retry: 1,
    queryFn: async () => {
      const homeClient = getPublicClient(config, { chainId }) as
        | PublicClient
        | undefined
      if (!homeClient) throw new Error('No public client')
      const homeContexts = await getAccountingContexts(homeClient, {
        chainId,
        projectId: BigInt(projectId),
      })
      const descriptors = await Promise.all(
        homeContexts.map(async ctx => {
          const symbol = await tokenSymbol(homeClient, ctx.token, { chainId })
          const native = ctx.token.toLowerCase() === NATIVE_TOKEN.toLowerCase()
          return {
            key: native ? 'native' : `${symbol.toLowerCase()}:${ctx.decimals}`,
            homeToken: ctx.token,
            native,
            symbol,
            decimals: ctx.decimals,
          } satisfies FundsKindDescriptor
        }),
      )
      const kinds: FundsKind[] = await Promise.all(
        descriptors.map(async descriptor => {
          const snapshots = await Promise.all(
            chainPairs.map(pair =>
              readChainFunds(config, pair, descriptor, chainId),
            ),
          )
          const present = snapshots.flatMap(result =>
            result.snapshot ? [result.snapshot] : [],
          )
          const readsVerified = snapshots.every(result => result.verified)
          return {
            ...descriptor,
            snapshots,
            totalBalance: present.reduce(
              (sum, snapshot) => sum + snapshot.balance,
              0n,
            ),
            totalUsd: present.reduce(
              (sum, snapshot) => sum + (snapshot.usd ?? 0n),
              0n,
            ),
            readsVerified,
            fullyPriced:
              readsVerified &&
              present.every(
                snapshot => snapshot.balance === 0n || snapshot.usd != null,
              ),
          }
        }),
      )
      return kinds
    },
  })

  useEffect(() => {
    if (!matrix?.length) return
    if (!matrix.some(kind => kind.key === selectedKey)) {
      setSelectedKey(matrix[0].key)
    }
  }, [matrix, selectedKey])

  const { data: owner } = useReadContract({
    abi: jbProjectsAbi,
    address: jbContractAddress['6'][JBCoreContracts.JBProjects][chainId],
    functionName: 'ownerOf',
    args: [BigInt(projectId)],
    chainId,
    query: { staleTime: 60_000 },
  })
  const isOwner =
    !!address && !!owner && owner.toLowerCase() === address.toLowerCase()

  if (isLoading) {
    return <FundsTabSkeleton />
  }
  if (!matrix?.length) {
    return (
      <div className="card p-6">
        <span className="field-label">Funds</span>
        <p className="mt-2 text-sm text-smoke-700">
          This project doesn&apos;t have an accounting token yet.
        </p>
      </div>
    )
  }

  const selected =
    matrix.find(kind => kind.key === selectedKey) ?? matrix[0]
  const home = selected.snapshots.find(
    result => result.chainId === chainId && result.projectId === projectId,
  )?.snapshot
  const allReadsVerified = matrix.every(kind => kind.readsVerified)
  const allFullyPriced = matrix.every(kind => kind.fullyPriced)
  const totalUsd = matrix.reduce((sum, kind) => sum + kind.totalUsd, 0n)
  const rawBalances = matrix
    .filter(kind => kind.totalBalance > 0n)
    .map(
      kind =>
        `${formatTokenAmount(kind.totalBalance, kind.decimals)} ${kind.symbol}`,
    )
  const totalBalanceLabel = !allReadsVerified
    ? '—'
    : allFullyPriced
      ? formatUsd18(totalUsd)
      : rawBalances.join(' + ') || '$0.00'
  const hasPayoutLimit =
    home?.payoutLines.some(line => line.amount > 0n) ?? false
  const hasAllowance =
    home?.allowanceLines.some(line => line.amount > 0n) ?? false
  const activePayoutLine =
    home?.payoutLines.find(line => line.remaining > 0n) ??
    home?.payoutLines[0]

  return (
    <div className="card p-6">
      <span className="field-label">Funds</span>
      <p className="mt-2 text-sm text-smoke-700">Total balance</p>
      <p className="mt-1 font-agrandir text-2xl font-medium text-ink">
        {totalBalanceLabel}
      </p>

      <div className="mt-5 flex flex-wrap gap-x-6 border-b border-smoke-200">
        {matrix.map(kind => {
          const active = kind.key === selected.key
          return (
            <button
              key={kind.key}
              type="button"
              onClick={() => setSelectedKey(kind.key)}
              className={`inline-flex items-baseline gap-2 border-b-2 px-1 pb-2 text-sm font-medium transition-colors ${
                active
                  ? 'border-bluebs-500'
                  : 'border-transparent hover:text-ink'
              }`}
            >
              <span
                className={active ? 'text-bluebs-700' : 'text-smoke-700'}
              >
                {kind.symbol}
              </span>
              <span className="text-xs font-normal text-smoke-600">
                {formatTokenAmount(kind.totalBalance, kind.decimals)}
              </span>
            </button>
          )
        })}
      </div>

      <p className="mt-5 text-sm text-smoke-700">Balance</p>
      <p className="mt-1 font-agrandir text-2xl font-medium text-ink">
        {formatTokenAmount(selected.totalBalance, selected.decimals)}{' '}
        {selected.symbol}
      </p>

      <div className="mt-5 overflow-x-auto">
        <table className="w-full min-w-[42rem] text-sm">
          <thead>
            <tr className="border-b border-smoke-200 text-left text-xs text-smoke-500">
              <th className="pb-2 font-normal">Chain</th>
              <th className="pb-2 text-right font-normal">Balance</th>
              <th className="pb-2 text-right font-normal">
                Payout limit remaining
              </th>
              <th className="pb-2 text-right font-normal">Surplus</th>
            </tr>
          </thead>
          <tbody>
            {selected.snapshots.map(result => {
              const snapshot = result.snapshot
              return (
                <tr
                  key={`${result.chainId}:${result.projectId}`}
                  className="border-b border-smoke-100 last:border-0"
                >
                  <td className="py-2 pr-4">
                    <span className="inline-flex items-center gap-2">
                      <ChainIcon chainId={result.chainId} size={18} />
                      {chainName(result.chainId)}
                    </span>
                  </td>
                  <td className="py-2 text-right">
                    {snapshot
                      ? `${formatTokenAmount(
                          snapshot.balance,
                          snapshot.ctx.decimals,
                        )} ${snapshot.tokenSymbol}`
                      : result.verified
                        ? 'Not added'
                        : '—'}
                  </td>
                  <td className="py-2 text-right">
                    {snapshot
                      ? remainingLabel(
                          snapshot.payoutLines,
                          snapshot.ctx,
                          snapshot.tokenSymbol,
                          snapshot.balance,
                        )
                      : '—'}
                  </td>
                  <td className="py-2 text-right">
                    {snapshot
                      ? `${formatTokenAmount(
                          snapshot.surplus,
                          snapshot.ctx.decimals,
                        )} ${snapshot.tokenSymbol}`
                      : '—'}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {home ? (
        <div className="mt-6 grid gap-6 border-t border-smoke-200 pt-6 lg:grid-cols-2">
          <section className="min-w-0 lg:border-r lg:border-smoke-200 lg:pr-6">
            <p className="text-sm text-smoke-700">
              Current payout limit remaining on {chainName(chainId)}:
            </p>
            <p className="mt-1 text-lg font-medium text-ink">
              {remainingLabel(
                home.payoutLines,
                home.ctx,
                home.tokenSymbol,
                home.balance,
              )}
            </p>
            <p className="mt-5 text-sm text-smoke-700">Payouts</p>
            {hasPayoutLimit ? (
              <PayoutsTable
                chainId={chainId}
                splits={home.splits}
                activeLine={activePayoutLine}
                ctx={home.ctx}
                tokenSymbol={home.tokenSymbol}
                balance={home.balance}
                etherscanHost={home.etherscanHost}
              />
            ) : (
              <p className="mt-1 text-sm text-ink">
                No payout limit is configured for this token in the current
                ruleset.
              </p>
            )}
            <div className="mt-4">
              {hasPayoutLimit &&
              (!home.ownerMustSendPayouts || isOwner) ? (
                <FundsTxFlow
                  kind="payouts"
                  chainId={chainId}
                  projectId={projectId}
                  ctx={home.ctx}
                  terminal={home.terminal}
                  store={home.store}
                  limitsAddress={home.limitsAddress}
                  lines={home.payoutLines.filter(line => line.amount > 0n)}
                  balance={home.balance}
                  tokenSymbol={home.tokenSymbol}
                  onDone={() => void refetch()}
                />
              ) : hasPayoutLimit && home.ownerMustSendPayouts ? (
                <p className="text-xs text-smoke-700">
                  Only the project owner can distribute payouts.
                </p>
              ) : (
                <button
                  type="button"
                  className="btn-secondary min-h-[40px] px-4 text-sm"
                  disabled
                >
                  Distribute payouts
                </button>
              )}
            </div>
          </section>

          <section className="min-w-0">
            <p className="text-sm text-smoke-700">
              Current surplus allowance remaining on {chainName(chainId)}:
            </p>
            <p className="mt-1 text-lg font-medium text-ink">
              {remainingLabel(
                home.allowanceLines,
                home.ctx,
                home.tokenSymbol,
              )}
            </p>
            <div className="mt-5">
              {isOwner && hasAllowance ? (
                <FundsTxFlow
                  kind="allowance"
                  chainId={chainId}
                  projectId={projectId}
                  ctx={home.ctx}
                  terminal={home.terminal}
                  store={home.store}
                  limitsAddress={home.limitsAddress}
                  lines={home.allowanceLines.filter(line => line.amount > 0n)}
                  balance={home.balance}
                  tokenSymbol={home.tokenSymbol}
                  onDone={() => void refetch()}
                />
              ) : (
                <button
                  type="button"
                  className="btn-secondary min-h-[40px] px-4 text-sm"
                  disabled
                >
                  Use surplus allowance
                </button>
              )}
            </div>
          </section>
        </div>
      ) : null}
    </div>
  )
}

function PayoutsTable({
  chainId,
  splits,
  activeLine,
  ctx,
  tokenSymbol,
  balance,
  etherscanHost,
}: {
  chainId: JBChainId
  splits: readonly Split[]
  activeLine: LimitLine | undefined
  ctx: JBAccountingContext
  tokenSymbol: string
  balance: bigint
  etherscanHost?: string
}) {
  // Each recipient's share of what can still be paid out this cycle.
  const distributable = activeLine
    ? activeLine.currency === ctx.currency
      ? bigintMin(activeLine.remaining, balance)
      : activeLine.remaining
    : 0n
  const amountDecimals = activeLine
    ? currencyDecimals(activeLine.currency, ctx)
    : ctx.decimals
  const amountLabel = activeLine
    ? currencyLabel(activeLine.currency, ctx, tokenSymbol)
    : tokenSymbol

  const totalPercent = splits.reduce((sum, split) => sum + split.percent, 0)
  const ownerPercent = Math.max(0, SPLITS_TOTAL_PERCENT - totalPercent)

  const shareOf = (percent: number) =>
    (distributable * BigInt(percent)) / BigInt(SPLITS_TOTAL_PERCENT)

  return (
    <div className="mt-4">
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-smoke-500">
              <th className="pb-1.5 font-normal">Recipient</th>
              <th className="pb-1.5 text-right font-normal">Share</th>
              <th className="pb-1.5 text-right font-normal">Would receive</th>
            </tr>
          </thead>
          <tbody className="text-ink">
            {splits.map((split, i) => (
              <tr key={i} className="border-t border-smoke-100">
                <td className="py-1.5 pr-3">
                  <SplitRecipient
                    split={split}
                    chainId={chainId}
                    host={etherscanHost}
                  />
                </td>
                <td className="py-1.5 text-right">
                  {formatPercent(split.percent)}
                </td>
                <td className="py-1.5 text-right">
                  {formatTokenAmount(shareOf(split.percent), amountDecimals)}{' '}
                  {amountLabel}
                </td>
              </tr>
            ))}
            {ownerPercent > 0 ? (
              <tr className="border-t border-smoke-100">
                <td className="py-1.5 pr-3 text-smoke-700">
                  Project owner (the rest)
                </td>
                <td className="py-1.5 text-right">
                  {formatPercent(ownerPercent)}
                </td>
                <td className="py-1.5 text-right">
                  {formatTokenAmount(shareOf(ownerPercent), amountDecimals)}{' '}
                  {amountLabel}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** A reviewed, ready-to-send transaction: the exact args (including the min
 *  that was displayed) are frozen here so what the user confirms is what's
 *  sent. */
type ReviewedTx = {
  functionName: 'sendPayoutsOf' | 'useAllowanceOf'
  args: readonly unknown[]
  /** The simulated amount that will be paid out, in the token's decimals. */
  quote: bigint
  /** The minTokensPaidOut param inside `args`, in the token's decimals. */
  min: bigint
  /** The account the review was made for. */
  account: Address
}

function FundsTxFlow({
  kind,
  chainId,
  projectId,
  ctx,
  terminal,
  store,
  limitsAddress,
  lines,
  balance,
  tokenSymbol,
  onDone,
}: {
  kind: 'payouts' | 'allowance'
  chainId: JBChainId
  projectId: number
  ctx: JBAccountingContext
  terminal: Address
  store: Address
  limitsAddress: Address
  /** The configured limit/allowance entries (amount > 0). */
  lines: LimitLine[]
  /** The project's balance of the token, for the MAX convenience cap. */
  balance: bigint
  tokenSymbol: string
  onDone: () => void
}) {
  const publicClient = usePublicClient({ chainId }) as PublicClient | undefined
  const { isConnected, address, openSignIn } = useWallet()
  const tx = useSafeTx(chainId)

  const [open, setOpen] = useState(false)
  const [amount, setAmount] = useState('')
  const [currency, setCurrency] = useState<number>(
    lines[0]?.currency ?? ctx.currency,
  )
  const [quoting, setQuoting] = useState(false)
  const [flowError, setFlowError] = useState<string | null>(null)
  const [review, setReview] = useState<ReviewedTx | null>(null)

  const line = lines.find(l => l.currency === currency) ?? lines[0]
  const decimals = line ? currencyDecimals(line.currency, ctx) : ctx.decimals
  const amountLabel = line
    ? currencyLabel(line.currency, ctx, tokenSymbol)
    : tokenSymbol
  const tokenKeyed = line?.currency === ctx.currency

  const chainMeta = JB_CHAINS[chainId]
  const txUrl = tx.hash
    ? `https://${chainMeta?.etherscanHostname}/tx/${tx.hash}`
    : null

  const busy = quoting || tx.busy

  // Refresh the card's numbers once the transaction lands.
  useEffect(() => {
    if (tx.phase === 'success') onDone()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tx.phase])

  const parsedAmount = useMemo(() => {
    try {
      const trimmed = amount.trim()
      if (!trimmed || !Number.isFinite(Number(trimmed)) || Number(trimmed) <= 0)
        return 0n
      return parseUnits(trimmed, decimals)
    } catch {
      return 0n
    }
  }, [amount, decimals])

  const label =
    kind === 'payouts' ? 'Distribute payouts' : 'Use surplus allowance'

  const closeAndReset = () => {
    setOpen(false)
    setAmount('')
    setFlowError(null)
    setReview(null)
    tx.reset()
  }

  /** Re-read live state, validate, and get the quote by simulating the call
   *  with min = 0 — the return value IS the amount that will be paid out. */
  const handleReview = async () => {
    if (!isConnected || !address) {
      openSignIn()
      return
    }
    if (!publicClient || !line || parsedAmount <= 0n || busy) return
    setFlowError(null)
    setQuoting(true)
    try {
      // LIVE re-reads: the ruleset (it may have rolled over), the configured
      // limit, its usage, and the balance — never trust the rendered numbers.
      const fresh = await getCurrentRuleset(publicClient, {
        chainId,
        projectId: BigInt(projectId),
      })
      const [freshLimits, freshBalance] = await Promise.all([
        publicClient.readContract({
          abi: jbFundAccessLimitsAbi,
          address: limitsAddress,
          functionName:
            kind === 'payouts' ? 'payoutLimitsOf' : 'surplusAllowancesOf',
          args: [
            BigInt(projectId),
            BigInt(fresh.ruleset.id),
            terminal,
            ctx.token,
          ],
        }) as Promise<readonly { amount: bigint; currency: number }[]>,
        publicClient.readContract({
          abi: jbTerminalStoreAbi,
          address: store,
          functionName: 'balanceOf',
          args: [terminal, BigInt(projectId), ctx.token],
        }) as Promise<bigint>,
      ])
      const freshLine = freshLimits.find(l => l.currency === line.currency)
      if (!freshLine || freshLine.amount <= 0n) {
        throw new FlowError(
          kind === 'payouts'
            ? 'Nothing can be paid out under the current rules.'
            : 'The current rules no longer grant a surplus allowance.',
        )
      }
      const used = (await publicClient.readContract({
        abi: jbTerminalStoreAbi,
        address: store,
        functionName:
          kind === 'payouts' ? 'usedPayoutLimitOf' : 'usedSurplusAllowanceOf',
        args: [
          terminal,
          BigInt(projectId),
          ctx.token,
          kind === 'payouts'
            ? BigInt(fresh.ruleset.cycleNumber)
            : BigInt(fresh.ruleset.id),
          BigInt(line.currency),
        ],
      })) as bigint
      const remaining = freshLine.amount > used ? freshLine.amount - used : 0n
      if (remaining <= 0n) {
        throw new FlowError(
          kind === 'payouts'
            ? 'The payout limit for this cycle has already been fully used.'
            : 'The surplus allowance has already been fully used.',
        )
      }
      if (parsedAmount > remaining) {
        throw new FlowError(
          `That's more than the ${formatTokenAmount(remaining, decimals)} ${amountLabel} still available.`,
        )
      }
      // When the amount is in the token's own terms it can't exceed what the
      // treasury holds. (Other currencies are converted by a price feed —
      // the simulation below is the gate for those.)
      if (tokenKeyed && parsedAmount > freshBalance) {
        throw new FlowError(
          `That's more than the ${formatTokenAmount(freshBalance, ctx.decimals)} ${tokenSymbol} the project holds.`,
        )
      }

      // The exact call args for a given min-out: the quote simulates with 0,
      // and the reviewed transaction reuses the same builder with the
      // enforced min, so the two can never drift.
      const argsWithMin = (min: bigint): readonly unknown[] =>
        kind === 'payouts'
          ? [
              BigInt(projectId),
              ctx.token,
              parsedAmount,
              BigInt(line.currency),
              min,
            ]
          : [
              BigInt(projectId),
              ctx.token,
              parsedAmount,
              BigInt(line.currency),
              min,
              address,
              address,
              '',
            ]

      // Quote: simulate the exact call with min = 0. The simulated return
      // value (amountPaidOut / netAmountPaidOut) is the quote, in the
      // token's decimals.
      const sim = await publicClient.simulateContract({
        address: terminal,
        abi: jbMultiTerminalAbi as Abi,
        functionName:
          kind === 'payouts' ? 'sendPayoutsOf' : 'useAllowanceOf',
        args: argsWithMin(0n),
        account: address,
      })
      const quote = sim.result as bigint
      if (quote <= 0n) {
        throw new FlowError(
          'Nothing would be paid out for that amount — try a different one.',
        )
      }

      // The min the transaction enforces: for payouts in the token's own
      // currency the quote is exact (no price conversion), so demand it
      // exactly; anywhere a price feed is involved (other currencies, and
      // the allowance flow per spec) allow 1% of drift.
      const min =
        kind === 'payouts' && tokenKeyed ? quote : (quote * 99n) / 100n

      setReview({
        functionName: kind === 'payouts' ? 'sendPayoutsOf' : 'useAllowanceOf',
        args: argsWithMin(min),
        quote,
        min,
        account: address,
      })
    } catch (e) {
      setFlowError(e instanceof FlowError ? e.message : shortError(e))
    } finally {
      setQuoting(false)
    }
  }

  const handleConfirm = () => {
    if (!review || busy) return
    // Account-unchanged recheck: the reviewed args embed the beneficiary.
    if (address?.toLowerCase() !== review.account.toLowerCase()) {
      setReview(null)
      setFlowError('Your connected account changed — review the amount again.')
      return
    }
    tx.send({
      chainId,
      address: terminal,
      abi: jbMultiTerminalAbi,
      functionName: review.functionName,
      args: review.args,
    })
  }

  if (!line) return null

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="btn-secondary min-h-[40px] px-4 text-sm"
      >
        {label}
      </button>
    )
  }

  if (tx.phase === 'success') {
    return (
      <div className="rounded-xl border border-smoke-200 p-4">
        <p className="text-sm font-medium text-ink">
          {kind === 'payouts'
            ? 'Payouts sent to the recipients.'
            : 'Funds sent to your wallet.'}
        </p>
        <div className="mt-2 flex gap-3 text-sm font-semibold">
          {txUrl ? (
            <a
              href={txUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-bluebs-600 underline underline-offset-2 hover:text-bluebs-700"
            >
              View transaction
            </a>
          ) : null}
          <button
            onClick={closeAndReset}
            className="text-smoke-700 hover:text-ink"
          >
            Done
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-smoke-200 p-4">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium text-ink">{label}</span>
        <button
          onClick={closeAndReset}
          disabled={busy}
          className="text-xs font-medium text-smoke-700 hover:text-ink disabled:opacity-50"
        >
          Cancel
        </button>
      </div>

      <label className="mt-3 block">
        <span className="field-label">Amount</span>
        <div className="input-well mt-1.5 flex items-center px-4">
          <input
            type="text"
            inputMode="decimal"
            autoComplete="off"
            value={amount}
            onChange={e => {
              setAmount(e.target.value)
              // Inputs-unchanged: editing invalidates the reviewed quote.
              setReview(null)
              setFlowError(null)
            }}
            placeholder="0"
            disabled={busy}
            aria-label={`Amount in ${amountLabel}`}
            className="min-h-[44px] w-full bg-transparent text-lg font-medium outline-none placeholder:text-smoke-500 disabled:cursor-not-allowed"
          />
          <span className="ml-2 shrink-0 text-sm font-medium text-smoke-700">
            {amountLabel}
          </span>
          <button
            onClick={() => {
              const max = tokenKeyed
                ? bigintMin(line.remaining, balance)
                : line.remaining
              setAmount(formatUnits(max, decimals))
              setReview(null)
              setFlowError(null)
            }}
            disabled={busy}
            className="btn-secondary ml-3 px-2.5 py-0.5 text-[11px]"
          >
            MAX
          </button>
        </div>
      </label>

      {lines.length > 1 ? (
        <label className="mt-2 block">
          <span className="field-label">Denominated in</span>
          <select
            value={currency}
            disabled={busy}
            onChange={e => {
              setCurrency(Number(e.target.value))
              setReview(null)
              setFlowError(null)
            }}
            className="input-well mt-1.5 min-h-[40px] w-full px-3 text-sm"
          >
            {lines.map(l => (
              <option key={l.currency} value={l.currency}>
                {currencyLabel(l.currency, ctx, tokenSymbol)}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      <p className="mt-2 text-xs text-smoke-700">
        {formatTokenAmount(line.remaining, decimals)} {amountLabel} still
        available
        {!tokenKeyed
          ? ` — amounts in ${amountLabel} are paid out in ${tokenSymbol} at the current price`
          : ''}
        .
      </p>

      {review ? (
        <div className="callout callout-info mt-3 text-xs">
          <p>
            {kind === 'payouts' ? (
              <>
                ~{formatTokenAmount(review.quote, ctx.decimals)} {tokenSymbol}{' '}
                will be paid out to the recipients.
              </>
            ) : (
              <>
                You&apos;ll receive ~
                {formatTokenAmount(review.quote, ctx.decimals)} {tokenSymbol}{' '}
                after the fee.
              </>
            )}
          </p>
          <p className="mt-1">
            At least {formatTokenAmount(review.min, ctx.decimals)} {tokenSymbol}{' '}
            {kind === 'payouts' ? 'must be paid out' : 'must reach you'}, or
            the transaction reverts.
          </p>
          <p className="mt-1 text-smoke-700">
            {kind === 'payouts'
              ? 'Recipients outside Juicebox receive 2.5% less — the protocol fee.'
              : 'A 2.5% protocol fee applies.'}
          </p>
        </div>
      ) : null}

      <button
        onClick={review ? handleConfirm : handleReview}
        disabled={busy || (isConnected && parsedAmount <= 0n)}
        className="btn-primary mt-3 min-h-[44px] w-full text-sm"
      >
        {quoting
          ? 'Checking what you can send…'
          : txPhaseLabel(tx.phase, {
              pending: 'Sending…',
              idle: !isConnected
                ? 'Sign in to continue'
                : review
                  ? `Confirm ${kind === 'payouts' ? 'payouts' : 'withdrawal'}`
                  : 'Review',
            })}
      </button>

      {tx.phase === 'pending' && txUrl ? (
        <p className="mt-2 text-center text-xs text-smoke-700">
          Waiting for confirmation —{' '}
          <a
            href={txUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2"
          >
            view transaction
          </a>
        </p>
      ) : null}

      <TxError
        error={flowError ?? tx.error}
        className="mt-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700"
      />
    </div>
  )
}
