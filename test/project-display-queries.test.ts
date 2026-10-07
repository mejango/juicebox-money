import { describe, expect, it, vi } from 'vitest'
import type { PublicClient } from 'viem'
import { accountingContextsQuery, allRulesetsQuery, currentRulesetQuery, upcomingRulesetQuery } from '@/lib/project-display-queries'

const sdk = vi.hoisted(() => ({ current: vi.fn(), upcoming: vi.fn(), all: vi.fn(), contexts: vi.fn() }))
vi.mock('@bananapus/nana-sdk-core/v6', () => ({
  getCurrentRuleset: sdk.current,
  getUpcomingRuleset: sdk.upcoming,
  getAllRulesets: sdk.all,
  getAccountingContexts: sdk.contexts,
  getTokenAddress: vi.fn(),
}))

const client = {} as PublicClient
const project = { chainId: 1 as const, projectId: 5n }

describe('shared project display query contracts', () => {
  it('preserves SDK arguments and errors without guessing empty results', async () => {
    const queries = [currentRulesetQuery(client, project), upcomingRulesetQuery(client, project), accountingContextsQuery(client, project), allRulesetsQuery(client, { ...project, size: 50n })]
    const mocks = [sdk.current, sdk.upcoming, sdk.contexts, sdk.all]
    for (const [index, query] of queries.entries()) {
      const value = { index }
      mocks[index].mockResolvedValueOnce(value)
      expect(await query.queryFn()).toBe(value)
      expect(mocks[index]).toHaveBeenCalledWith(client, index === 3 ? { ...project, size: 50n } : project)
      mocks[index].mockRejectedValueOnce(new Error('RPC unavailable'))
      await expect(query.queryFn()).rejects.toThrow('RPC unavailable')
    }
  })

  it('scopes cache keys to protocol, chain, project and history size with serializable values', () => {
    const queries = [currentRulesetQuery(client, project), currentRulesetQuery(client, { ...project, chainId: 10 }), currentRulesetQuery(client, { ...project, projectId: 6n }), upcomingRulesetQuery(client, project), allRulesetsQuery(client, { ...project, size: 50n }), allRulesetsQuery(client, { ...project, size: 10n })]
    expect(new Set(queries.map(query => JSON.stringify(query.queryKey))).size).toBe(queries.length)
    expect(queries.every(query => query.staleTime > 0)).toBe(true)
  })
})
