import { invalidateProjectDisplayQueries } from '@/lib/project-display-cache'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import type { PublicClient } from 'viem'
import {
  accountingContextsQuery,
  allRulesetsQuery,
  currentRulesetQuery,
  upcomingRulesetQuery,
  projectDisplayQuery,
} from '@/lib/project-display-queries'

const sdk = vi.hoisted(() => ({
  current: vi.fn(),
  upcoming: vi.fn(),
  all: vi.fn(),
  contexts: vi.fn(),
}))
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
    const queries = [
      currentRulesetQuery(client, project),
      upcomingRulesetQuery(client, project),
      accountingContextsQuery(client, project),
      allRulesetsQuery(client, { ...project, size: 50n }),
    ]
    const mocks = [sdk.current, sdk.upcoming, sdk.contexts, sdk.all]
    for (const [index, query] of queries.entries()) {
      const value = { index }
      mocks[index].mockResolvedValueOnce(value)
      expect(await query.queryFn()).toBe(value)
      expect(mocks[index]).toHaveBeenCalledWith(
        client,
        index === 3 ? { ...project, size: 50n } : project,
      )
      mocks[index].mockRejectedValueOnce(new Error('RPC unavailable'))
      await expect(query.queryFn()).rejects.toThrow('RPC unavailable')
    }
  })

  it('scopes cache keys to protocol, chain, project and history size with serializable values', () => {
    const queries = [
      currentRulesetQuery(client, project),
      currentRulesetQuery(client, { ...project, chainId: 10 }),
      currentRulesetQuery(client, { ...project, projectId: 6n }),
      upcomingRulesetQuery(client, project),
      allRulesetsQuery(client, { ...project, size: 50n }),
      allRulesetsQuery(client, { ...project, size: 10n }),
    ]
    expect(
      new Set(queries.map((query) => JSON.stringify(query.queryKey))).size,
    ).toBe(queries.length)
    expect(queries.every((query) => query.staleTime > 0)).toBe(true)
  })
})

describe('bounded display reuse', () => {
  afterEach(() => vi.useRealTimers())

  it('coalesces consumers in flight, reuses within TTL, then expires or invalidates', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const cache = new QueryClient()
    const options = currentRulesetQuery(client, project)
    let resolve!: (value: { ruleset: number }) => void
    sdk.current.mockReset().mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    const first = cache.fetchQuery(options)
    const concurrent = cache.fetchQuery(options)
    expect(sdk.current).toHaveBeenCalledTimes(1)
    resolve({ ruleset: 1 })
    expect(await concurrent).toEqual(await first)
    await cache.fetchQuery(options)
    expect(sdk.current).toHaveBeenCalledTimes(1)
    vi.setSystemTime(1_014_999)
    await cache.fetchQuery(options)
    expect(sdk.current).toHaveBeenCalledTimes(1)
    sdk.current.mockResolvedValue({ ruleset: 2 })
    vi.setSystemTime(1_015_000)
    await cache.fetchQuery(options)
    expect(sdk.current).toHaveBeenCalledTimes(2)
    await invalidateProjectDisplayQueries(cache, 10)
    await cache.fetchQuery(options)
    expect(sdk.current).toHaveBeenCalledTimes(2)
    await invalidateProjectDisplayQueries(cache, 1)
    await cache.fetchQuery(options)
    expect(sdk.current).toHaveBeenCalledTimes(3)
    cache.clear()
  })

  it('does not cache failed reads as empty data and retries successfully', async () => {
    const cache = new QueryClient()
    sdk.current
      .mockReset()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ ruleset: 1 })
    const options = { ...currentRulesetQuery(client, project), retryDelay: 0 }
    expect(await cache.fetchQuery(options)).toEqual({ ruleset: 1 })
    expect(sdk.current).toHaveBeenCalledTimes(2)
    cache.clear()
  })

  it('keeps the consumed expiry when a dependency refreshes during a slow composition', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const cache = new QueryClient()
    const current = currentRulesetQuery(client, project)
    sdk.current.mockReset().mockResolvedValue({ ruleset: 1 })
    await cache.fetchQuery(current)
    vi.setSystemTime(1_014_000)
    let finish!: () => void
    const gate = new Promise<void>((resolve) => {
      finish = resolve
    })
    const options = projectDisplayQuery(cache, {
      queryKey: ['composite'],
      queryFn: async (reader) => {
        const value = await reader.fetchQuery(current)
        await gate
        return value
      },
    })
    const pending = cache.fetchQuery(options)
    await Promise.resolve()
    vi.setSystemTime(1_015_000)
    sdk.current.mockResolvedValue({ ruleset: 2 })
    await cache.fetchQuery(current)
    vi.setSystemTime(1_016_000)
    finish()
    const old = await pending
    expect(old.value).toEqual({ ruleset: 1 })
    expect(old.expiresAt).toBe(1_015_000)
    expect((await cache.fetchQuery(options)).value).toEqual({ ruleset: 2 })
    cache.clear()
  })

  it('keeps failed dependencies retryable when a view displays a partial fallback', async () => {
    const cache = new QueryClient()
    const current = { ...currentRulesetQuery(client, project), retry: false }
    sdk.current
      .mockReset()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ ruleset: 1 })
    const options = projectDisplayQuery(cache, {
      queryKey: ['partial'],
      queryFn: (reader) => reader.fetchQuery(current).catch(() => null),
    })
    expect((await cache.fetchQuery(options)).expiresAt).toBe(0)
    expect((await cache.fetchQuery(options)).value).toEqual({ ruleset: 1 })
    cache.clear()
  })

  it('discards a delayed pre-write initial fill before allowing post-write evidence', async () => {
    const cache = new QueryClient()
    let finish!: (value: unknown) => void
    sdk.current
      .mockReset()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve
          }),
      )
      .mockResolvedValueOnce({ ruleset: 2 })
    const options = currentRulesetQuery(client, project)
    const old = cache.fetchQuery(options).catch(() => undefined)
    await invalidateProjectDisplayQueries(cache, 1)
    expect(await cache.fetchQuery(options)).toEqual({ ruleset: 2 })
    finish({ ruleset: 1 })
    await old
    await Promise.resolve()
    expect(cache.getQueryData(options.queryKey)).toEqual({ ruleset: 2 })
    cache.clear()
  })

  it('invalidates aggregates on a peer-chain write without touching unrelated groups or preparation evidence', async () => {
    const cache = new QueryClient()
    const peer = [
      'projectDisplay',
      6,
      1,
      '1',
      'priceReferences',
      [
        [1, 1],
        [10, 1],
      ],
      1,
    ]
    const unrelated = [
      'projectDisplay',
      6,
      1,
      '2',
      'priceReferences',
      [[1, 2]],
      1,
    ]
    const treasury = [
      'projectTreasuryUsd',
      [
        [1, 1],
        [10, 1],
      ],
    ]
    const authority = ['transactionAuthority', 10, 'account']
    for (const key of [peer, unrelated, treasury, authority])
      cache.setQueryData(key, true)
    await invalidateProjectDisplayQueries(cache, 10)
    expect(cache.getQueryState(peer)?.isInvalidated).toBe(true)
    expect(cache.getQueryState(treasury)?.isInvalidated).toBe(true)
    expect(cache.getQueryState(unrelated)?.isInvalidated).toBe(false)
    expect(cache.getQueryState(authority)?.isInvalidated).toBe(false)
    cache.clear()
  })

  it('caps composed freshness at the oldest dependency instead of restarting its TTL', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const cache = new QueryClient()
    const current = currentRulesetQuery(client, project)
    sdk.current.mockReset().mockResolvedValue({ ruleset: 1 })
    await cache.fetchQuery(current)
    vi.setSystemTime(1_014_000)
    const compose = vi.fn((reader) => reader.fetchQuery(current))
    const composite = projectDisplayQuery(cache, {
      queryKey: ['composite'],
      queryFn: compose,
    })
    await cache.fetchQuery(composite)
    await cache.fetchQuery(composite)
    expect(compose).toHaveBeenCalledTimes(1)
    vi.setSystemTime(1_015_000)
    await cache.fetchQuery(composite)
    expect(compose).toHaveBeenCalledTimes(2)
    expect(sdk.current).toHaveBeenCalledTimes(2)
    cache.clear()
  })
})
