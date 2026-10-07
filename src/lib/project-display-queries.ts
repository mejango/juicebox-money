import type { JBChainId } from '@bananapus/nana-sdk-core'
import {
  getAccountingContexts,
  getAllRulesets,
  getCurrentRuleset,
  getTokenAddress,
  getUpcomingRuleset,
} from '@bananapus/nana-sdk-core/v6'
import { erc20Abi, type Address, type PublicClient } from 'viem'
import { PERSIST } from '@/lib/query-persist'

type Project = { chainId: JBChainId; projectId: bigint }

// Display/preparation evidence only. Final transaction simulation and send
// guards continue to read their own live evidence. Keys include the protocol,
// chain, project and every SDK argument; failed reads stay failed/retryable.
export const PROJECT_RULESET_STALE_MS = 15_000
export const PROJECT_CONFIGURATION_STALE_MS = 60_000

function key(project: Project, kind: string) {
  return ['projectDisplay', 6, project.chainId, project.projectId.toString(), kind] as const
}

export function currentRulesetQuery(client: PublicClient, project: Project) {
  return {
    queryKey: key(project, 'currentRuleset'),
    staleTime: PROJECT_RULESET_STALE_MS,
    retry: 1,
    queryFn: () => getCurrentRuleset(client, project),
  }
}

export function upcomingRulesetQuery(client: PublicClient, project: Project) {
  return {
    queryKey: key(project, 'upcomingRuleset'),
    staleTime: PROJECT_RULESET_STALE_MS,
    retry: 1,
    queryFn: () => getUpcomingRuleset(client, project),
  }
}

export function allRulesetsQuery(client: PublicClient, project: Project & { size: bigint }) {
  return {
    queryKey: [...key(project, 'allRulesets'), project.size.toString()] as const,
    staleTime: PROJECT_CONFIGURATION_STALE_MS,
    retry: 1,
    queryFn: () => getAllRulesets(client, project),
  }
}

export function accountingContextsQuery(client: PublicClient, project: Project) {
  return {
    queryKey: key(project, 'accountingContexts'),
    staleTime: PROJECT_CONFIGURATION_STALE_MS,
    retry: 1,
    queryFn: () => getAccountingContexts(client, project),
  }
}

/** Existing project-token cache contract, shared with every symbol consumer. */
export function projectTokenQuery(client: PublicClient, chainId: JBChainId, projectId: number) {
  return {
    queryKey: ['marketProjectSymbol', chainId, projectId] as const,
    meta: PERSIST,
    staleTime: 5 * 60_000,
    retry: 1,
    queryFn: async (): Promise<{ address: Address; symbol: string } | null> => {
      const token = await getTokenAddress(client, { chainId, projectId: BigInt(projectId) })
      if (!token) return null
      const symbol = await client.readContract({ address: token, abi: erc20Abi, functionName: 'symbol' })
      return { address: token, symbol }
    },
  }
}
