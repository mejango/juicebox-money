import type { JBChainId } from '@bananapus/nana-sdk-core'
import type { QueryClient, QueryKey } from '@tanstack/react-query'

export type DisplayProject = { chainId: JBChainId; projectId: bigint }

// Keep cache identity and invalidation independent of RPC/read factories so
// mutation callers do not load the display-read dependency graph.
export function projectDisplayKey(project: DisplayProject, kind: string) {
  return [
    'projectDisplay',
    6,
    project.chainId,
    project.projectId.toString(),
    kind,
  ] as const
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
