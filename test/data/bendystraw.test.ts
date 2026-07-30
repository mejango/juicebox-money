import { describe, expect, it, vi } from 'vitest'
import {
  bendystraw,
  getPagedItems,
  getParticipants,
  getRevnetPriceHistory,
  getShopPurchases,
  normalizeBendystrawUrl,
  searchProjects,
} from '@/lib/bendystraw'
import { bendystrawProjectRefsFilters } from '@bananapus/nana-sdk-core'

function graphqlResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function bodyOf(init?: RequestInit): {
  query: string
  variables: Record<string, unknown>
} {
  return JSON.parse(String(init?.body)) as {
    query: string
    variables: Record<string, unknown>
  }
}

describe('minimal Bendystraw client', () => {
  it('builds bounded exact-ref batches and rejects malformed identities', () => {
    expect(
      bendystrawProjectRefsFilters(
        Array.from({ length: 201 }, (_, index) => ({
          chainId: 1,
          projectId: index + 1,
          version: 6,
        })),
      ).map(where => (where.OR as unknown[]).length),
    ).toEqual([200, 1])
    expect(() =>
      bendystrawProjectRefsFilters([
        { chainId: 1, projectId: 0, version: 6 },
      ]),
    ).toThrow('Invalid Bendystraw project reference')
  })

  it('normalizes base URLs to one GraphQL endpoint', () => {
    expect(normalizeBendystrawUrl('https://bendystraw.example')).toBe(
      'https://bendystraw.example/graphql',
    )
    expect(
      normalizeBendystrawUrl(
        'https://bendystraw.example/base/graphql/?key=ignored#fragment',
      ),
    ).toBe('https://bendystraw.example/base/graphql')
  })

  it('posts variables and returns only the GraphQL data payload', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      graphqlResponse({ data: { project: { projectId: 7 } } }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      bendystraw<{ project: { projectId: number } }>(
        'query($projectId: Int!) { project(projectId: $projectId) { projectId } }',
        { projectId: 7 },
      ),
    ).resolves.toEqual({ project: { projectId: 7 } })

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://bendystraw.xyz/graphql')
    expect(init.method).toBe('POST')
    expect(bodyOf(init).variables).toEqual({ projectId: 7 })
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('routes an explicitly testnet-scoped query to testnet Bendystraw', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      graphqlResponse({ data: { project: { projectId: 11 } } }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await bendystraw('query($chainId: Float!) { project(chainId: $chainId) { projectId } }', {
      chainId: 84532,
    })

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://testnet.bendystraw.xyz/graphql',
    )
  })

  it('rejects HTTP, GraphQL, and empty-data failures', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    fetchMock.mockImplementation(async () => graphqlResponse({}, 503))
    await expect(bendystraw('query { x }', {})).rejects.toThrow(
      'Bendystraw request failed (503)',
    )

    fetchMock.mockImplementation(async () =>
      graphqlResponse({ errors: [{ message: 'schema mismatch' }] }),
    )
    await expect(bendystraw('query { x }', {})).rejects.toThrow(
      'schema mismatch',
    )

    fetchMock.mockImplementation(async () => graphqlResponse({}))
    await expect(bendystraw('query { x }', {})).rejects.toThrow(
      'missing data',
    )

    fetchMock.mockImplementation(async () =>
      graphqlResponse({ data: { project: {} } }),
    )
    await expect(
      bendystraw(
        'query Project($projectId: Int!) { project(projectId: $projectId) { projectId } }',
        { projectId: 7 },
      ),
    ).rejects.toThrow('Project returned invalid data')

    await expect(
      bendystraw(
        'query Project($projectId: Int!) { project(projectId: $projectId) { projectId } }',
        { projectId: 'wrong' },
      ),
    ).rejects.toThrow('Project received invalid variables')
  })
})

describe('Bendystraw pagination and trust boundaries', () => {
  it('searches project names and tickers, then deduplicates matching deployments', async () => {
    const project = {
      projectId: 11,
      chainId: 8453,
      version: 6,
      name: 'Bounty Engine Network',
      logoUri: null,
      projectTagline: null,
      volume: '0',
      volumeUsd: '0',
      balance: '0',
      paymentsCount: 0,
      contributorsCount: 0,
      createdAt: 1,
      suckerGroupId: null,
      token: null,
      tokenSymbol: null,
      decimals: null,
      currency: null,
      isRevnet: true,
      owner: null,
      metadataUri: null,
    }
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        graphqlResponse({ data: { projects: { items: [project] } } }),
      )
      .mockResolvedValueOnce(
        graphqlResponse({
          data: {
            deployErc20Events: {
              items: [{ chainId: 8453, projectId: 11, symbol: 'BEN' }],
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        graphqlResponse({ data: { projects: { items: [project] } } }),
      )
    vi.stubGlobal('fetch', fetchMock)

    await expect(searchProjects('$BEN')).resolves.toEqual([
      expect.objectContaining({
        chainId: 8453,
        projectId: 11,
        searchTicker: 'BEN',
      }),
    ])
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(bodyOf(fetchMock.mock.calls[0]?.[1] as RequestInit).variables).toEqual(
      {
        where: {
          AND: [{ version: 6 }, { OR: [{ name_contains_nocase: 'BEN' }] }],
        },
        limit: 24,
      },
    )
  })

  it('resolves ticker matches with explicit AND groups and a version-6 event filter', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        graphqlResponse({ data: { projects: { items: [] } } }),
      )
      .mockResolvedValueOnce(
        graphqlResponse({
          data: {
            deployErc20Events: {
              items: [
                { chainId: 8453, projectId: 11, symbol: 'BEN' },
                { chainId: 1, projectId: 3, symbol: 'BENT' },
              ],
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        graphqlResponse({ data: { projects: { items: [] } } }),
      )
    vi.stubGlobal('fetch', fetchMock)

    await searchProjects('BEN')

    // Per-version event rows: a v4/v5 token deploy must not resolve
    // against the v6 project with the same (chainId, projectId).
    const eventQuery = bodyOf(fetchMock.mock.calls[1]?.[1] as RequestInit).query
    expect(eventQuery).toContain('version: 6')

    // Bendystraw ORs sibling fields inside one OR branch, so each ticker
    // deployment must be an explicit AND group in the typed filter variable.
    const projectRequest = bodyOf(fetchMock.mock.calls[2]?.[1] as RequestInit)
    expect(projectRequest.variables.where).toEqual({
      OR: [
        { AND: [{ chainId: 8453 }, { projectId: 11 }, { version: 6 }] },
        { AND: [{ chainId: 1 }, { projectId: 3 }, { version: 6 }] },
      ],
    })
  })

  it('adds a safe numeric project-id filter and skips the ticker lookup fetch when empty', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        graphqlResponse({ data: { projects: { items: [] } } }),
      )
      .mockResolvedValueOnce(
        graphqlResponse({ data: { deployErc20Events: { items: [] } } }),
      )
    vi.stubGlobal('fetch', fetchMock)

    await expect(searchProjects('11', 3)).resolves.toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const variables = bodyOf(fetchMock.mock.calls[0]?.[1] as RequestInit).variables
    expect(variables.where).toEqual({
      AND: [{ version: 6 }, { OR: [{ name_contains_nocase: '11' }, { projectId: 11 }] }],
    })
  })

  it('paginates participants with bounded page sizes and offsets', async () => {
    const rows = Array.from({ length: 300 }, (_, index) => ({
      address: `0x${index.toString(16).padStart(40, '0')}`,
      balance: String(300 - index),
      chainId: 1,
      volumeUsd: '0',
    }))
    const fetchMock = vi.fn().mockImplementation(
      async (_url: string, init?: RequestInit) => {
        const { variables } = bodyOf(init)
        const offset = Number(variables.offset)
        const limit = Number(variables.limit)
        return graphqlResponse({
          data: {
            participants: {
              items: rows.slice(offset, offset + limit),
              totalCount: rows.length,
            },
          },
        })
      },
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await getParticipants({ chainId: 1, projectId: 7 }, 300)

    expect(result.items).toHaveLength(300)
    expect(result.totalCount).toBe(300)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(
      fetchMock.mock.calls.map(call => bodyOf(call[1] as RequestInit).variables),
    ).toEqual([
      expect.objectContaining({
        where: {
          AND: [
            { AND: [{ chainId: 1 }, { projectId: 7 }, { version: 6 }] },
            { balance_gt: '0' },
          ],
        },
        limit: 250,
        offset: 0,
      }),
      expect.objectContaining({ limit: 50, offset: 250 }),
    ])
  })

  it('routes suckerGroup-keyed participant reads to the testnet endpoint via the chainId hint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      graphqlResponse({
        data: { participants: { items: [], totalCount: 0 } },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await getParticipants({ suckerGroupId: 'group-1', chainId: 84532 })

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://testnet.bendystraw.xyz/graphql',
    )
    // The hint routes the endpoint only — it never narrows the group filter.
    const { query, variables } = bodyOf(
      fetchMock.mock.calls[0]?.[1] as RequestInit,
    )
    expect(query).not.toContain('chainId: $chainId')
    expect(variables.chainId).toBeUndefined()
  })

  it('keeps suckerGroup-keyed participant reads on the default endpoint without a hint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      graphqlResponse({
        data: { participants: { items: [], totalCount: 0 } },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await getParticipants({ suckerGroupId: 'group-1' })

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://bendystraw.xyz/graphql',
    )
  })

  it('routes revnet price history to the testnet endpoint via the chainId hint', async () => {
    const fetchMock = vi.fn().mockImplementation(async () =>
      graphqlResponse({
        data: {
          suckerGroupMoments: { items: [], totalCount: 0 },
          swapEvents: { items: [], totalCount: 0 },
          buybackPoolEvents: { items: [], totalCount: 0 },
        },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await getRevnetPriceHistory('group-1', { chainId: 84532 })

    expect(fetchMock).toHaveBeenCalled()
    for (const call of fetchMock.mock.calls) {
      expect(call[0]).toBe('https://testnet.bendystraw.xyz/graphql')
    }
  })

  it('caps generic pagination even when the indexer reports more rows', async () => {
    const fetchMock = vi.fn().mockImplementation(
      async (_url: string, init?: RequestInit) => {
        const { variables } = bodyOf(init)
        const limit = Number(variables.limit)
        const offset = Number(variables.offset)
        return graphqlResponse({
          data: {
            rows: {
              items: Array.from({ length: limit }, (_, index) => offset + index),
              totalCount: 10_000,
            },
          },
        })
      },
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await getPagedItems<number>(
      'query($limit: Int!, $offset: Int!) { rows { items totalCount } }',
      'rows',
      {},
      { pageSize: 2, max: 5 },
    )

    expect(result.items).toEqual([0, 1, 2, 3, 4])
    expect(result.totalCount).toBe(10_000)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('drops mismatched shop identities and reports partial-chain failures', async () => {
    const fetchMock = vi.fn().mockImplementation(
      async (_url: string, init?: RequestInit) => {
        const { variables } = bodyOf(init)
        if (variables.chainId === 10) throw new Error('indexer unavailable')
        if (variables.offset === 0) {
          return graphqlResponse({
            data: {
              mintNftEvents: {
                totalCount: 2,
                items: [
                  {
                    chainId: 1,
                    projectId: 7,
                    timestamp: 20,
                    txHash: '0xaaa',
                    beneficiary: '0x1111111111111111111111111111111111111111',
                    tierId: 1,
                    tokenId: '11',
                    totalAmountPaid: '100',
                    hook: '0x2222222222222222222222222222222222222222',
                  },
                  {
                    chainId: 1,
                    projectId: 999,
                    timestamp: 30,
                    txHash: '0xbbb',
                    beneficiary: '0x1111111111111111111111111111111111111111',
                    tierId: 2,
                    tokenId: '12',
                    totalAmountPaid: '200',
                    hook: '0x2222222222222222222222222222222222222222',
                  },
                ],
              },
            },
          })
        }
        return graphqlResponse({
          data: { mintNftEvents: { totalCount: 2, items: [] } },
        })
      },
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await getShopPurchases([
      { chainId: 1, projectId: 7 },
      { chainId: 10, projectId: 12 },
    ])

    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toEqual(
      expect.objectContaining({ chainId: 1, projectId: 7, tokenId: '11' }),
    )
    expect(result.failedChains).toEqual([10])
    expect(result.capped).toBe(false)
  })
})
