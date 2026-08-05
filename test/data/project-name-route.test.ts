import { NextRequest } from 'next/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ getProjectPageData: vi.fn() }))

vi.mock('@/lib/project-fallback', () => ({
  getProjectPageData: mocks.getProjectPageData,
}))

import { GET } from '@/app/api/project-name/route'

afterEach(() => mocks.getProjectPageData.mockReset())

describe('project-name route', () => {
  it('keeps existence separate from optional indexed naming', async () => {
    mocks.getProjectPageData.mockResolvedValue({
      degraded: true,
      reason: 'not-indexed',
      project: { name: null, suckerGroupId: null },
    })

    const response = await GET(
      new NextRequest(
        'http://localhost/api/project-name?chainId=84532&projectId=16',
      ),
    )

    expect(await response.json()).toEqual({
      found: true,
      name: null,
      suckerGroupId: null,
    })
  })

  it('reports a project as missing only after the indexed/onchain resolver misses', async () => {
    mocks.getProjectPageData.mockResolvedValue(null)

    const response = await GET(
      new NextRequest(
        'http://localhost/api/project-name?chainId=11155111&projectId=16',
      ),
    )

    expect(await response.json()).toEqual({
      found: false,
      name: null,
      suckerGroupId: null,
    })
  })
})
