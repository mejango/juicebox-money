import { NextRequest } from 'next/server'
import { expect, it, vi } from 'vitest'

const row = (chainId: number, volumeUsd: string) => ({
  chainId, projectId: chainId === 42161 ? 4 : 3, suckerGroupId: 'g', volumeUsd, name: 'P', logoUri: null, projectTagline: null, searchTicker: null,
})
const members = [row(10, '1'), row(42161, '900'), row(8453, '5')]
vi.mock('@/lib/bendystraw', () => ({
  searchProjects: async () => [members[1]],
  getSuckerGroupProjects: async () => members,
}))

import { GET } from '@/app/api/search/route'

it('lands a multichain result on its first chain in display order, not its highest-volume one', async () => {
  const { projects } = await (await GET(new NextRequest('https://juicebox.money/api/search?q=p'))).json()
  expect(projects).toHaveLength(1)
  expect(projects[0]).toMatchObject({ chainId: 8453, projectId: 3, chainIds: [8453, 42161, 10] })
})
