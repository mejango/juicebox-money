import { describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ resolve: vi.fn() }))
vi.mock('@/lib/project-route.server', () => ({ resolveProjectRoute: mocks.resolve, projectRouteSnapshot: (value: unknown) => value }))
import { GET } from '@/app/api/project-route/route'
import { readProjectRouteSnapshot } from '@/lib/project-route'
const authority = `0x${'12'.repeat(20)}`

describe('public alias verification endpoint', () => {
  it('accepts only explicit aliases, serializes exact IDs, and prohibits HTTP caching', async () => {
    const snapshot = { chainId: 8453, projectId: '7', handle: 'design.juicebox', authority, isRevnet: true, checkedAt: Date.now(), serverNow: Date.now() }
    mocks.resolve.mockResolvedValue(snapshot)
    const response = await GET(new Request('https://juicebox.test/api/project-route?segment=%40design.juicebox&fresh=1'))
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(await response.json()).toEqual(snapshot)
    expect(mocks.resolve).toHaveBeenCalledWith('@design.juicebox', true)
    expect((await GET(new Request('https://juicebox.test/api/project-route?segment=base:7'))).status).toBe(400)
    expect((await GET(new Request('https://juicebox.test/api/project-route?segment=%252540design.juicebox'))).status).toBe(400)
  })
  it('reports unavailable verification without exposing internals or a missing-project claim', async () => {
    mocks.resolve.mockRejectedValue(new Error('private RPC URL'))
    const response = await GET(new Request('https://juicebox.test/api/project-route?segment=%40design.juicebox'))
    expect(response.status).toBe(503)
    expect(JSON.stringify(await response.json())).not.toContain('private RPC URL')
  })
  it('accounts for server age and request transit without requiring synchronized clocks', () => {
    vi.useFakeTimers()
    vi.setSystemTime(50_000)
    const wire = { chainId: 8453, projectId: '7', handle: 'design.juicebox', authority, isRevnet: true, checkedAt: 1_000_000, serverNow: 1_001_000 }
    const local = readProjectRouteSnapshot(wire, wire.handle, 49_000)
    expect(local.checkedAt).toBe(48_000)
    expect(() => readProjectRouteSnapshot(wire, wire.handle, 45_000)).toThrow('expired')
    expect(() => readProjectRouteSnapshot({ ...wire, projectId: '9007199254740992' }, wire.handle, 49_000)).toThrow()
  })
})
