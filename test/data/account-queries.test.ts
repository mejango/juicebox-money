import { describe, expect, it, vi } from 'vitest'
import {
  getAccountActivity,
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

describe('account activity query', () => {
  it('filters by lowercased from-address and pages by offset', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      graphqlResponse({
        data: {
          activityEvents: {
            totalCount: 42,
            items: [{ id: 'a', chainId: 1, projectId: 2, version: 6 }],
          },
        },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const page = await getAccountActivity(ALICE, { limit: 25, offset: 50 })

    expect(page.totalCount).toBe(42)
    expect(page.items).toHaveLength(1)
    const { query, variables } = bodyOf(fetchMock.mock.calls[0]?.[1])
    expect(variables).toEqual({
      address: ALICE.toLowerCase(),
      limit: 25,
      offset: 50,
    })
    expect(query).toContain('from: $address')
    expect(query).toContain('project { name logoUri tokenSymbol decimals }')
    expect(query).not.toContain('version: 6')
  })
})

describe('owned projects query', () => {
  it('skips the network entirely for an empty owner set', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(getProjectsOwnedBy([])).resolves.toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('queries owner_in with lowercased owners across all versions', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      graphqlResponse({
        data: {
          projects: {
            totalCount: 2,
            items: [
              { chainId: 1, projectId: 3, version: 6, owner: ALICE.toLowerCase() },
              { chainId: 10, projectId: 9, version: 4, owner: ALICE.toLowerCase() },
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
    expect(query).not.toContain('version:')
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
