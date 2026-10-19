'use client'

import type { JBChainId } from '@bananapus/nana-sdk-core'
import { useQueries } from '@tanstack/react-query'
import type { PublicClient } from 'viem'
import { useConfig } from 'wagmi'
import { getPublicClient } from 'wagmi/actions'
import { useHydrated } from '@/hooks/useKeptQuery'
import { accountingContextsQuery } from '@/lib/project-display-queries'

/**
 * TEMPORARY: remove once Bendystraw records each event's token.
 *
 * V6 pay, add-to-balance, cash-out and payout events carry no token, so
 * Bendystraw labels and prices every one with the project's last-set
 * accounting context. A project that accepts more than one token then gets
 * wrong amounts, symbols and USD values (a 0.0001 ETH payment indexed as
 * 100,000,000 USDC). Those figures are only shown when every deployment's
 * live accounting contexts were read and none has more than one.
 *
 * Returns undefined while the reads are pending, and until hydration so the
 * first client render matches the server's.
 */
export function indexedAmountsTrusted(
  contextCounts: readonly (number | null | undefined)[],
): boolean | undefined {
  if (contextCounts.some(count => count != null && count > 1)) return false
  if (contextCounts.some(count => count === undefined)) return undefined
  return contextCounts.every(count => count != null)
}

export function useIndexedAmountsTrusted(
  chains: readonly [number, number][],
): boolean | undefined {
  const config = useConfig()
  const hydrated = useHydrated()
  const results = useQueries({
    queries: chains.map(([rawChainId, rawProjectId]) => {
      const chainId = rawChainId as JBChainId
      const project = { chainId, projectId: BigInt(rawProjectId) }
      const client = getPublicClient(config, { chainId }) as PublicClient | undefined
      return client
        ? accountingContextsQuery(client, project)
        : {
            queryKey: ['indexedAmountsTrusted', 'noClient', rawChainId],
            queryFn: (): never => {
              throw new Error(`No RPC client for chain ${rawChainId}`)
            },
            retry: false,
          }
    }),
  })
  if (!hydrated) return undefined
  // A failed read is null: unknown never counts as trusted.
  return indexedAmountsTrusted(
    results.map(result =>
      result.isError ? null : result.data ? result.data.length : undefined,
    ),
  )
}
