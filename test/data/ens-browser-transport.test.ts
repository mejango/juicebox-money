import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

describe('ENS project alias transport', () => {
  it('uses Center for production ENS and authoritative alias readers', async () => {
    vi.stubEnv('NEXT_PUBLIC_DETERMINISTIC_BROWSER', 'false')
    const { lookupProjectHandleTarget, lookupVerifiedProjectHandle } = await import('@/lib/ens')
    expect(mocks.http).not.toHaveBeenCalled()
    expect(mocks.fixtureTransport).toHaveBeenCalledWith(1)
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ transport: 'local fixture transport' }))
    expect(await lookupProjectHandleTarget('@browser-fixture')).toMatchObject({ chainId: 1, projectId: 1, handle: 'browser-fixture' })
    expect(await lookupVerifiedProjectHandle({ chainId: 1, projectId: 1, setter: authority })).toBe('browser-fixture')
  })

  it('sends real forward and reverse ENS requests only through Center', async () => {
    vi.stubEnv('NEXT_PUBLIC_DETERMINISTIC_BROWSER', 'false')
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://juicebox.money')
    const viem = await vi.importActual<typeof import('viem')>('viem')
    const center = await vi.importActual<typeof import('@/lib/jbcenter-rpc')>('@/lib/jbcenter-rpc')
    mocks.create.mockImplementation(viem.createPublicClient)
    mocks.fixtureTransport.mockImplementation(center.jbCenterRpcTransport)
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: 'ENS lookup unavailable' } }), {
        headers: { 'content-type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { lookupEnsAddress, lookupEnsName } = await import('@/lib/ens')
    await expect(lookupEnsAddress('someone.eth')).resolves.toBeNull()
    const forwardCalls = fetchMock.mock.calls.length
    expect(forwardCalls).toBeGreaterThan(0)
    await expect(lookupEnsName(authority)).resolves.toBeNull()
    expect(fetchMock.mock.calls.length).toBeGreaterThan(forwardCalls)
    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).toBe('https://juicebox.center/v1/rpc/1')
      expect(JSON.parse(String(init?.body)).method).toBe('eth_call')
      expect(new Headers(init?.headers).get('origin')).toBe('https://juicebox.money')
    }
    expect(mocks.http).not.toHaveBeenCalled()
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
