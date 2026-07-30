import { describe, expect, it, vi } from 'vitest'
import {
  getAccountActivity,
  getAccountNfts,
  getAccountTokenHoldings,
  getOperatorGrants,
  getProjectsByRefs,
  getProjectsOwnedBy,
} from '@/lib/bendystraw'

const ALICE = '0xAbCd111111111111111111111111111111111111'

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

/** Every beneficiary-bearing event list the account feed merges in. */
const BENEFICIARY_LISTS = [
  'payEvents',
  'cashOutTokensEvents',
  'mintTokensEvents',
  'autoIssueEvents',
  'borrowLoanEvents',
  'mintNftEvents',
  'bridgeClaimEvents',
  'sendPayoutToSplitEvents',
  'sendReservedTokensToSplitEvents',
]

function accountActivityResponse(
  overrides: Record<string, { totalCount: number; items: unknown[] }> = {},
): Response {
  const data: Record<string, unknown> = {
    activityEvents: { totalCount: 0, items: [] },
  }
  for (const list of BENEFICIARY_LISTS) {
    data[list] = { totalCount: 0, items: [] }
  }
  return graphqlResponse({ data: { ...data, ...overrides } })
}

describe('account activity query', () => {
  it('filters by lowercased from-address and fetches the merged window for the offset', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      accountActivityResponse({
        activityEvents: {
          totalCount: 42,
          items: [{ id: 'a', chainId: 1, projectId: 2, version: 6, timestamp: 9 }],
        },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const page = await getAccountActivity(ALICE, { limit: 25, offset: 0 })

    expect(page.totalCount).toBe(42)
    expect(page.items).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const { query, variables } = bodyOf(fetchMock.mock.calls[0]?.[1])
    // The merged streams are each read from the head: one window covering
    // offset + limit, sliced after the merge.
    expect(variables).toEqual({
      address: ALICE.toLowerCase(),
      limit: 25,
      offset: 0,
    })
    expect(query).toContain('from: $address')
    expect(query).toContain('project { name logoUri tokenSymbol decimals }')
    // The account view is V6-only: every branch pins the version.
    expect(query).toContain('from: $address, version: 6')
  })

  it('widens the fetch window to cover the requested offset', async () => {
    const fetchMock = vi.fn().mockResolvedValue(accountActivityResponse())
    vi.stubGlobal('fetch', fetchMock)

    await getAccountActivity(ALICE, { limit: 25, offset: 50 })

    const { variables } = bodyOf(fetchMock.mock.calls[0]?.[1])
    expect(variables).toEqual({ address: ALICE.toLowerCase(), limit: 75, offset: 0 })
  })

  it('spans beneficiary-side events with explicit AND groups (bendystraw does not AND siblings in OR branches)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(accountActivityResponse())
    vi.stubGlobal('fetch', fetchMock)

    await getAccountActivity(ALICE)

    const { query } = bodyOf(fetchMock.mock.calls[0]?.[1])
    for (const list of BENEFICIARY_LISTS) {
      expect(query).toContain(`${list}(`)
    }
    expect(
      query.match(
        /AND: \[\{ beneficiary: \$address \}, \{ from_not: \$address \}, \{ version: 6 \}\]/g,
      ),
    ).toHaveLength(BENEFICIARY_LISTS.length)
  })

  it('merges branches newest-first, wraps sub-event rows, and dedupes by id', async () => {
    const envelope = {
      chainId: 8453,
      projectId: 7,
      version: 6,
      txHash: '0x2',
      from: '0xother',
      project: { name: 'P', logoUri: null, tokenSymbol: 'USDC', decimals: 6 },
    }
    const fetchMock = vi.fn().mockResolvedValue(
      accountActivityResponse({
        activityEvents: {
          totalCount: 2,
          items: [
            { id: 'evt-new', chainId: 1, projectId: 2, version: 6, timestamp: 300 },
            { id: 'dup', chainId: 1, projectId: 2, version: 6, timestamp: 100 },
          ],
        },
        payEvents: {
          totalCount: 2,
          items: [
            {
              ...envelope,
              id: 'pay-1',
              timestamp: 200,
              amount: '2500000',
              amountUsd: '2500000000000000000',
              beneficiary: ALICE.toLowerCase(),
              memo: null,
              newlyIssuedTokenCount: '0',
            },
            {
              ...envelope,
              id: 'dup',
              timestamp: 100,
              amount: '1',
              amountUsd: '1',
              beneficiary: ALICE.toLowerCase(),
              memo: null,
              newlyIssuedTokenCount: '0',
            },
          ],
        },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const page = await getAccountActivity(ALICE, { limit: 25, offset: 0 })

    expect(page.totalCount).toBe(4)
    expect(page.items.map(item => item.id)).toEqual(['evt-new', 'pay-1', 'dup'])
    const wrapped = page.items[1]
    expect(wrapped.chainId).toBe(8453)
    expect(wrapped.project?.tokenSymbol).toBe('USDC')
    expect(wrapped.payEvent?.amount).toBe('2500000')
    expect(wrapped.payEvent?.beneficiary).toBe(ALICE.toLowerCase())
  })

  it('slices the merged window by the requested offset', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      accountActivityResponse({
        activityEvents: {
          totalCount: 2,
          items: [
            { id: 'a', chainId: 1, projectId: 2, version: 6, timestamp: 400 },
            { id: 'c', chainId: 1, projectId: 2, version: 6, timestamp: 200 },
          ],
        },
        mintTokensEvents: {
          totalCount: 2,
          items: [
            {
              id: 'b',
              chainId: 1,
              projectId: 2,
              version: 6,
              timestamp: 300,
              txHash: '0x1',
              from: '0xother',
              project: null,
              beneficiary: ALICE.toLowerCase(),
              beneficiaryTokenCount: '1',
              caller: '0xc',
            },
            {
              id: 'd',
              chainId: 1,
              projectId: 2,
              version: 6,
              timestamp: 100,
              txHash: '0x1',
              from: '0xother',
              project: null,
              beneficiary: ALICE.toLowerCase(),
              beneficiaryTokenCount: '1',
              caller: '0xc',
            },
          ],
        },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const page = await getAccountActivity(ALICE, { limit: 2, offset: 1 })

    expect(page.items.map(item => item.id)).toEqual(['b', 'c'])
    expect(page.totalCount).toBe(4)
  })
})

describe('owned projects query', () => {
  it('skips the network entirely for an empty owner set', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(getProjectsOwnedBy([])).resolves.toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('queries owner_in with lowercased owners, pinned to V6', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      graphqlResponse({
        data: {
          projects: {
            totalCount: 2,
            items: [
              { chainId: 1, projectId: 3, version: 6, owner: ALICE.toLowerCase() },
              { chainId: 10, projectId: 9, version: 6, owner: ALICE.toLowerCase() },
            ],
          },
        },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const projects = await getProjectsOwnedBy([ALICE, '0xDEF2222222222222222222222222222222222222'])

    expect(projects).toHaveLength(2)
    const { query, variables } = bodyOf(fetchMock.mock.calls[0]?.[1])
    expect(query).toContain('owner_in: $owners')
    expect(query).toContain('version: 6')
    expect(variables.owners).toEqual([
      ALICE.toLowerCase(),
      '0xdef2222222222222222222222222222222222222',
    ])
  })
})

describe('operator grants query', () => {
  it('drops revoked rows whose permission set is empty', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      graphqlResponse({
        data: {
          permissionHolders: {
            totalCount: 2,
            items: [
              {
                chainId: 1,
                projectId: 5,
                permissions: [17, 25],
                account: '0xgranter',
                operator: ALICE.toLowerCase(),
                isRevnetOperator: true,
                version: 6,
              },
              {
                chainId: 10,
                projectId: 5,
                permissions: [],
                account: '0xgranter',
                operator: ALICE.toLowerCase(),
                isRevnetOperator: false,
                version: 6,
              },
            ],
          },
        },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const grants = await getOperatorGrants(ALICE)

    expect(grants).toHaveLength(1)
    expect(grants[0].permissions).toEqual([17, 25])
    const { query, variables } = bodyOf(fetchMock.mock.calls[0]?.[1])
    expect(query).toContain('operator: $operator')
    expect(query).toContain('version: 6')
    expect(variables.operator).toBe(ALICE.toLowerCase())
  })
})

describe('projects-by-refs query', () => {
  it('rejects invalid refs without touching the network', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      getProjectsByRefs([
        { chainId: 0, projectId: 1, version: 6 },
        { chainId: 1, projectId: -4, version: 6 },
        { chainId: 1.5, projectId: 1, version: 6 },
      ]),
    ).resolves.toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('builds explicit AND groups per deployment (bendystraw ORs sibling fields)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      graphqlResponse({
        data: {
          projects: {
            items: [{ chainId: 1, projectId: 5, version: 4, name: 'A' }],
          },
        },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const projects = await getProjectsByRefs([
      { chainId: 1, projectId: 5, version: 4 },
      { chainId: 1, projectId: 5, version: 4 },
      { chainId: 8453, projectId: 2, version: 6 },
    ])

    expect(projects).toHaveLength(1)
    const { query } = bodyOf(fetchMock.mock.calls[0]?.[1])
    expect(query).toContain(
      '{ AND: [{ chainId: 1 }, { projectId: 5 }, { version: 4 }] }',
    )
    expect(query).toContain(
      '{ AND: [{ chainId: 8453 }, { projectId: 2 }, { version: 6 }] }',
    )
    // Duplicate refs collapse to one branch.
    expect(query.match(/AND:/g)).toHaveLength(2)
  })
})

describe('account holdings queries', () => {
  it('reads positive V6 balances with the credits/ERC-20 split and reports the true total', async () => {
    const rows = Array.from({ length: 201 }, (_, index) => ({
      chainId: 1,
      projectId: index + 1,
      balance: '10',
      creditBalance: '3',
      erc20Balance: '7',
    }))
    const fetchMock = vi.fn().mockImplementation((_url, init) => {
      const { variables } = bodyOf(init)
      const offset = Number(variables.offset)
      const limit = Number(variables.limit)
      return Promise.resolve(
        graphqlResponse({
        data: {
          participants: {
              totalCount: rows.length,
              items: rows.slice(offset, offset + limit),
          },
        },
        }),
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    const page = await getAccountTokenHoldings(ALICE)

    expect(page.items).toHaveLength(201)
    expect(page.items[0].creditBalance).toBe('3')
    expect(page.items[0].erc20Balance).toBe('7')
    expect(page.totalCount).toBe(201)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const { query, variables } = bodyOf(fetchMock.mock.calls[0]?.[1])
    expect(variables.address).toBe(ALICE.toLowerCase())
    expect(query).toContain('address: $address')
    expect(query).toContain('balance_gt: "0"')
    expect(query).toContain('orderBy: "balance"')
    // The account view is V6-only.
    expect(query).toContain('version: 6')
  })

  it('reads owned V6 nfts with tier display metadata and reports the true total', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      graphqlResponse({
        data: {
          nfts: {
            totalCount: 1,
            items: [
              {
                chainId: 1,
                projectId: 4,
                tokenId: '49000000145',
                tierId: 49,
                createdAt: 1765214723,
                hook: { address: '0xhook' },
                tier: { resolvedUri: null, metadata: { name: 'Dagger' } },
              },
            ],
          },
        },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const page = await getAccountNfts(ALICE)

    expect(page.items).toEqual([
      {
        chainId: 1,
        projectId: 4,
        tokenId: '49000000145',
        tierId: 49,
        createdAt: 1765214723,
        hook: { address: '0xhook' },
        tier: { resolvedUri: null, metadata: { name: 'Dagger' } },
      },
    ])
    expect(page.totalCount).toBe(1)
    const { query, variables } = bodyOf(fetchMock.mock.calls[0]?.[1])
    expect(variables.owner).toBe(ALICE.toLowerCase())
    expect(query).toContain('owner: $owner')
    expect(query).toContain('tier { resolvedUri metadata }')
    expect(query).toContain('version: 6')
  })
})
