import { describe, expect, it, vi } from 'vitest'

const E18 = 10n ** 18n

function project(chainId: number, projectId: number, balanceUsd: string | null, name: string | null = 'Markee') {
  return {
    projectId, chainId, version: 6, name, logoUri: null, projectTagline: null, volume: '0',
    volumeUsd: '0', balance: '0', balanceUsd, paymentsCount: 1, contributorsCount: 1, createdAt: 1,
    suckerGroupId: `g${projectId}`, token: null, tokenSymbol: 'ETH', decimals: 18, currency: 1,
    isRevnet: true, owner: null, metadataUri: null,
  }
}

const groups = [
  {
    id: 'g7', balanceUsd: String(8_985n * E18), volumeUsd: '0',
    projects: { items: [
      project(1, 7, String(7n * E18)),
      project(10, 7, '0'),
      project(8453, 7, String(8_977n * E18)),
      project(42161, 7, '0'),
    ] },
  },
  // Equal balances keep the first member.
  {
    id: 'g8', balanceUsd: String(20n * E18), volumeUsd: '0',
    projects: { items: [project(1, 8, String(10n * E18)), project(8453, 8, String(10n * E18))] },
  },
  // Unpriced members keep the first member, and an unnamed pick borrows a member's name.
  {
    id: 'g9', balanceUsd: String(10n * E18), volumeUsd: '0',
    projects: { items: [project(1, 9, null, null), project(8453, 9, null, 'Named')] },
  },
]

vi.mock('next/cache', () => ({ unstable_cache: (fn: unknown) => fn }))
vi.mock('@/lib/project-metadata-fill', () => ({ fillIndexedMetadata: async (items: unknown) => items }))
vi.mock('@/lib/bendystraw', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/bendystraw')>()),
  bendystraw: async () => ({ suckerGroups: { items: groups, totalCount: groups.length } }),
}))

const { getTopBalanceProjects } = await import('@/lib/top-projects')
const { default: sitemap } = await import('@/app/sitemap')

describe('top projects', () => {
  it('links each cross-chain group to the member holding its balance', async () => {
    const top = await getTopBalanceProjects()
    expect(top.map(item => [item.href, item.name])).toEqual([
      ['/base:7', 'Markee'],
      ['/eth:8', 'Markee'],
      ['/eth:9', 'Named'],
    ])
  })

  it('lists the same deployment in the sitemap', async () => {
    const urls = (await sitemap()).map(entry => new URL(entry.url).pathname)
    expect(urls).toEqual(expect.arrayContaining(['/base:7', '/eth:8', '/eth:9']))
    expect(urls).not.toContain('/eth:7')
  })
})
