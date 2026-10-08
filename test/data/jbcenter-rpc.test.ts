import { afterEach, describe, expect, it, vi } from 'vitest'
import { mainnet } from 'viem/chains'
import { createPublicClient } from 'viem'
import { jbCenterRpcTransport } from '@/lib/jbcenter-rpc'
import {
  jbCenterAppOrigin,
  jbCenterBaseUrl,
} from '@/lib/jbcenter-config'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('Juicebox Center RPC transport', () => {
  it('does not treat other localhost ports as trusted dev clients', () => {
    expect(jbCenterBaseUrl('http://localhost:3000')).toBe(
      'https://juicebox.center',
    )
    expect(jbCenterAppOrigin('http://localhost:3000')).toBe(
      'https://juicebox.money',
    )
  })

  it('routes server reads through Center with the trusted app origin', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1' }), {
        headers: { 'content-type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const client = createPublicClient({
      chain: mainnet,
      transport: jbCenterRpcTransport(mainnet.id),
    })

    await expect(client.getChainId()).resolves.toBe(mainnet.id)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://juicebox.center/v1/rpc/1')
    expect(new Headers(init.headers).get('origin')).toBe(
      'https://juicebox.money',
    )
  })

  it('calls browser fetch with the Window receiver', async () => {
    const browserWindow = {
      fetch: vi.fn(function (this: unknown) {
        if (this !== browserWindow) throw new TypeError('Illegal invocation')
        return Promise.resolve(
          new Response(
            JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1' }),
            { headers: { 'content-type': 'application/json' } },
          ),
        )
      }),
    }
    vi.stubGlobal('window', browserWindow)
    vi.stubGlobal(
      'fetch',
      vi.fn(function () {
        throw new TypeError('Illegal invocation')
      }),
    )
    const client = createPublicClient({
      chain: mainnet,
      transport: jbCenterRpcTransport(mainnet.id),
    })

    await expect(client.getChainId()).resolves.toBe(mainnet.id)
    expect(browserWindow.fetch).toHaveBeenCalledOnce()
  })

  it.each([
    'https://dev.juicebox.money',
    'http://localhost:3001',
  ])('uses the configured dev Center and app origin for %s', async (siteUrl) => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', siteUrl)
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1' }), {
        headers: { 'content-type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const client = createPublicClient({
      chain: mainnet,
      transport: jbCenterRpcTransport(mainnet.id),
    })

    await expect(client.getChainId()).resolves.toBe(mainnet.id)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://dev.juicebox.center/v1/rpc/1')
    expect(new Headers(init.headers).get('origin')).toBe(siteUrl)
  })

  it('shares browser request-start pacing across chain transports while responses remain pending', async () => {
    vi.useFakeTimers()
    vi.resetModules()
    const { jbCenterRpcTransport: transport } = await import('@/lib/jbcenter-rpc')
    const releases: (() => void)[] = []
    const browserWindow = {
      fetch: vi.fn((input: RequestInfo | URL) => new Promise<Response>(resolve => {
        const chainId = Number(String(input).split('/').at(-1))
        releases.push(() => resolve(new Response(JSON.stringify({
          jsonrpc: '2.0', id: 1, result: `0x${chainId.toString(16)}`,
        }), { headers: { 'content-type': 'application/json' } })))
      })),
    }
    vi.stubGlobal('window', browserWindow)
    const chains = Array.from({ length: 12 }, (_, index) => [1, 10, 8453, 42161][index % 4])
    const requests = chains.map(chainId =>
      createPublicClient({ transport: transport(chainId) }).getChainId(),
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(browserWindow.fetch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(374)
    expect(browserWindow.fetch).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(browserWindow.fetch).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(1000)
    expect(browserWindow.fetch).toHaveBeenCalledTimes(12)
    releases.reverse().forEach(release => release())
    await expect(Promise.all(requests)).resolves.toEqual(chains)
  })


  it('waits through a 60-second browser cooldown before starting request timeouts', async () => {
    vi.useFakeTimers()
    vi.resetModules()
    const { jbCenterRpcTransport: transport } = await import('@/lib/jbcenter-rpc')
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal?.aborted) throw init.signal.reason
      if (fetchMock.mock.calls.length === 1) {
        return Response.json({}, { status: 429, headers: { 'Retry-After': '60' } })
      }
      const { id } = JSON.parse(String(init?.body)) as { id: number }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id, result: '0x1' }), {
        headers: { 'content-type': 'application/json' },
      })
    })
    vi.stubGlobal('window', { fetch: fetchMock })
    const outcomes: unknown[] = []
    const requests = [1, 1].map(() => createPublicClient({ transport: transport(1) }).getChainId()
      .then(result => { outcomes.push(result) }, error => { outcomes.push(error) }))
    await vi.advanceTimersByTimeAsync(59_999)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(outcomes).toEqual([])
    await vi.advanceTimersByTimeAsync(1_001)
    await Promise.all(requests)
    expect(outcomes).toEqual([1, 1])
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})
