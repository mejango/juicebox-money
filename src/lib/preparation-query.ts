import type { QueryClient } from '@tanstack/react-query'
import type { AuthorityResult } from '@/lib/authority'
import { invalidateProjectDisplayQueries } from '@/lib/project-display-queries'

/** Brief reuse for draft evidence only; review and send guards still re-read. */
export function preparationStaleTime(
  query: { state: { status: 'pending' | 'error' | 'success' } },
  unavailable = false,
): number {
  // Partial reads are data in some editors, but must remain retryable errors.
  return query.state.status === 'success' && !unavailable ? 5_000 : 0
}

/** Invalidate composite drafts without replacing the form during a review. */
export function invalidatePreparationQueries(client: QueryClient, keys: readonly string[]) {
  for (const key of keys) void client.invalidateQueries({ queryKey: [key], refetchType: 'none' })
}

/** Also used after ambiguous/partial failures; invalidation is not an execution verdict. */
export function invalidateProjectPreparation(
  client: QueryClient,
  chainIds: readonly number[],
  preparationKeys: readonly string[],
) {
  for (const chainId of chainIds) void invalidateProjectDisplayQueries(client, chainId)
  invalidatePreparationQueries(client, preparationKeys)
}

/** Authority runners can return queued Safe proposals alongside executed calls. */
export function invalidateConfirmedPreparation(
  client: QueryClient,
  result: AuthorityResult,
  chainIds: readonly number[],
  preparationKeys: readonly string[],
) {
  const confirmed = chainIds.filter(chainId => !result.safeResults.some(
    item => item.chainId === chainId && item.status !== 'executed',
  ))
  if (!confirmed.length) return
  // These include composite multichain drafts. Reopening reads every input again.
  invalidateProjectPreparation(client, confirmed, preparationKeys)
}
