import {
  getAccountingContexts,
  getAllRulesets,
  getCurrentRuleset,
  getUpcomingRuleset,
} from '@bananapus/nana-sdk-core/v6'
import type {
  QueryClient,
  UseQueryOptions,
} from '@tanstack/react-query'
import type { PublicClient } from 'viem'
import { tokenSymbol } from '@/lib/token-symbol'
import { projectDisplayKey, type DisplayProject } from '@/lib/project-display-cache'

// Display/preparation evidence only. Final transaction simulation and send
// guards continue to read their own live evidence. Keys include the protocol,
// chain, project and every SDK argument; failed reads stay failed/retryable.
const PROJECT_RULESET_STALE_MS = 15_000
const PROJECT_CONFIGURATION_STALE_MS = 60_000

export function currentRulesetQuery(client: PublicClient, project: DisplayProject) {
  return {
    queryKey: projectDisplayKey(project, 'currentRuleset'),
    staleTime: PROJECT_RULESET_STALE_MS,
    retry: 1,
    queryFn: () => getCurrentRuleset(client, project),
  }
}

export function upcomingRulesetQuery(client: PublicClient, project: DisplayProject) {
  return {
    queryKey: projectDisplayKey(project, 'upcomingRuleset'),
    staleTime: PROJECT_RULESET_STALE_MS,
    retry: 1,
    queryFn: () => getUpcomingRuleset(client, project),
  }
}

export function allRulesetsQuery(
  client: PublicClient,
  project: DisplayProject & { size: bigint },
) {
  return {
    queryKey: [
      ...projectDisplayKey(project, 'allRulesets'),
      project.size.toString(),
    ] as const,
    staleTime: PROJECT_CONFIGURATION_STALE_MS,
    retry: 1,
    queryFn: () => getAllRulesets(client, project),
  }
}

export function accountingContextsQuery(
  client: PublicClient,
  project: DisplayProject,
) {
  return {
    queryKey: projectDisplayKey(project, 'accountingContexts'),
    staleTime: PROJECT_CONFIGURATION_STALE_MS,
    retry: 1,
    queryFn: () => getAccountingContexts(client, project),
  }
}

type DisplayResult<T> = { value: T; expiresAt: number }
export type ProjectDisplayReader = Pick<QueryClient, 'fetchQuery'>

/** Keep the expiry of the evidence actually consumed by a composed read.
 * TanStack stores the envelope; observers select the original display value.
 * A parallel refresh cannot grant an older composition a fresh lifetime. */
export function projectDisplayQuery<T>(
  client: QueryClient,
  options: Omit<
    UseQueryOptions<DisplayResult<T>, Error, T>,
    'queryFn' | 'select' | 'staleTime'
  > & {
    queryFn: (reader: ProjectDisplayReader) => Promise<T>
    staleTime?: number
  },
) {
  const { queryFn, staleTime = PROJECT_RULESET_STALE_MS, ...rest } = options
  return {
    ...rest,
    // Older releases persisted the bare result under these prefixes. Version
    // only the composed payload shape; existing prefix invalidation still works.
    queryKey: [...rest.queryKey, 'display-v1'],
    queryFn: async (): Promise<DisplayResult<T>> => {
      let expiresAt = Number.POSITIVE_INFINITY
      const fetchQuery: QueryClient['fetchQuery'] = async (read) => {
        const before = client.getQueryState(read.queryKey)
        const startedAt = Date.now()
        const ttl = typeof read.staleTime === 'number' ? read.staleTime : 0
        // A hit keeps its original timestamp. A new read is conservatively
        // bounded from its start, so delayed processing or another observer's
        // refresh cannot renew the evidence consumed by this composition.
        const consumedAt =
          before &&
          !before.isInvalidated &&
          before.dataUpdatedAt + ttl > startedAt
            ? before.dataUpdatedAt
            : startedAt
        try {
          const value = await client.fetchQuery(read)
          const state = client.getQueryState(read.queryKey)
          expiresAt = Math.min(
            expiresAt,
            state && !state.isInvalidated
              ? Math.min(consumedAt, state.dataUpdatedAt) + ttl
              : 0,
          )
          return value
        } catch (error) {
          expiresAt = 0
          throw error
        }
      }
      const value = await queryFn({ fetchQuery })
      return { value, expiresAt: Math.min(expiresAt, Date.now() + staleTime) }
    },
    select: (result: DisplayResult<T>) => result.value,
    staleTime: (query: {
      state: { data?: DisplayResult<T>; dataUpdatedAt: number }
    }) =>
      Math.max(
        0,
        (query.state.data?.expiresAt ?? 0) - query.state.dataUpdatedAt,
      ),
  }
}

/** Context labels are display-only; raw accounting evidence has its own key. */
export function accountingContextSymbolsQuery(
  client: PublicClient,
  queryClient: QueryClient,
  project: DisplayProject,
) {
  return projectDisplayQuery(queryClient, {
    queryKey: projectDisplayKey(project, 'accountingContextSymbols'),
    staleTime: PROJECT_CONFIGURATION_STALE_MS,
    retry: 0,
    queryFn: async (reader) =>
      Promise.all(
        (await reader.fetchQuery(accountingContextsQuery(client, project))).map(
          async (ctx) => ({
            ...ctx,
            symbol: await tokenSymbol(client, ctx.token, {
              chainId: project.chainId,
            }),
          }),
        ),
      ),
  })
}
