'use client'

import type { JBChainId } from '@bananapus/nana-sdk-core'
import { useQueries } from '@tanstack/react-query'
import type { PublicClient } from 'viem'
import { useConfig } from 'wagmi'
import { getPublicClient } from 'wagmi/actions'
import { useHydrated } from '@/hooks/useKeptQuery'
import { indexedAmountsTrusted } from '@/lib/indexed-amounts-trusted'
import { accountingContextsQuery } from '@/lib/project-display-queries'

/**
 * TEMPORARY: see indexedAmountsTrusted. Reads each deployment's live
 * accounting contexts and applies that rule.
 *
 * Returns undefined while the reads are pending, and until hydration so the
 * first client render matches the server's.
 */
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
