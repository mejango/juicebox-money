'use client'

import {
  JB_CHAINS,
  USD_CURRENCY_ID,
  jbFundAccessLimitsAbi,
  jbSplitsAbi,
  jbTokensAbi,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import {
  RESERVED_TOKEN_SPLIT_GROUP_ID,
  getAccountingContexts,
  getAllRulesets,
  getCurrentRuleset,
  getUpcomingRuleset,
  payoutSplitGroupId,
  v6Address,
  type JBRulesetWithMetadata,
} from '@bananapus/nana-sdk-core/v6'
import { getPublicClient } from '@wagmi/core'
import { useQuery } from '@tanstack/react-query'
import { Fragment, useMemo, useState, type ReactNode } from 'react'
import { erc20Abi, zeroAddress, type PublicClient } from 'viem'
import { usePublicClient } from 'wagmi'
import { ChainIcon } from '@/components/ChainIcon'
import { RulesetsTabSkeleton } from '@/components/LoadingSkeletons'
import { Skeleton, SkeletonTable } from '@/components/ui/Skeleton'
import { EditSplitsFlow } from '@/components/project/EditSplitsFlow'
import { QueueRulesetFlow } from '@/components/project/QueueRulesetFlow'
import {
  billionthsToPct,
  fmtPct,
  formatCountdown,
  formatDate,
  formatDuration,
  formatTokenAmount,
  truncateAddress,
} from '@/lib/format'
import type { RawSplit } from '@/lib/splits-types'
import { tokenSymbol } from '@/lib/token-symbol'
import { chainName } from '@/lib/urn'
import { wagmiConfig } from '@/providers/Providers'

/** Fund-access amounts at/above this are stored as "no limit". */
const UNLIMITED_FLOOR = 2n ** 200n
/** Reserved-split sentinel meaning "burn this portion". */
const BURN_ADDRESS = '0x000000000000000000000000000000000000dead'

type AccountingContext = {
  token: `0x${string}`
  decimals: number
  currency: number
  symbol: string
}

type CurrencyAmount = { amount: bigint; currency: number }

type Entry = {
  data: JBRulesetWithMetadata
  tag: 'Past' | 'Current' | 'Upcoming'
}

function formatDateTime(sec: number): string {
  return new Date(sec * 1000).toLocaleString('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

/** Ruleset percents are basis points of 10,000: 3800 → "38%". */
function basisPoints(bp: number): string {
  return fmtPct(bp / 100)
}

/** The accounting-context currency id for a token: uint32(uint160(token)). */
function tokenCurrencyId(token: string): number {
  return Number(BigInt(token) & 0xffffffffn)
}

function baseCurrencyLabel(
  currency: number,
  contexts: readonly AccountingContext[] | undefined,
): string {
  if (currency === 1) return 'ETH'
  if (currency === USD_CURRENCY_ID(6)) return 'USD'
  const match = contexts?.find(ctx => ctx.currency === currency)
  return match ? match.symbol : `currency ${currency}`
}

const DEADLINE_LABELS = [
  ['JBDeadline3Hours', '3-hour deadline'],
  ['JBDeadline1Day', '1-day deadline'],
  ['JBDeadline3Days', '3-day deadline'],
  ['JBDeadline7Days', '7-day deadline'],
] as const

/** Human name for a ruleset's approval hook; null when there's none. */
function approvalHookLabel(
  chainId: JBChainId,
  hook: string | undefined,
): string | null {
  if (!hook || hook === zeroAddress) return null
  for (const [contract, label] of DEADLINE_LABELS) {
    try {
      if (v6Address(contract, chainId).toLowerCase() === hook.toLowerCase()) {
        return label
      }
    } catch {
      // The deadline contract isn't deployed on this chain.
    }
  }
  return `Approval hook ${truncateAddress(hook)}`
}

type RuleRow = {
  section: string
  label: string
  value: string
  hint?: string
}

type RulesetSyncField = {
  key: string
  label: string
  raw: string
  value: string
}

type ChainRulesetSnapshot = {
  chainId: JBChainId
  projectId: number
  ruleset: JBRulesetWithMetadata | null
  error: boolean
}

/**
 * Configured characteristics used by website/ to decide whether omnichain
 * rulesets are synced. Live timing, cycle number, ruleset id, and live weight
 * are deliberately excluded: omnichain transactions land in different
 * blocks, and an auto-cycling weight can legitimately be at a different live
 * point while the rules themselves remain identical.
 */
function rulesetSyncFields(entry: JBRulesetWithMetadata): RulesetSyncField[] {
  const { ruleset: r, metadata: m } = entry
  const dataHook = String(m.dataHook ?? zeroAddress)
  const hookValue =
    dataHook.toLowerCase() === zeroAddress ? 'None' : truncateAddress(dataHook)

  return [
    {
      key: 'duration',
      label: 'Duration',
      raw: String(r.duration),
      value: r.duration > 0 ? formatDuration(r.duration) : 'None',
    },
    {
      key: 'weightCutPercent',
      label: 'Issuance cut',
      raw: String(r.weightCutPercent),
      value:
        r.weightCutPercent > 0
          ? `${billionthsToPct(r.weightCutPercent)} each cycle`
          : 'None',
    },
    {
      key: 'reservedPercent',
      label: 'Reserved tokens',
      raw: String(m.reservedPercent),
      value: m.reservedPercent > 0 ? basisPoints(m.reservedPercent) : 'None',
    },
    {
      key: 'cashOutTaxRate',
      label: 'Cash-out tax',
      raw: String(m.cashOutTaxRate),
      value:
        m.cashOutTaxRate >= 10_000
          ? 'Disabled'
          : m.cashOutTaxRate > 0
            ? basisPoints(m.cashOutTaxRate)
            : 'None',
    },
    {
      key: 'baseCurrency',
      label: 'Base currency',
      raw: String(m.baseCurrency),
      value: baseCurrencyLabel(m.baseCurrency, undefined),
    },
    {
      key: 'pausePay',
      label: 'Payments',
      raw: String(m.pausePay),
      value: m.pausePay ? 'Paused' : 'Open',
    },
    {
      key: 'pauseCreditTransfers',
      label: 'Token transfers',
      raw: String(m.pauseCreditTransfers),
      value: m.pauseCreditTransfers ? 'Paused' : 'Allowed',
    },
    {
      key: 'allowOwnerMinting',
      label: 'Owner minting',
      raw: String(m.allowOwnerMinting),
      value: m.allowOwnerMinting ? 'Allowed' : 'Not allowed',
    },
    {
      key: 'allowSetTerminals',
      label: 'Change payment terminals',
      raw: String(m.allowSetTerminals),
      value: m.allowSetTerminals ? 'Allowed' : 'Not allowed',
    },
    {
      key: 'allowSetController',
      label: 'Change controller',
      raw: String(m.allowSetController),
      value: m.allowSetController ? 'Allowed' : 'Not allowed',
    },
    {
      key: 'allowTerminalMigration',
      label: 'Migrate terminals',
      raw: String(m.allowTerminalMigration),
      value: m.allowTerminalMigration ? 'Allowed' : 'Not allowed',
    },
    {
      key: 'holdFees',
      label: 'Hold fees',
      raw: String(m.holdFees),
      value: m.holdFees ? 'Yes' : 'No',
    },
    {
      key: 'useDataHookForPay',
      label: 'Use data hook for payments',
      raw: String(m.useDataHookForPay),
      value: m.useDataHookForPay ? 'Yes' : 'No',
    },
    {
      key: 'useDataHookForCashOut',
      label: 'Use data hook for cash outs',
      raw: String(m.useDataHookForCashOut),
      value: m.useDataHookForCashOut ? 'Yes' : 'No',
    },
    {
      key: 'dataHook',
      label: 'Data hook',
      raw: dataHook.toLowerCase(),
      value: hookValue,
    },
  ]
}

function RulesetChainStatus({
  snapshots,
  loading,
}: {
  snapshots: readonly ChainRulesetSnapshot[] | undefined
  loading: boolean
}) {
  if (loading) {
    return (
      <Skeleton
        className="mx-auto mt-4 h-3 w-48 rounded"
        role="status"
        aria-label="Checking rules across chains"
      />
    )
  }
  if (!snapshots?.length) return null

  const verified = snapshots.filter(
    (snapshot): snapshot is ChainRulesetSnapshot & {
      ruleset: JBRulesetWithMetadata
    } => !!snapshot.ruleset,
  )
  const unavailable = snapshots.filter(snapshot => !snapshot.ruleset)

  if (verified.length < 2) {
    return unavailable.length ? (
      <p className="mt-4 text-center text-xs text-smoke-500">
        Couldn&apos;t compare the rules on every chain.
      </p>
    ) : null
  }

  const fieldsByChain = verified.map(snapshot => ({
    ...snapshot,
    fields: rulesetSyncFields(snapshot.ruleset),
  }))
  const baseline = fieldsByChain[0].fields
  const differences = baseline.filter(field =>
    fieldsByChain.some(snapshot => {
      const candidate = snapshot.fields.find(item => item.key === field.key)
      return candidate?.raw !== field.raw
    }),
  )

  if (!differences.length && !unavailable.length) {
    return (
      <div className="mt-4 flex flex-wrap items-center justify-center gap-2 text-sm text-melon-700">
        <span className="flex -space-x-1" aria-hidden>
          {verified.map(snapshot => (
            <ChainIcon
              key={snapshot.chainId}
              chainId={snapshot.chainId}
              size={18}
              className="ring-2 ring-white"
            />
          ))}
        </span>
        <span className="font-medium">Synced across all chains</span>
      </div>
    )
  }

  if (!differences.length) {
    return (
      <div className="callout callout-warning mt-4 text-sm">
        <p className="font-medium text-ink">Couldn&apos;t verify every chain</p>
        <p className="mt-1 text-xs text-smoke-700">
          The verified chains have matching rules, but{' '}
          {unavailable.map(row => chainName(row.chainId)).join(', ')} could not
          be checked.
        </p>
      </div>
    )
  }

  return (
    <div className="callout callout-warning mt-4 text-sm">
      <p className="font-medium text-ink">Rules differ by chain</p>
      <p className="mt-1 text-xs text-smoke-700">
        Only the settings below differ. Live timing, cycle number, and current
        issuance weight are not part of this comparison.
      </p>
      <div className="mt-3 divide-y divide-smoke-200 border-y border-smoke-200">
        {differences.map(field => (
          <div
            key={field.key}
            className="grid gap-2 py-3 sm:grid-cols-[10rem_minmax(0,1fr)]"
          >
            <p className="text-xs font-medium text-smoke-700">{field.label}</p>
            <div className="flex flex-wrap gap-x-5 gap-y-2">
              {fieldsByChain.map(snapshot => {
                const value = snapshot.fields.find(
                  item => item.key === field.key,
                )?.value
                return (
                  <div
                    key={snapshot.chainId}
                    className="inline-flex items-center gap-1.5"
                  >
                    <ChainIcon chainId={snapshot.chainId} size={16} />
                    <span className="text-xs text-smoke-500">
                      {chainName(snapshot.chainId)}:
                    </span>
                    <span className="text-xs font-medium text-ink">
                      {value ?? '—'}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>
      {unavailable.length ? (
        <p className="mt-2 text-xs text-smoke-700">
          Couldn&apos;t verify{' '}
          {unavailable.map(row => chainName(row.chainId)).join(', ')}.
        </p>
      ) : null}
    </div>
  )
}

/** Every rule as a label/value row, in mainstream language. */
function ruleRows(
  entry: JBRulesetWithMetadata,
  chainId: JBChainId,
  tokenSymbol: string,
  contexts: readonly AccountingContext[] | undefined,
): RuleRow[] {
  const { ruleset: r, metadata: m } = entry
  const base = baseCurrencyLabel(m.baseCurrency, contexts)
  return [
    { section: 'Cycle', label: 'Start', value: formatDateTime(r.start) },
    {
      section: 'Cycle',
      label: 'Duration',
      value: r.duration > 0 ? formatDuration(r.duration) : 'Not set',
      hint: r.duration > 0 ? undefined : 'Rules last until changed',
    },
    {
      section: 'Cycle',
      label: 'Rule change deadline',
      value: approvalHookLabel(chainId, r.approvalHook) ?? 'None',
    },
    {
      section: 'Token',
      label: 'Issuance',
      value:
        r.weight > 0n
          ? `${formatTokenAmount(r.weight, 18, 2)} ${tokenSymbol} per ${base}`
          : 'No new tokens for payments',
    },
    {
      section: 'Token',
      label: 'Issuance cut',
      value:
        r.weightCutPercent > 0
          ? `Rate drops ${billionthsToPct(r.weightCutPercent)} each cycle`
          : 'None',
    },
    {
      section: 'Token',
      label: 'Reserved issuance',
      value:
        m.reservedPercent > 0
          ? basisPoints(m.reservedPercent)
          : 'None',
      hint:
        m.reservedPercent > 0
          ? 'This share of the issuance rate above is set aside for the recipients below — payers receive the rest.'
          : undefined,
    },
    {
      section: 'Token',
      label: 'Cashing out',
      value:
        m.cashOutTaxRate >= 10_000
          ? 'Disabled'
          : m.cashOutTaxRate > 0
          ? `Taxed ${basisPoints(m.cashOutTaxRate)}`
          : 'No tax',
    },
    {
      section: 'Token',
      label: 'Token transfers',
      value: m.pauseCreditTransfers ? 'Paused' : 'Allowed',
    },
    {
      section: 'Token',
      label: 'Owner minting',
      value: m.allowOwnerMinting ? 'Allowed' : 'Not allowed',
    },
    {
      section: 'Other rules',
      label: 'Payments',
      value: m.pausePay ? 'Paused' : 'Open',
    },
    {
      section: 'Other rules',
      label: 'Payout authority',
      value: m.ownerMustSendPayouts ? 'Owner only' : 'Anyone',
    },
    {
      section: 'Other rules',
      label: 'Hold fees',
      value: m.holdFees ? 'Yes' : 'No',
    },
    {
      section: 'Other rules',
      label: 'Change payment terminals',
      value: m.allowSetTerminals ? 'Allowed' : 'Not allowed',
    },
    {
      section: 'Other rules',
      label: 'Change controller',
      value: m.allowSetController ? 'Allowed' : 'Not allowed',
    },
    {
      section: 'Other rules',
      label: 'Migrate terminals',
      value: m.allowTerminalMigration ? 'Allowed' : 'Not allowed',
    },
    {
      section: 'Other rules',
      label: 'Set a custom token',
      value: m.allowSetCustomToken ? 'Allowed' : 'Not allowed',
    },
    {
      section: 'Other rules',
      label: 'Add accounting tokens',
      value: m.allowAddAccountingContext ? 'Allowed' : 'Not allowed',
    },
    {
      section: 'Other rules',
      label: 'Add price feeds',
      value: m.allowAddPriceFeed ? 'Allowed' : 'Not allowed',
    },
  ]
}

function formatLimits(
  limits: readonly CurrencyAmount[],
  ctx: AccountingContext,
): string {
  if (!limits.length) return 'None'
  return limits
    .map(limit => {
      const isTokenKeyed =
        limit.currency === ctx.currency ||
        limit.currency === tokenCurrencyId(ctx.token)
      const symbol =
        limit.currency === 1
          ? 'ETH'
          : limit.currency === USD_CURRENCY_ID(6)
            ? 'USD'
            : isTokenKeyed
              ? ctx.symbol
              : `currency ${limit.currency}`
      // A limit in the token's OWN currency uses the token's decimals; a
      // limit in a base currency (ETH/USD) is 18-dec fixed point (JB's price
      // fidelity), NOT the token's decimals — else a USD limit on 6-dec USDC
      // reads 1e12× too large.
      const dec = isTokenKeyed ? ctx.decimals : 18
      return limit.amount >= UNLIMITED_FLOOR
        ? `Unlimited ${symbol}`
        : `${formatTokenAmount(limit.amount, dec)} ${symbol}`
    })
    .join(' + ')
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-smoke-700">{label}</dt>
      <dd className="text-right font-medium text-ink">{value}</dd>
    </div>
  )
}

function StackedRule({
  label,
  value,
  hint,
}: {
  label: string
  value: ReactNode
  hint?: ReactNode
}) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-smoke-500">{label}</dt>
      <dd className="mt-1 text-left font-medium leading-snug text-ink">
        {value}
      </dd>
      {hint ? (
        <p className="mt-1 text-xs leading-snug text-smoke-500">{hint}</p>
      ) : null}
    </div>
  )
}

function Pip() {
  return (
    <span aria-hidden className="mx-2 text-smoke-300">
      |
    </span>
  )
}

function ArrowButton({
  direction,
  disabled,
  onClick,
}: {
  direction: 'prev' | 'next'
  disabled: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={direction === 'prev' ? 'Earlier ruleset' : 'Later ruleset'}
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-smoke-300 text-smoke-700 transition-colors hover:border-smoke-400 hover:text-ink disabled:opacity-40"
    >
      <svg
        viewBox="0 0 24 24"
        className="h-4 w-4"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        {direction === 'prev' ? <path d="m15 6-6 6 6 6" /> : <path d="m9 6 6 6-6 6" />}
      </svg>
    </button>
  )
}

function SplitsList({
  splits,
  chainId,
}: {
  splits: readonly RawSplit[]
  chainId: JBChainId
}) {
  const host = JB_CHAINS[chainId]?.etherscanHostname
  const total = splits.reduce((sum, sp) => sum + sp.percent, 0)
  const leftover = 1e9 - total

  const recipient = (sp: RawSplit): ReactNode => {
    if (sp.hook !== zeroAddress) return `Hook ${truncateAddress(sp.hook)}`
    if (sp.projectId > 0n) return `Project #${sp.projectId}`
    if (sp.beneficiary.toLowerCase() === BURN_ADDRESS) return 'Burn'
    if (host) {
      return (
        <a
          href={`https://${host}/address/${sp.beneficiary}`}
          target="_blank"
          rel="noopener noreferrer"
          className="hover:underline"
        >
          {truncateAddress(sp.beneficiary)}
        </a>
      )
    }
    return truncateAddress(sp.beneficiary)
  }

  return (
    <dl className="mt-2 space-y-1.5 text-sm">
      {splits.map((sp, i) => (
        <div key={i} className="flex items-baseline justify-between gap-3">
          <dt className="min-w-0 text-smoke-700">
            {recipient(sp)}
            {sp.lockedUntil > 0 ? (
              <span className="block text-xs text-smoke-500">
                Locked until {formatDate(sp.lockedUntil)}
              </span>
            ) : null}
          </dt>
          <dd className="font-medium text-ink">{billionthsToPct(sp.percent)}</dd>
        </div>
      ))}
      {splits.length === 0 || leftover > 0 ? (
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-smoke-700">Project owner</dt>
          <dd className="font-medium text-ink">
            {splits.length === 0 ? '100%' : billionthsToPct(leftover)}
          </dd>
        </div>
      ) : null}
    </dl>
  )
}

/**
 * Rulesets tab for custom (non-revnet) projects (website/ parity:
 * renderRulesetsFundsSection, read-only). Cycle carousel over past, current,
 * and upcoming rulesets; rules grid; per-token funds access; payout and
 * reserved splits.
 */
export function RulesetsTab({
  chainId,
  projectId,
  chains,
}: {
  chainId: JBChainId
  projectId: number
  chains: readonly [number, number][]
}) {
  const publicClient = usePublicClient({ chainId }) as PublicClient | undefined
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null)

  const projectChains = useMemo(() => {
    const source = chains.length ? chains : [[chainId, projectId]]
    return Array.from(
      new Map(
        source.map(([id, pid]) => [
          id,
          [id as JBChainId, pid] as const,
        ]),
      ).values(),
    )
  }, [chainId, chains, projectId])
  const projectChainsKey = projectChains
    .map(([id, pid]) => `${id}:${pid}`)
    .join('|')

  const chainMeta = JB_CHAINS[chainId]
  const nativeSymbol = chainMeta?.nativeTokenSymbol ?? 'ETH'

  const {
    data: rulesets,
    isLoading,
    isError,
  } = useQuery({
    queryKey: ['rulesetsTab', chainId, projectId],
    enabled: !!publicClient,
    staleTime: 60_000,
    retry: 1,
    queryFn: async () => {
      const args = { chainId, projectId: BigInt(projectId) }
      const [current, upcoming, all] = await Promise.all([
        getCurrentRuleset(publicClient!, args),
        getUpcomingRuleset(publicClient!, args).catch(() => null),
        // One paged read covers past cycles too — cheap, so include them.
        getAllRulesets(publicClient!, { ...args, size: 50n }).catch(
          () => [] as readonly JBRulesetWithMetadata[],
        ),
      ])
      return { current, upcoming, all }
    },
  })

  const { data: contexts } = useQuery({
    queryKey: ['rulesetsTabContexts', chainId, projectId],
    enabled: !!publicClient,
    staleTime: 5 * 60_000,
    retry: 1,
    queryFn: async (): Promise<AccountingContext[]> => {
      const raw = await getAccountingContexts(publicClient!, {
        chainId,
        projectId: BigInt(projectId),
      }).catch(() => [])
      return Promise.all(
        raw.map(async ctx => ({
          ...ctx,
          symbol: await tokenSymbol(publicClient!, ctx.token, { nativeSymbol }),
        })),
      )
    },
  })

  const { data: projectTokenSymbol } = useQuery({
    queryKey: ['rulesetsTabTokenSymbol', chainId, projectId],
    enabled: !!publicClient,
    staleTime: 5 * 60_000,
    retry: 1,
    queryFn: async () => {
      const token = await publicClient!.readContract({
        address: v6Address('JBTokens', chainId),
        abi: jbTokensAbi,
        functionName: 'tokenOf',
        args: [BigInt(projectId)],
      })
      if (!token || token === zeroAddress) return null
      return publicClient!
        .readContract({ address: token, abi: erc20Abi, functionName: 'symbol' })
        .catch(() => null)
    },
  })
  const sym = projectTokenSymbol ?? 'tokens'

  const { data: chainRulesets, isLoading: chainRulesetsLoading } = useQuery({
    queryKey: ['rulesetsTabCrossChain', projectChainsKey],
    enabled: projectChains.length > 1,
    staleTime: 60_000,
    retry: 1,
    queryFn: async (): Promise<ChainRulesetSnapshot[]> =>
      Promise.all(
        projectChains.map(async ([snapshotChainId, snapshotProjectId]) => {
          try {
            const client = getPublicClient(wagmiConfig, {
              chainId: snapshotChainId,
            }) as PublicClient | undefined
            if (!client) throw new Error('No public client')
            const ruleset = await getCurrentRuleset(client, {
              chainId: snapshotChainId,
              projectId: BigInt(snapshotProjectId),
            })
            return {
              chainId: snapshotChainId,
              projectId: snapshotProjectId,
              ruleset: ruleset.ruleset.id === 0 ? null : ruleset,
              error: ruleset.ruleset.id === 0,
            }
          } catch {
            return {
              chainId: snapshotChainId,
              projectId: snapshotProjectId,
              ruleset: null,
              error: true,
            }
          }
        }),
      ),
  })

  const entries = useMemo((): Entry[] => {
    if (!rulesets || rulesets.current.ruleset.id === 0) return []
    const { current, upcoming, all } = rulesets
    const past = all
      .filter(
        e =>
          e.ruleset.id !== current.ruleset.id &&
          e.ruleset.start < current.ruleset.start,
      )
      .sort((a, b) => a.ruleset.start - b.ruleset.start)
      .map((data): Entry => ({ data, tag: 'Past' }))
    const out: Entry[] = [...past, { data: current, tag: 'Current' }]
    // A zero id means "nothing distinct queued" (the simulated next cycle).
    if (
      upcoming &&
      upcoming.ruleset.id !== 0 &&
      upcoming.ruleset.id !== current.ruleset.id
    ) {
      out.push({ data: upcoming, tag: 'Upcoming' })
    }
    return out
  }, [rulesets])

  const currentIdx = entries.findIndex(e => e.tag === 'Current')
  const idx =
    selectedIdx !== null && selectedIdx >= 0 && selectedIdx < entries.length
      ? selectedIdx
      : currentIdx
  const selected = idx >= 0 ? entries[idx] : undefined
  const current = currentIdx >= 0 ? entries[currentIdx] : undefined
  const upcoming = entries.find(e => e.tag === 'Upcoming')

  const rulesetId = selected?.data.ruleset.id ?? 0

  const { data: fundsAccess, isError: fundsFailed } = useQuery({
    queryKey: [
      'rulesetsTabFunds',
      chainId,
      projectId,
      rulesetId,
      contexts?.length ?? -1,
    ],
    enabled: !!publicClient && !!contexts && rulesetId > 0,
    staleTime: 60_000,
    retry: 1,
    queryFn: async () => {
      const limitsAddr = v6Address('JBFundAccessLimits', chainId)
      const splitsAddr = v6Address('JBSplits', chainId)
      const terminal = v6Address('JBMultiTerminal', chainId)
      const pid = BigInt(projectId)
      const rid = BigInt(rulesetId)
      const perToken = await Promise.all(
        contexts!.map(async ctx => {
          const [payoutLimits, surplusAllowances, payoutSplits] =
            await Promise.all([
              publicClient!.readContract({
                address: limitsAddr,
                abi: jbFundAccessLimitsAbi,
                functionName: 'payoutLimitsOf',
                args: [pid, rid, terminal, ctx.token],
              }),
              publicClient!.readContract({
                address: limitsAddr,
                abi: jbFundAccessLimitsAbi,
                functionName: 'surplusAllowancesOf',
                args: [pid, rid, terminal, ctx.token],
              }),
              publicClient!.readContract({
                address: splitsAddr,
                abi: jbSplitsAbi,
                functionName: 'splitsOf',
                args: [pid, rid, payoutSplitGroupId(ctx.token)],
              }),
            ])
          return { ctx, payoutLimits, surplusAllowances, payoutSplits }
        }),
      )
      const reservedSplits = await publicClient!.readContract({
        address: v6Address('JBSplits', chainId),
        abi: jbSplitsAbi,
        functionName: 'splitsOf',
        args: [pid, rid, RESERVED_TOKEN_SPLIT_GROUP_ID],
      })
      return { perToken, reservedSplits }
    },
  })

  if (isLoading) {
    return <RulesetsTabSkeleton />
  }
  if (isError || !selected || !current) {
    return (
      <div className="card p-6">
        <span className="field-label">Rulesets</span>
        <p className="mt-2 text-sm text-smoke-700">
          {isError
            ? 'Couldn’t load this project’s rulesets right now.'
            : 'No rulesets found onchain.'}
        </p>
      </div>
    )
  }

  const { ruleset: r } = selected.data
  const now = Math.floor(Date.now() / 1000)
  const rows = ruleRows(selected.data, chainId, sym, contexts)

  const status = approvalHookLabel(chainId, r.approvalHook) ?? 'Unlocked'
  const timing =
    selected.tag === 'Current' && r.duration > 0
      ? r.start + r.duration > now
        ? `${formatCountdown(r.start + r.duration - now)} left in this cycle`
        : 'Cycle ended'
      : r.duration > 0
        ? `Duration: ${formatDuration(r.duration)}`
        : 'No duration'

  // What changes when the queued ruleset takes effect (start always differs,
  // so it's skipped).
  const currentRows = ruleRows(current.data, chainId, sym, contexts)
  const upcomingChanges = upcoming
    ? ruleRows(upcoming.data, chainId, sym, contexts)
        .map((row, i) => ({ row, from: currentRows[i] }))
        .filter(
          ({ row, from }) => row.label !== 'Start' && row.value !== from.value,
        )
    : []

  const isCurrent = selected.tag === 'Current'

  return (
    <div className="space-y-5">
      <QueueRulesetFlow
        chainId={chainId}
        projectId={projectId}
        isRevnet={false}
      />
      <div className="card p-6">
        <div className="flex items-center justify-center gap-4">
          <ArrowButton
            direction="prev"
            disabled={idx <= 0}
            onClick={() => setSelectedIdx(idx - 1)}
          />
          <div className="text-center">
            <h2 className="font-agrandir text-xl font-medium">
              Cycle #{r.cycleNumber}
              <span className="ml-2 text-sm font-normal text-smoke-500">
                {selected.tag}
              </span>
            </h2>
          </div>
          <ArrowButton
            direction="next"
            disabled={idx >= entries.length - 1}
            onClick={() => setSelectedIdx(idx + 1)}
          />
        </div>
        <p className="mt-2 text-center text-sm text-smoke-700">
          {status}
          <Pip />
          {timing}
          {r.id > 0 ? (
            <Fragment>
              <Pip />
              ID {r.id}
            </Fragment>
          ) : null}
        </p>

        {isCurrent && projectChains.length > 1 ? (
          <RulesetChainStatus
            snapshots={chainRulesets}
            loading={chainRulesetsLoading}
          />
        ) : null}

        {selected.tag === 'Current' && upcomingChanges.length > 0 && upcoming ? (
          <div className="callout callout-warning mt-4 text-xs">
            <p className="font-medium">
              Rule changes coming
              {upcoming.data.ruleset.start > now
                ? ` in ${formatCountdown(upcoming.data.ruleset.start - now)} (${formatDateTime(upcoming.data.ruleset.start)})`
                : ' when the queued cycle starts'}
              :
            </p>
            <ul className="mt-1.5 space-y-1">
              {upcomingChanges.map(({ row, from }) => (
                <li key={`${row.section}-${row.label}`}>
                  {row.label}: {from.value} → {row.value}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <section className="mt-7 border-t border-smoke-200 pt-6">
          <span className="field-label">Cycle</span>
          <dl className="mt-3 grid grid-cols-1 gap-x-7 gap-y-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
            {rows
              .filter(row => row.section === 'Cycle')
              .map(row => (
                <StackedRule
                  key={row.label}
                  label={row.label}
                  value={row.value}
                  hint={row.hint}
                />
              ))}
          </dl>
        </section>

        <section className="mt-7 border-t border-smoke-200 pt-6">
          <span className="field-label">Token rules</span>
          <dl className="mt-3 grid grid-cols-1 gap-x-7 gap-y-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
            {rows
              .filter(
                row => row.section === 'Token' && row.label !== 'Reserved issuance',
              )
              .map(row => (
                <StackedRule
                  key={row.label}
                  label={row.label}
                  value={row.value}
                  hint={row.hint}
                />
              ))}
          </dl>
          <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="rounded-xl border border-smoke-200 bg-smoke-25 p-5">
              <dl className="text-sm">
                {rows
                  .filter(
                    row => row.section === 'Token' && row.label === 'Reserved issuance',
                  )
                  .map(row => (
                    <StackedRule
                      key={row.label}
                      label={row.label}
                      value={row.value}
                      hint={row.hint}
                    />
                  ))}
              </dl>
              {contexts && contexts.length > 0 ? (
                <div className="mt-5 border-t border-smoke-200 pt-5">
                  <span className="field-label">Recipients</span>
                {fundsAccess ? (
                  <SplitsList
                    splits={fundsAccess.reservedSplits}
                    chainId={chainId}
                  />
                ) : (
                  fundsFailed ? (
                    <p className="mt-2 text-sm text-smoke-500">
                      Couldn’t verify reserved recipients.
                    </p>
                  ) : (
                    <SkeletonTable rows={3} columns={2} className="mt-3" />
                  )
                )}
                {isCurrent && rulesetId > 0 ? (
                  <div className="mt-3">
                    <EditSplitsFlow
                      chainId={chainId}
                      projectId={projectId}
                      groupId={RESERVED_TOKEN_SPLIT_GROUP_ID}
                      title="reserved recipients"
                      rulesetId={BigInt(rulesetId)}
                    />
                  </div>
                ) : null}
                </div>
              ) : null}
            </div>
          </div>
        </section>

        {contexts && contexts.length > 0 ? (
          <section className="mt-7 border-t border-smoke-200 pt-6">
            <span className="field-label">Funds access</span>
            <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
            {contexts.map(ctx => {
              const fa = fundsAccess?.perToken.find(
                t => t.ctx.token === ctx.token,
              )
              const hasPayouts =
                fa?.payoutLimits.some(limit => limit.amount > 0n) ?? false
              return (
                <div
                  key={ctx.token}
                  className="rounded-xl border border-smoke-200 bg-smoke-25 p-5"
                >
                  <span className="field-label">{ctx.symbol} funds access</span>
                  <dl className="mt-2 space-y-1.5 text-sm">
                    <Row
                      label="Payout limit per cycle"
                      value={
                        fa
                          ? formatLimits(fa.payoutLimits, ctx)
                          : fundsFailed
                            ? '—'
                            : '…'
                      }
                    />
                    <Row
                      label="Surplus allowance"
                      value={
                        fa
                          ? formatLimits(fa.surplusAllowances, ctx)
                          : fundsFailed
                            ? '—'
                            : '…'
                      }
                    />
                  </dl>
                  {hasPayouts && fa ? (
                    <div className="mt-5 border-t border-smoke-200 pt-5">
                      <span className="field-label block">
                        {ctx.symbol} payout splits
                      </span>
                      <SplitsList splits={fa.payoutSplits} chainId={chainId} />
                      {isCurrent && rulesetId > 0 ? (
                        <EditSplitsFlow
                          chainId={chainId}
                          projectId={projectId}
                          groupId={payoutSplitGroupId(ctx.token)}
                          title={`${ctx.symbol} payout splits`}
                          rulesetId={BigInt(rulesetId)}
                        />
                      ) : null}
                    </div>
                  ) : null}
                </div>
              )
            })}
            </div>
          </section>
        ) : null}

        <section className="mt-7 border-t border-smoke-200 pt-6">
          <span className="field-label">Other rules</span>
          <dl className="mt-3 grid grid-cols-1 gap-x-7 gap-y-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
            {rows
              .filter(row => row.section === 'Other rules')
              .map(row => (
                <StackedRule
                  key={row.label}
                  label={row.label}
                  value={row.value}
                  hint={row.hint}
                />
              ))}
          </dl>
        </section>
      </div>
    </div>
  )
}
