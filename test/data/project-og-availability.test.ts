import { NextRequest } from 'next/server'
import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ preview: vi.fn() }))
vi.mock('@/lib/project-link-preview', () => ({ getProjectLinkPreview: mocks.preview }))
import { GET } from '@/app/api/project-og/[chainId]/[projectId]/route'

const read = () => GET(new NextRequest('https://juicebox.money/api/project-og/1/45'), { params: Promise.resolve({ chainId: '1', projectId: '45' }) })
describe('project preview identity availability', () => {
  it('returns an uncached 503 for unreadable identity', async () => {
    mocks.preview.mockRejectedValue(new Error('Project identity is unavailable'))
    const response = await read()
    expect(response.status).toBe(503)
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('keeps a confirmed missing project distinguishable', async () => {
    mocks.preview.mockResolvedValue(null)
    expect((await read()).status).toBe(404)
  })
})
