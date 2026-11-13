'use client'

import { type JBChainId } from '@bananapus/nana-sdk-core'
import { useQuery } from '@tanstack/react-query'
import type { PublicClient } from 'viem'
import { usePublicClient } from 'wagmi'
import { formatCountdown, formatDateTime } from '@/lib/format'
import { currentRulesetQuery, upcomingRulesetQuery } from '@/lib/project-display-queries'

/**
 * The line shown above the pay card when different rules are queued, or null.
 * A zero or unchanged id means nothing distinct is queued (the simulated next cycle).
 */
export function rulesChangeLine(
  currentId: number | undefined,
  upcoming: { id: number; start: number } | undefined,
  now: number,
): string | null {
  if (!currentId || !upcoming || upcoming.id === 0 || upcoming.id === currentId) return null
  return upcoming.start > now
    ? `Rules change in ${formatCountdown(upcoming.start - now)} (${formatDateTime(upcoming.start)})`
    : 'Rules change when the queued cycle starts'
}

/** Tells a payer the rules are about to change, with a link to what changes. */
export function RulesChangeNotice({
  chainId,
  projectId,
  isRevnet,
}: {
  chainId: JBChainId
  projectId: number
  isRevnet: boolean
}) {
  const publicClient = usePublicClient({ chainId }) as PublicClient | undefined
  const args = { chainId, projectId: BigInt(projectId) }
  const current = useQuery({ ...currentRulesetQuery(publicClient!, args), enabled: !!publicClient })
  const upcoming = useQuery({ ...upcomingRulesetQuery(publicClient!, args), enabled: !!publicClient })
  const line = rulesChangeLine(
    current.data?.ruleset.id,
    upcoming.data?.ruleset,
    Math.floor(Date.now() / 1000),
  )
  if (!line) return null
  return (
    <a
      href={isRevnet ? '#terms' : '#rulesets'}
      className="mb-4 block text-xs font-medium text-smoke-700 underline underline-offset-2 hover:text-ink"
    >
      {line}
    </a>
  )
}
