import type { JBChainId } from '@bananapus/nana-sdk-core'
import {
  getAccountingContexts,
  getAllRulesets,
  getCurrentRuleset,
  getTokenAddress,
  getUpcomingRuleset,
} from '@bananapus/nana-sdk-core/v6'
import type {
  QueryClient,
  QueryKey,
  UseQueryOptions,
} from '@tanstack/react-query'
import { erc20Abi, type Address, type PublicClient } from 'viem'
import { tokenSymbol } from '@/lib/token-symbol'
import { PERSIST } from '@/lib/query-persist'

type Project = { chainId: JBChainId; projectId: bigint }

// Display/preparation evidence only. Final transaction simulation and send
// guards continue to read their own live evidence. Keys include the protocol,
// chain, project and every SDK argument; failed reads stay failed/retryable.
const PROJECT_RULESET_STALE_MS = 15_000
const PROJECT_CONFIGURATION_STALE_MS = 60_000

export function projectDisplayKey(project: Project, kind: string) {
  return [
    'projectDisplay',
    6,
    project.chainId,
    project.projectId.toString(),
    kind,
  ] as const
}

export function currentRulesetQuery(client: PublicClient, project: Project) {
  return {
    queryKey: projectDisplayKey(project, 'currentRuleset'),
    staleTime: PROJECT_RULESET_STALE_MS,
    retry: 1,
    queryFn: () => getCurrentRuleset(client, project),
  }
}

export function upcomingRulesetQuery(client: PublicClient, project: Project) {
  return {
    queryKey: projectDisplayKey(project, 'upcomingRuleset'),
    staleTime: PROJECT_RULESET_STALE_MS,
    retry: 1,
    queryFn: () => getUpcomingRuleset(client, project),
  }
}

export function allRulesetsQuery(
  client: PublicClient,
  project: Project & { size: bigint },
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
  project: Project,
) {
  return {
    queryKey: projectDisplayKey(project, 'accountingContexts'),
    staleTime: PROJECT_CONFIGURATION_STALE_MS,
    retry: 1,
    queryFn: () => getAccountingContexts(client, project),
  }
}

/** Existing project-token cache contract, shared with every symbol consumer. */
export function projectTokenQuery(
  client: PublicClient,
  chainId: JBChainId,
  projectId: number,
) {
  return {
    queryKey: ['marketProjectSymbol', chainId, projectId] as const,
    meta: PERSIST,
    staleTime: 5 * 60_000,
    retry: 1,
    queryFn: async (): Promise<{ address: Address; symbol: string } | null> => {
      const token = await getTokenAddress(client, {
        chainId,
        projectId: BigInt(projectId),
      })
      if (!token) return null
      const symbol = await client.readContract({
        address: token,
        abi: erc20Abi,
        functionName: 'symbol',
      })
      return { address: token, symbol }
    },
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
  project: Project,
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

/** Confirmed writes expire public display evidence; proposals alone do not. */
export async function invalidateProjectDisplayQueries(
  client: QueryClient,
  chainId: number,
) {
  const filters = {
    predicate: (query: { queryKey: QueryKey }) => {
      const [root, scope] = query.queryKey
      if (root === 'projectDisplay') {
        if (query.queryKey[2] === chainId) return true
        // The price reference combines all project deployments under the home
        // chain; a peer-chain write also expires that aggregate.
        return (
          query.queryKey[4] === 'priceReferences' &&
          Array.isArray(query.queryKey[5]) &&
          query.queryKey[5].some(
            (pair) => Array.isArray(pair) && pair[0] === chainId,
          )
        )
      }
      if (
        [
          'marketProjectSymbol',
          'yourPosition',
          'market',
          'payMarket',
          'cashOutMarket',
          'marketFloor',
        ].includes(String(root))
      ) {
        return scope === chainId
      }
      return (
        ['projectTreasuryUsd', 'gossip', 'settlement-composition'].includes(
          String(root),
        ) &&
        Array.isArray(scope) &&
        scope.some((pair) => Array.isArray(pair) && pair[0] === chainId)
      )
    },
  }
  // Cancel initial fills too. Otherwise a read started before the receipt can
  // finish afterwards and grant old evidence a new freshness window.
  await client.cancelQueries(filters)
  return client.invalidateQueries(filters)
}
