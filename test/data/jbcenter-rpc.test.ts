import { afterEach, describe, expect, it, vi } from 'vitest'
import { mainnet } from 'viem/chains'
import { createPublicClient } from 'viem'
import { jbCenterRpcTransport } from '@/lib/jbcenter-rpc'

afterEach(() => vi.unstubAllGlobals())

describe('Juicebox Center RPC transport', () => {
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
})
