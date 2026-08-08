'use client'

import {
  JB_CHAINS,
  NATIVE_TOKEN,
  USD_CURRENCY_ID,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import {
  getAccountingContexts,
  getAllRulesets,
  getCurrentRuleset,
  type JBRulesetWithMetadata,
} from '@bananapus/nana-sdk-core/v6'
import { useQuery } from '@tanstack/react-query'
import { erc20Abi, type PublicClient } from 'viem'
import { usePublicClient } from 'wagmi'
import { useProjectTokenSymbol } from '@/hooks/useProjectTokenSymbol'
import { TermsTabSkeleton } from '@/components/LoadingSkeletons'
import {
  billionthsToPct,
  fmtPct,
  formatCountdown,
  formatDate,
  formatTokenAmount,
  truncateAddress,
} from '@/lib/format'
import { IssuanceLadder } from './IssuanceLadder'
import { PERSIST } from '@/lib/query-persist'
import { ConceptTerm } from '@/components/project/ConceptTerm'
import { PROTOCOL_CONCEPTS } from '@/lib/protocol-concepts'

/** Ruleset percents are basis points of 10,000: 3800 → "38%". */
function basisPoints(bp: number): string {
  return fmtPct(bp / 100)
}

function cutCadence(durationSecs: number): string {
  const days = durationSecs / 86400
  if (days >= 1) {
    const v = days % 1 === 0 ? String(days) : days.toFixed(1)
    return days === 1 ? 'day' : `${v} days`
  }
  const hours = Math.max(1, Math.round(durationSecs / 3600))
  return hours === 1 ? 'hour' : `${hours} hours`
}

/**
 * Terms tab for revnets: every queued ruleset is a stage. Issuance summary
 * on top, then the per-stage terms table (website/ parity:
 * renderStagesSection, read-only — no projected-issuance chart).
 */
export function TermsTab({
  chainId,
  projectId,
}: {
  chainId: JBChainId
  projectId: number
}) {
  const publicClient = usePublicClient({ chainId }) as PublicClient | undefined
  const nativeSymbol = JB_CHAINS[chainId]?.nativeTokenSymbol ?? 'ETH'

  const { data, isLoading, isError } = useQuery({
    queryKey: ['termsTab', chainId, projectId],
    meta: PERSIST,
    enabled: !!publicClient,
    staleTime: 60_000,
    retry: 1,
    queryFn: async () => {
      const args = { chainId, projectId: BigInt(projectId) }
      const [all, current, contexts] = await Promise.all([
        getAllRulesets(publicClient!, { ...args, size: 50n }),
        getCurrentRuleset(publicClient!, args).catch(() => null),
        getAccountingContexts(publicClient!, args).catch(
          () => [] as const,
        ),
      ])
      // The base currency can be token-keyed (uint32(uint160(token)), e.g. a
      // USDC-based revnet) — resolve those to the token's symbol.
      const contextSymbols = await Promise.all(
        contexts.map(async ctx => ({
          currency: ctx.currency,
          symbol:
            ctx.token.toLowerCase() === NATIVE_TOKEN.toLowerCase()
              ? nativeSymbol
              : await publicClient!
                  .readContract({
                    address: ctx.token,
                    abi: erc20Abi,
                    functionName: 'symbol',
                  })
                  .catch(() => truncateAddress(ctx.token)),
        })),
      )
      return { all, current, contextSymbols }
    },
  })

  // The revnet's OWN token symbol (bendystraw's tokenSymbol is the
  // accounting token — "ETH per ETH" would be nonsense).
  const { data: projectToken } = useProjectTokenSymbol(chainId, projectId)
  const sym = projectToken?.symbol || 'tokens'

  if (isLoading) {
    return <TermsTabSkeleton />
  }

  const stages: readonly JBRulesetWithMetadata[] = (data?.all ?? [])
    .slice()
    .sort((a, b) => a.ruleset.start - b.ruleset.start)

  if (isError || stages.length === 0) {
    return (
      <div className="card p-6">
        <span className="field-label">Terms</span>
        <p className="mt-2 text-sm text-smoke-700">
          {isError ? 'Couldn’t read stages right now.' : 'No stages found onchain.'}
        </p>
      </div>
    )
  }

  const now = Math.floor(Date.now() / 1000)
  const baseCurrencyLabel = (currency: number): string => {
    if (currency === 1) return 'ETH'
    if (currency === USD_CURRENCY_ID(6)) return 'USD'
    const match = data?.contextSymbols.find(c => c.currency === currency)
    return match ? match.symbol : `currency ${currency}`
  }

  // The active stage: the latest one that has started. currentRulesetOf's id
  // matches its stored stage, with weight cuts already applied to the weight.
  const activeIdx = Math.max(
    0,
    stages.findLastIndex(s => s.ruleset.start <= now),
  )
  const firstStageStarted = stages[0].ruleset.start <= now
  const current = data?.current && data.current.ruleset.id !== 0 ? data.current : null
  const live = current ?? stages[activeIdx]
  const base = baseCurrencyLabel(live.metadata.baseCurrency)

  const rate = live.ruleset.weight
  const cutPct = live.ruleset.weightCutPercent
  const duration = live.ruleset.duration
  const reserved = live.metadata.reservedPercent
  // currentRulesetOf's start is the current cycle's start, so the next cut
  // lands one duration later.
  const nextCutIn = current
    ? current.ruleset.start + current.ruleset.duration - now
    : 0
  const nextRate = (rate * BigInt(1e9 - cutPct)) / BigInt(1e9)

  return (
    <div className="space-y-5">
      <div className="card p-6">
        <span className="field-label">Token issuance</span>
        <p className="mt-2 font-agrandir text-2xl font-medium">
          {rate > 0n ? (
            <>
              {formatTokenAmount(rate, 18, 2)} {sym}
              <span className="ml-2 text-base font-normal text-smoke-500">
                per {base}
              </span>
            </>
          ) : (
            'No issuance'
          )}
        </p>
        <div className="mt-2 space-y-1 text-sm text-smoke-700">
          {rate > 0n ? (
            cutPct > 0 && duration > 0 ? (
              <p>
                Cuts to {formatTokenAmount(nextRate, 18, 2)} {sym} per {base}
                {current && nextCutIn > 0
                  ? ` in ${formatCountdown(nextCutIn)}`
                  : ' at the next cycle'}
                .
              </p>
            ) : (
              <p>Fixed rate — no scheduled cut.</p>
            )
          ) : null}
          <p>
            {reserved > 0
              ? `${basisPoints(reserved)} of new tokens go to splits.`
              : 'All new tokens go to supporters — nothing is split off.'}
          </p>
          {!firstStageStarted ? (
            <p>Stage 1 starts {formatDate(stages[0].ruleset.start)}.</p>
          ) : null}
        </div>
        <IssuanceLadder
          stages={stages.map(s => ({
            start: s.ruleset.start,
            duration: s.ruleset.duration,
            weight: s.ruleset.weight,
            weightCutPercent: s.ruleset.weightCutPercent,
          }))}
          symbol={sym}
          baseSymbol={base}
        />
      </div>

      <div className="card p-5">
        <span className="field-label">Stages</span>
        <div
          className="mt-3 overflow-x-auto"
          role="region"
          aria-label="Revnet stages"
          tabIndex={0}
        >
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-smoke-500">
                <th className="pb-2 pl-3 pr-4 font-medium">Stage</th>
                <th className="pb-2 pr-4 font-medium">Period</th>
                <th className="pb-2 pr-4 font-medium">
                  Issuance
                  <span className="block whitespace-nowrap">
                    ({sym} per {base})
                  </span>
                </th>
                <th className="pb-2 pr-4 font-medium">Split limit</th>
                <th className="pb-2 font-medium">
                  <ConceptTerm note={PROTOCOL_CONCEPTS.cashOutTax}>Cash out tax</ConceptTerm>
                </th>
              </tr>
            </thead>
            <tbody>
              {stages.map((stage, i) => {
                const { ruleset: r, metadata: m } = stage
                const nextStart =
                  i + 1 < stages.length ? stages[i + 1].ruleset.start : null
                const isActive = i === activeIdx && firstStageStarted
                return (
                  <tr
                    key={r.id}
                    className={`border-t border-smoke-200 align-top ${
                      isActive ? 'bg-bluebs-25' : ''
                    }`}
                  >
                    <td className="py-2.5 pl-3 pr-4">
                      <span className="font-medium text-ink">{i + 1}</span>
                      {isActive ? (
                        <span className="ml-2 rounded-full bg-bluebs-100 px-2 py-0.5 text-[10px] font-medium text-bluebs-700">
                          Active
                        </span>
                      ) : null}
                    </td>
                    <td className="py-2.5 pr-4">
                      <span className="block whitespace-nowrap text-ink">
                        <span className="text-smoke-500">Start:</span>{' '}
                        {formatDate(r.start)}
                      </span>
                      <span className="block whitespace-nowrap text-ink">
                        <span className="text-smoke-500">End:</span>{' '}
                        {nextStart ? formatDate(nextStart) : 'never'}
                      </span>
                      {nextStart ? (
                        <span className="block text-xs text-smoke-500">
                          Duration:{' '}
                          {Math.round((nextStart - r.start) / 86400)} days
                        </span>
                      ) : null}
                    </td>
                    <td className="py-2.5 pr-4">
                      <span className="font-medium text-ink">
                        {r.weight > 0n ? formatTokenAmount(r.weight, 18, 2) : '0'}
                      </span>
                      {r.weightCutPercent > 0 && r.duration > 0 ? (
                        <span className="block text-xs text-smoke-500">
                          cut {billionthsToPct(r.weightCutPercent)} every{' '}
                          {cutCadence(r.duration)}
                        </span>
                      ) : null}
                    </td>
                    <td className="py-2.5 pr-4 text-ink">
                      {basisPoints(m.reservedPercent)}
                    </td>
                    <td className="py-2.5 text-ink">
                      {basisPoints(m.cashOutTaxRate)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
