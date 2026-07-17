'use client'

import {
  JB_CHAINS,
  JBCoreContracts,
  NATIVE_TOKEN,
  SPLITS_TOTAL_PERCENT,
  jbContractAddress,
  jbFundAccessLimitsAbi,
  jbMultiTerminalAbi,
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
import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import {
  erc20Abi,
  formatUnits,
  parseUnits,
  zeroAddress,
  type Address,
  type PublicClient,
} from 'viem'
import { usePublicClient, useReadContract, useReadContracts } from 'wagmi'
import { useSafeTx } from '@/hooks/useSafeTx'
import { useWallet } from '@/hooks/useWallet'
import { formatTokenAmount, truncateAddress } from '@/lib/format'
import { toUrn } from '@/lib/urn'

/**
 * Funds tab for custom projects (website/ parity: renderFundsCard, single
 * chain). Per accounting token: balance, what can be paid out now, the
 * owner's surplus allowance, the surplus backing cash outs, and the payout
 * recipients — plus the two write flows, "Send payouts"
 * (JBMultiTerminal.sendPayoutsOf) and "Use surplus allowance"
 * (JBMultiTerminal.useAllowanceOf), both through useSafeTx (simulate-first).
 */
export function FundsTab({
  chainId,
  projectId,
}: {
  chainId: JBChainId
  projectId: number
}) {
  const publicClient = usePublicClient({ chainId }) as PublicClient | undefined
  const { address } = useWallet()

  const { data: contexts, isLoading: contextsLoading } = useQuery({
    queryKey: ['accountingContexts', chainId, projectId],
    enabled: !!publicClient,
    staleTime: 60_000,
    retry: 1,
    queryFn: () =>
      getAccountingContexts(publicClient!, {
        chainId,
        projectId: BigInt(projectId),
      }),
  })

  const { data: rulesetData, isLoading: rulesetLoading } = useQuery({
    queryKey: ['currentRuleset', chainId, projectId],
    enabled: !!publicClient,
    staleTime: 60_000,
    retry: 1,
    queryFn: () =>
      getCurrentRuleset(publicClient!, {
        chainId,
        projectId: BigInt(projectId),
      }),
  })

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

  if (contextsLoading || rulesetLoading) {
    return (
      <div className="card p-5">
        <span className="field-label">Funds</span>
        <p className="mt-2 text-sm text-smoke-500">Loading…</p>
      </div>
    )
  }

  if (!contexts || contexts.length === 0) {
    return (
      <div className="card p-5">
        <span className="field-label">Funds</span>
        <p className="mt-2 text-sm leading-relaxed text-smoke-700">
          This project doesn&apos;t hold funds on this chain yet.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      {contexts.map(ctx => (
        <TokenFundsCard
          key={ctx.token}
          chainId={chainId}
          projectId={projectId}
          ctx={ctx}
          rulesetId={rulesetData?.ruleset.id ?? 0}
          rulesetCycleNumber={rulesetData?.ruleset.cycleNumber ?? 0}
          ownerMustSendPayouts={
            rulesetData?.metadata.ownerMustSendPayouts ?? false
          }
          isOwner={isOwner}
        />
      ))}
    </div>
  )
}

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
  const pct = (percent / SPLITS_TOTAL_PERCENT) * 100
  return `${pct.toFixed(2).replace(/\.?0+$/, '')}%`
}

function bigintMin(a: bigint, b: bigint): bigint {
  return a < b ? a : b
}

function TokenFundsCard({
  chainId,
  projectId,
  ctx,
  rulesetId,
  rulesetCycleNumber,
  ownerMustSendPayouts,
  isOwner,
}: {
  chainId: JBChainId
  projectId: number
  ctx: JBAccountingContext
  rulesetId: number
  rulesetCycleNumber: number
  ownerMustSendPayouts: boolean
  isOwner: boolean
}) {
  const chainMeta = JB_CHAINS[chainId]
  const nativeSymbol = chainMeta?.nativeTokenSymbol ?? 'ETH'
  const etherscanHost = chainMeta?.etherscanHostname

  const isNative = ctx.token.toLowerCase() === NATIVE_TOKEN.toLowerCase()

  const terminal = jbContractAddress['6'][JBCoreContracts.JBMultiTerminal][
    chainId
  ] as Address
  const store = jbContractAddress['6'][JBCoreContracts.JBTerminalStore][
    chainId
  ] as Address
  const limitsAddress = jbContractAddress['6'][
    JBCoreContracts.JBFundAccessLimits
  ][chainId] as Address
  const splitsAddress = jbContractAddress['6'][JBCoreContracts.JBSplits][
    chainId
  ] as Address

  const { data: erc20Symbol } = useReadContract({
    abi: erc20Abi,
    address: ctx.token,
    functionName: 'symbol',
    chainId,
    query: { enabled: !isNative, staleTime: 5 * 60_000 },
  })
  const tokenSymbol = isNative
    ? nativeSymbol
    : (erc20Symbol ?? truncateAddress(ctx.token))

  // Balance, configured limits, surplus, and payout splits for this token.
  const {
    data: base,
    isLoading: baseLoading,
    refetch: refetchBase,
  } = useReadContracts({
    contracts: [
      {
        abi: jbTerminalStoreAbi,
        address: store,
        functionName: 'balanceOf',
        args: [terminal, BigInt(projectId), ctx.token],
        chainId,
      },
      {
        abi: jbFundAccessLimitsAbi,
        address: limitsAddress,
        functionName: 'payoutLimitsOf',
        args: [BigInt(projectId), BigInt(rulesetId), terminal, ctx.token],
        chainId,
      },
      {
        abi: jbFundAccessLimitsAbi,
        address: limitsAddress,
        functionName: 'surplusAllowancesOf',
        args: [BigInt(projectId), BigInt(rulesetId), terminal, ctx.token],
        chainId,
      },
      {
        abi: jbTerminalStoreAbi,
        address: store,
        functionName: 'currentSurplusOf',
        args: [
          BigInt(projectId),
          [terminal],
          [ctx.token],
          BigInt(ctx.decimals),
          BigInt(ctx.currency),
        ],
        chainId,
      },
      {
        abi: jbSplitsAbi,
        address: splitsAddress,
        functionName: 'splitsOf',
        args: [BigInt(projectId), BigInt(rulesetId), payoutSplitGroupId(ctx.token)],
        chainId,
      },
    ],
  })

  const balance = base?.[0]?.result as bigint | undefined
  const payoutLimits = base?.[1]?.result as
    | readonly { amount: bigint; currency: number }[]
    | undefined
  const surplusAllowances = base?.[2]?.result as
    | readonly { amount: bigint; currency: number }[]
    | undefined
  const surplus = base?.[3]?.result as bigint | undefined
  const splits = base?.[4]?.result as
    | readonly {
        percent: number
        projectId: bigint
        beneficiary: Address
        preferAddToBalance: boolean
        lockedUntil: number
        hook: Address
      }[]
    | undefined

  // How much of each configured limit has been used. Payout usage is keyed
  // by the ruleset's CYCLE NUMBER; allowance usage by the ruleset's id.
  const { data: usage, refetch: refetchUsage } = useReadContracts({
    contracts: [
      ...(payoutLimits ?? []).map(limit => ({
        abi: jbTerminalStoreAbi,
        address: store,
        functionName: 'usedPayoutLimitOf' as const,
        args: [
          terminal,
          BigInt(projectId),
          ctx.token,
          BigInt(rulesetCycleNumber),
          BigInt(limit.currency),
        ] as const,
        chainId,
      })),
      ...(surplusAllowances ?? []).map(allowance => ({
        abi: jbTerminalStoreAbi,
        address: store,
        functionName: 'usedSurplusAllowanceOf' as const,
        args: [
          terminal,
          BigInt(projectId),
          ctx.token,
          BigInt(rulesetId),
          BigInt(allowance.currency),
        ] as const,
        chainId,
      })),
    ],
    query: { enabled: !!payoutLimits && !!surplusAllowances },
  })

  const payoutLines: LimitLine[] = useMemo(() => {
    if (!payoutLimits) return []
    return payoutLimits.map((limit, i) => {
      const used = (usage?.[i]?.result as bigint | undefined) ?? 0n
      const remaining = limit.amount > used ? limit.amount - used : 0n
      return { amount: limit.amount, currency: limit.currency, used, remaining }
    })
  }, [payoutLimits, usage])

  const allowanceLines: LimitLine[] = useMemo(() => {
    if (!surplusAllowances) return []
    const offset = payoutLimits?.length ?? 0
    return surplusAllowances.map((allowance, i) => {
      const used = (usage?.[offset + i]?.result as bigint | undefined) ?? 0n
      const remaining = allowance.amount > used ? allowance.amount - used : 0n
      return {
        amount: allowance.amount,
        currency: allowance.currency,
        used,
        remaining,
      }
    })
  }, [surplusAllowances, payoutLimits, usage])

  const hasPayoutLimit = payoutLines.some(line => line.amount > 0n)
  const hasAllowance = allowanceLines.some(line => line.amount > 0n)

  // The line the payout flow (and the payouts table's amount column) uses:
  // the first with room left, falling back to the first configured.
  const activePayoutLine =
    payoutLines.find(line => line.remaining > 0n) ?? payoutLines[0]

  const refetchAll = () => {
    refetchBase()
    refetchUsage()
  }

  if (baseLoading) {
    return (
      <div className="card p-5">
        <span className="field-label">Funds</span>
        <p className="mt-2 text-sm text-smoke-500">Loading…</p>
      </div>
    )
  }

  return (
    <div className="card p-5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="field-label">{tokenSymbol} funds</span>
        <span className="font-agrandir text-xl font-medium text-ink">
          {balance !== undefined
            ? `${formatTokenAmount(balance, ctx.decimals)} ${tokenSymbol}`
            : '—'}
        </span>
      </div>

      <dl className="mt-4 space-y-2 text-sm">
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-smoke-700">Available to pay out now</dt>
          <dd className="text-right font-medium text-ink">
            {!hasPayoutLimit ? (
              <span className="font-normal text-smoke-700">None</span>
            ) : (
              payoutLines
                .filter(line => line.amount > 0n)
                .map(line => (
                  <div key={line.currency}>
                    {formatTokenAmount(
                      // The treasury can only fund what it holds — cap the
                      // remaining limit at the balance when both are in the
                      // token's own terms.
                      line.currency === ctx.currency
                        ? bigintMin(line.remaining, balance ?? 0n)
                        : line.remaining,
                      currencyDecimals(line.currency, ctx),
                    )}{' '}
                    {currencyLabel(line.currency, ctx, tokenSymbol)}
                  </div>
                ))
            )}
          </dd>
        </div>

        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-smoke-700">Owner&apos;s surplus allowance remaining</dt>
          <dd className="text-right font-medium text-ink">
            {!hasAllowance ? (
              <span className="font-normal text-smoke-700">None</span>
            ) : (
              allowanceLines
                .filter(line => line.amount > 0n)
                .map(line => (
                  <div key={line.currency}>
                    {formatTokenAmount(
                      line.remaining,
                      currencyDecimals(line.currency, ctx),
                    )}{' '}
                    {currencyLabel(line.currency, ctx, tokenSymbol)}
                  </div>
                ))
            )}
          </dd>
        </div>

        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-smoke-700">Surplus backing cash outs</dt>
          <dd className="font-medium text-ink">
            {surplus !== undefined
              ? `${formatTokenAmount(surplus, ctx.decimals)} ${tokenSymbol}`
              : '—'}
          </dd>
        </div>
      </dl>

      {!hasPayoutLimit ? (
        <p className="callout callout-warning mt-4 text-xs">
          Nothing can be paid out under the current rules — funds stay in the
          project.
        </p>
      ) : (
        <PayoutsTable
          chainId={chainId}
          splits={splits ?? []}
          activeLine={activePayoutLine}
          ctx={ctx}
          tokenSymbol={tokenSymbol}
          balance={balance ?? 0n}
          etherscanHost={etherscanHost}
        />
      )}

      <div className="mt-4 space-y-4">
        {hasPayoutLimit && (!ownerMustSendPayouts || isOwner) ? (
          <FundsTxFlow
            kind="payouts"
            chainId={chainId}
            projectId={projectId}
            ctx={ctx}
            terminal={terminal}
            store={store}
            limitsAddress={limitsAddress}
            lines={payoutLines.filter(line => line.amount > 0n)}
            balance={balance ?? 0n}
            tokenSymbol={tokenSymbol}
            onDone={refetchAll}
          />
        ) : hasPayoutLimit && ownerMustSendPayouts ? (
          <p className="text-xs text-smoke-700">
            Only the project owner can send payouts under the current rules.
          </p>
        ) : null}

        {isOwner && hasAllowance ? (
          <FundsTxFlow
            kind="allowance"
            chainId={chainId}
            projectId={projectId}
            ctx={ctx}
            terminal={terminal}
            store={store}
            limitsAddress={limitsAddress}
            lines={allowanceLines.filter(line => line.amount > 0n)}
            balance={balance ?? 0n}
            tokenSymbol={tokenSymbol}
            onDone={refetchAll}
          />
        ) : null}
      </div>
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
  splits: readonly {
    percent: number
    projectId: bigint
    beneficiary: Address
    lockedUntil: number
    hook: Address
  }[]
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

  const recipient = (split: {
    projectId: bigint
    beneficiary: Address
    hook: Address
  }) => {
    if (split.hook !== zeroAddress) {
      return addressCell(split.hook, etherscanHost, 'hook')
    }
    if (split.projectId > 0n) {
      return (
        <Link
          href={`/${toUrn(chainId, Number(split.projectId))}`}
          className="text-ink hover:underline"
        >
          Project #{split.projectId.toString()}
        </Link>
      )
    }
    return addressCell(split.beneficiary, etherscanHost)
  }

  return (
    <div className="mt-4">
      <span className="field-label">Where payouts go</span>
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
                <td className="py-1.5 pr-3">{recipient(split)}</td>
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

function addressCell(
  address: Address,
  etherscanHost?: string,
  note?: string,
) {
  const label = truncateAddress(address)
  return (
    <span>
      {etherscanHost ? (
        <a
          href={`https://${etherscanHost}/address/${address}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-ink hover:underline"
        >
          {label}
        </a>
      ) : (
        label
      )}
      {note ? <span className="ml-1.5 text-xs text-smoke-500">{note}</span> : null}
    </span>
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

  const busy =
    quoting ||
    tx.phase === 'simulating' ||
    tx.phase === 'signing' ||
    tx.phase === 'pending'

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

  const label = kind === 'payouts' ? 'Send payouts' : 'Use surplus allowance'

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

      // Quote: simulate the exact call with min = 0. The simulated return
      // value (amountPaidOut / netAmountPaidOut) is the quote, in the
      // token's decimals.
      const sim =
        kind === 'payouts'
          ? await publicClient.simulateContract({
              address: terminal,
              abi: jbMultiTerminalAbi,
              functionName: 'sendPayoutsOf',
              args: [
                BigInt(projectId),
                ctx.token,
                parsedAmount,
                BigInt(line.currency),
                0n,
              ],
              account: address,
            })
          : await publicClient.simulateContract({
              address: terminal,
              abi: jbMultiTerminalAbi,
              functionName: 'useAllowanceOf',
              args: [
                BigInt(projectId),
                ctx.token,
                parsedAmount,
                BigInt(line.currency),
                0n,
                address,
                address,
                '',
              ],
              account: address,
            })
      const quote = sim.result
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

      const args =
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
      setReview({
        functionName: kind === 'payouts' ? 'sendPayoutsOf' : 'useAllowanceOf',
        args,
        quote,
        min,
        account: address,
      })
    } catch (e) {
      setFlowError(
        e instanceof FlowError
          ? e.message
          : e instanceof Error
            ? shortSimulationError(e)
            : 'Something went wrong.',
      )
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
          : tx.phase === 'simulating'
            ? 'Double-checking the transaction…'
            : tx.phase === 'signing'
              ? 'Confirm in your wallet…'
              : tx.phase === 'pending'
                ? 'Sending…'
                : !isConnected
                  ? 'Sign in to continue'
                  : review
                    ? `Confirm ${kind === 'payouts' ? 'payouts' : 'withdrawal'}`
                    : 'Review'}
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

      {flowError || tx.error ? (
        <p className="mt-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
          {flowError ?? tx.error}
        </p>
      ) : null}
    </div>
  )
}

/** A validation failure with copy that's already user-ready. */
class FlowError extends Error {}

/** Trim a raw simulation error down to its useful first line. */
function shortSimulationError(e: Error): string {
  const message =
    'shortMessage' in e && typeof e.shortMessage === 'string'
      ? e.shortMessage
      : e.message
  if (/denied|rejected/i.test(message)) return 'Transaction cancelled.'
  return message.split('\n')[0]
}
