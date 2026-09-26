'use client'

import { useQuery } from '@tanstack/react-query'
import { getPublicClient } from '@wagmi/core'
import type { PublicClient } from 'viem'
import { useConfig } from 'wagmi'
import { resolvedAddress } from '@/lib/ens'
import { checkStickyToken } from '@/lib/sticky-check'
import {
  stickyDraftGroupId,
  stickyGroupDraftError,
  stickyRecipientLabel,
  type StickyGroupDraft,
} from '@/lib/sticky'

/**
 * A Sticky row's summary, "Sticky holders stuck 4 to 52 weeks → STICKY", and
 * whether its token is a registered Sticky token on every chain it targets.
 * Submission re-runs the same check; this line is the early warning.
 */
export function StickyTokenStatus({
  row,
  chainIds,
}: {
  row: StickyGroupDraft & { beneficiary: string }
  chainIds: readonly number[]
}) {
  const config = useConfig()
  const token = resolvedAddress(row.beneficiary)
  const groupError = stickyGroupDraftError(row)
  const check = useQuery({
    queryKey: ['stickyToken', token?.toLowerCase(), chainIds.join(',')],
    enabled: !!token && chainIds.length > 0,
    staleTime: 60_000,
    queryFn: async () => {
      const checks = await Promise.all(
        chainIds.map(chainId => {
          const client = getPublicClient(config, {
            chainId: chainId as (typeof config.chains)[number]['id'],
          }) as PublicClient | undefined
          if (!client) return { ok: false as const, reason: 'Could not connect to every chain.' }
          return checkStickyToken(client, chainId, token!)
        }),
      )
      const failed = checks.find(item => !item.ok)
      if (failed && !failed.ok) return { symbol: null, reason: failed.reason }
      const first = checks[0]
      return { symbol: first?.ok ? first.symbol : null, reason: null }
    },
  })

  if (!token) return null
  const reason = groupError && row.stickyMinWeeks.trim() ? groupError : check.data?.reason
  return (
    <div className="mt-1.5 space-y-0.5 text-[11px] leading-relaxed">
      {groupError ? null : (
        <p className="text-smoke-700">
          {stickyRecipientLabel(
            { projectId: stickyDraftGroupId(row), beneficiary: token },
            check.data?.symbol,
          )}
        </p>
      )}
      {reason ? (
        <p role="alert" className="text-error-600">{reason}</p>
      ) : check.isPending ? (
        <p className="text-smoke-500">Checking the Sticky token…</p>
      ) : check.isError ? (
        <p role="alert" className="text-error-600">Could not check the Sticky token.</p>
      ) : null}
    </div>
  )
}
