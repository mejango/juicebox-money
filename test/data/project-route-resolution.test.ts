import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ target: vi.fn(), project: vi.fn(), authority: vi.fn(), matches: vi.fn() }))
vi.mock('@/lib/ens', () => ({ lookupProjectHandleTarget: mocks.target, lookupVerifiedProjectHandle: vi.fn() }))
vi.mock('@/lib/project-server-data', () => ({ getProjectPageData: mocks.project }))
vi.mock('@/lib/bendystraw', () => ({ getRevnetOperatorCandidates: async () => [] }))
vi.mock('@/lib/project-fallback', () => ({
  readLiveProjectAuthorityContext: mocks.authority,
  projectAuthorityMatchesMainnet: mocks.matches,
  revnetOperatorFromPermissionHistory: vi.fn(),
}))
vi.mock('@/lib/project-handles', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/project-handles')>(),
  verifyProjectHandleAuthorityWithFallback: async ({ authorityContext }: { authorityContext: unknown }) => authorityContext,
}))
const target = { chainId: 8453, projectId: 7 }
const authority = `0x${'12'.repeat(20)}`
beforeEach(() => {
  vi.resetModules()
  mocks.target.mockReset().mockResolvedValue(target)
  mocks.project.mockReset().mockResolvedValue({ project: target, degraded: false })
  mocks.authority.mockReset().mockResolvedValue({ authority, isRevnet: true })
  mocks.matches.mockReset().mockResolvedValue(true)
})

describe('five-second verified alias owner', () => {
  it('normalizes encoded aliases, shares concurrent reads, and hard-expires success without renewing checkedAt', async () => {
    vi.useFakeTimers()
    const { resolveProjectRoute, projectRouteSnapshot } = await import('@/lib/project-route.server')
    const [first, second] = await Promise.all([resolveProjectRoute('@design.juicebox'), resolveProjectRoute('%40design.juicebox')])
    expect(first).toEqual(second)
    expect(mocks.target).toHaveBeenCalledTimes(1)
    const checkedAt = first!.checkedAt
    vi.advanceTimersByTime(4_999)
    expect((await resolveProjectRoute('@design.juicebox'))!.checkedAt).toBe(checkedAt)
    expect(projectRouteSnapshot(first!).checkedAt).toBe(checkedAt)
    expect(projectRouteSnapshot(first!).serverNow).toBe(Date.now())
    vi.advanceTimersByTime(2)
    expect((await resolveProjectRoute('@design.juicebox'))!.checkedAt).toBe(Date.now())
    expect(mocks.target).toHaveBeenCalledTimes(2)
  })
  it('lets a pre-mutation request finish but forced waiters share a new post-mutation proof', async () => {
    let finish!: (value: typeof target) => void
    mocks.target.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const { resolveProjectRoute } = await import('@/lib/project-route.server')
    const normal = resolveProjectRoute('@design.juicebox')
    mocks.target.mockResolvedValue({ ...target, projectId: 8 })
    const forced = resolveProjectRoute('@design.juicebox', true)
    const concurrentForced = resolveProjectRoute('@design.juicebox', true)
    expect(mocks.target).toHaveBeenCalledTimes(1)
    finish(target)
    expect((await normal)?.projectId).toBe(7)
    expect((await forced)?.projectId).toBe(8)
    expect((await concurrentForced)?.projectId).toBe(8)
    expect(mocks.target).toHaveBeenCalledTimes(2)
  })
  it('still performs a forced fresh proof after the earlier in-flight proof fails', async () => {
    let fail!: (error: Error) => void
    mocks.target.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject }))
    const { resolveProjectRoute } = await import('@/lib/project-route.server')
    const normal = resolveProjectRoute('@design.juicebox').catch(error => error)
    mocks.target.mockResolvedValue({ ...target, projectId: 8 })
    const forced = resolveProjectRoute('@design.juicebox', true)
    fail(new Error('Old proof unavailable'))
    expect(await normal).toMatchObject({ message: 'Old proof unavailable' })
    expect((await forced)?.projectId).toBe(8)
    expect(mocks.target).toHaveBeenCalledTimes(2)
  })
  it('never caches rejected identity and preserves unavailable exceptions for the page error boundary', async () => {
    const { resolveProjectRoute } = await import('@/lib/project-route.server')
    mocks.target.mockResolvedValueOnce(null)
    expect(await resolveProjectRoute('@design.juicebox')).toBeNull()
    mocks.project.mockRejectedValueOnce(new Error('Project identity is temporarily unavailable.'))
    await expect(resolveProjectRoute('@design.juicebox')).rejects.toThrow('temporarily unavailable')
    expect((await resolveProjectRoute('@design.juicebox'))?.projectId).toBe(7)
    expect(mocks.target).toHaveBeenCalledTimes(3)
  })
  it('keeps aliases and numeric projects isolated', async () => {
    const { resolveProjectRoute } = await import('@/lib/project-route.server')
    expect((await resolveProjectRoute('base:8'))?.projectId).toBe(8)
    expect(mocks.target).not.toHaveBeenCalled()
    await resolveProjectRoute('@design.juicebox')
    mocks.target.mockResolvedValue({ ...target, projectId: 9 })
    expect((await resolveProjectRoute('@other.juicebox'))?.projectId).toBe(9)
  })
  it('invalidates old success after an unsuccessful forced proof without waiting for its TTL', async () => {
    const { resolveProjectRoute } = await import('@/lib/project-route.server')
    await resolveProjectRoute('@design.juicebox')
    mocks.project.mockRejectedValueOnce(new Error('RPC unavailable'))
    await expect(resolveProjectRoute('@design.juicebox', true)).rejects.toThrow('RPC unavailable')
    expect((await resolveProjectRoute('@design.juicebox'))?.projectId).toBe(7)
    expect(mocks.target).toHaveBeenCalledTimes(3)
  })
})
