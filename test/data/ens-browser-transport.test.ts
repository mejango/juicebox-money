import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  create: vi.fn(), http: vi.fn(), fixtureTransport: vi.fn(),
  direct: vi.fn(), reverse: vi.fn(), address: vi.fn(), name: vi.fn(),
}))
vi.mock('viem', async importOriginal => ({
  ...await importOriginal<typeof import('viem')>(),
  createPublicClient: mocks.create,
  http: mocks.http,
}))
vi.mock('@/lib/jbcenter-rpc', () => ({ jbCenterRpcTransport: mocks.fixtureTransport }))
vi.mock('@/lib/project-handles', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/project-handles')>(),
  readDirectEnsProjectRecord: mocks.direct,
  readBoundedProjectHandle: mocks.reverse,
}))

const authority = `0x${'11'.repeat(20)}` as const
beforeEach(() => {
  vi.resetModules()
  mocks.create.mockReturnValue({ getEnsAddress: mocks.address, getEnsName: mocks.name })
  mocks.http.mockReturnValue('production transport')
  mocks.fixtureTransport.mockReturnValue('local fixture transport')
  mocks.direct.mockResolvedValue({ textRecord: '1:1' })
  mocks.reverse.mockResolvedValue('browser-fixture')
})

describe('ENS project alias transport', () => {
  it('keeps the production public RPC and authoritative alias readers unchanged', async () => {
    vi.stubEnv('NEXT_PUBLIC_DETERMINISTIC_BROWSER', 'false')
    const { lookupProjectHandleTarget, lookupVerifiedProjectHandle } = await import('@/lib/ens')
    expect(mocks.http).toHaveBeenCalledWith('https://ethereum-rpc.publicnode.com')
    expect(mocks.fixtureTransport).not.toHaveBeenCalled()
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ transport: 'production transport' }))
    expect(await lookupProjectHandleTarget('@browser-fixture')).toMatchObject({ chainId: 1, projectId: 1, handle: 'browser-fixture' })
    expect(await lookupVerifiedProjectHandle({ chainId: 1, projectId: 1, setter: authority })).toBe('browser-fixture')
  })

  it('uses the existing local mainnet RPC fixture for real alias reads while skipping wallet names', async () => {
    vi.stubEnv('NEXT_PUBLIC_DETERMINISTIC_BROWSER', 'true')
    const { lookupProjectHandleTarget, lookupVerifiedProjectHandle, lookupEnsAddress, lookupEnsName } = await import('@/lib/ens')
    expect(mocks.fixtureTransport).toHaveBeenCalledWith(1)
    expect(mocks.http).not.toHaveBeenCalled()
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ transport: 'local fixture transport' }))
    expect(await lookupProjectHandleTarget('@browser-fixture')).toMatchObject({ chainId: 1, projectId: 1 })
    expect(mocks.direct).toHaveBeenCalledWith(expect.anything(), 'browser-fixture.eth')
    expect(await lookupVerifiedProjectHandle({ chainId: 1, projectId: 1, setter: authority })).toBe('browser-fixture')
    expect(await lookupEnsAddress('someone.eth')).toBeNull()
    expect(await lookupEnsName(authority)).toBeNull()
    expect(mocks.address).not.toHaveBeenCalled()
    expect(mocks.name).not.toHaveBeenCalled()
  })
})
