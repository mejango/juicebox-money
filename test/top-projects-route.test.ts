import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getTopBalanceProjects: vi.fn(async (limit: number) => Array.from({ length: limit }, (_, rank) => ({ rank }))),
}))
vi.mock('@/lib/top-projects', () => ({ getTopBalanceProjects: mocks.getTopBalanceProjects }))

import { GET } from '@/app/api/top-projects/route'

const page = async (query: string) =>
  (await GET(new Request(`https://juicebox.money/api/top-projects${query}`))).json()

describe('GET /api/top-projects', () => {
  it('defaults to 8 and clamps limit to 1-32, like revnet.money', async () => {
    expect((await page('')).projects).toHaveLength(8)
    expect((await page('?limit=0')).projects).toHaveLength(8)
    expect((await page('?limit=99')).projects).toHaveLength(32)
  })

  it('passes the offset through', async () => {
    await page('?limit=3&offset=2')
    expect(mocks.getTopBalanceProjects).toHaveBeenLastCalledWith(4, 2)
  })
})
