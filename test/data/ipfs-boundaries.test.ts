import { NextRequest } from 'next/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GET as proxyIpfs } from '@/app/api/ipfs/[...path]/route'
import { POST as pinLogo } from '@/app/api/ipfs/pin-file/route'
import { POST as pinItem } from '@/app/api/ipfs/pin-item/route'
import { POST as pinMetadata } from '@/app/api/ipfs/pin-json/route'
import { POST as pinMedia } from '@/app/api/ipfs/pin-media/route'
import {
  makePinFileHandler,
  PINNING_INGRESS_HEADER,
  pinToIpfs,
  readLimitedJson,
  requirePinningAccess,
} from '@/lib/ipfs-server'

const CID = 'QmbWqxBEKC3P8tqsKc98xmWNzrzDtRLMiMPL8wBuTGsMnR'
const CID_V1 = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
const CID_SHAPED_GARBAGE = 'bafybeigdyrztabcdefghijklmnop'
const INGRESS_TOKEN = 'ingress-token-with-at-least-32-characters'

function enablePinning() {
  vi.stubEnv('IPFS_PINNING_ENABLED', 'true')
  vi.stubEnv('IPFS_PINNING_EDGE_PROTECTED', 'true')
  vi.stubEnv('IPFS_PINNING_INGRESS_TOKEN', INGRESS_TOKEN)
  vi.stubEnv('INFURA_IPFS_PROJECT_ID', 'project-id')
  vi.stubEnv('INFURA_IPFS_API_SECRET', 'project-secret')
}

function pinRequest(
  path: string,
  body: string,
  token: string | null = INGRESS_TOKEN,
) {
  return new NextRequest(`http://localhost/api/ipfs/${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token !== null ? { [PINNING_INGRESS_HEADER]: token } : {}),
    },
    body,
  })
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('IPFS pinning boundary', () => {
  it('fails closed before parsing a request body', async () => {
    const response = await pinMetadata(
      new NextRequest('http://localhost/api/ipfs/pin-json', {
        method: 'POST',
        body: '{not json',
      }),
    )

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({
      error: 'IPFS pinning is unavailable',
    })
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('rejects missing and wrong ingress tokens and accepts the exact token', async () => {
    enablePinning()

    const missing = requirePinningAccess(pinRequest('pin-json', '{}', null))
    expect(missing?.status).toBe(401)
    await expect(missing?.json()).resolves.toEqual({
      error: 'IPFS pinning ingress is not authorized',
    })
    expect(missing?.headers.get('cache-control')).toBe('no-store')

    const wrong = requirePinningAccess(
      pinRequest('pin-json', '{}', 'x'.repeat(INGRESS_TOKEN.length)),
    )
    expect(wrong?.status).toBe(401)
    expect(requirePinningAccess(pinRequest('pin-json', '{}'))).toBeNull()
  })

  it('applies the ingress guard before parsing on every pin route', async () => {
    enablePinning()
    const requests = [
      pinMetadata(pinRequest('pin-json', '{}', null)),
      pinItem(pinRequest('pin-item', '{}', null)),
      pinLogo(
        new NextRequest('http://localhost/api/ipfs/pin-file', {
          method: 'POST',
        }),
      ),
      pinMedia(
        new NextRequest('http://localhost/api/ipfs/pin-media', {
          method: 'POST',
        }),
      ),
    ]

    for (const response of await Promise.all(requests)) {
      expect(response.status).toBe(401)
    }
  })

  it('caps JSON bodies even without trusting application fields', async () => {
    const response = await readLimitedJson(
      new NextRequest('http://localhost/api/ipfs/pin-json', {
        method: 'POST',
        headers: { 'content-length': '9000' },
        body: '{}',
      }),
      8 * 1024,
    )
    expect('response' in response && response.response.status).toBe(413)
  })

  it('rejects unbounded multipart parsing when Content-Length is absent', async () => {
    enablePinning()
    const handler = makePinFileHandler({
      maxBytes: 1024,
      typeAllowed: () => true,
      typeError: 'bad type',
      filename: 'test',
      label: 'test',
    })
    const response = await handler(
      new NextRequest('http://localhost/api/ipfs/pin-file', {
        method: 'POST',
        headers: { [PINNING_INGRESS_HEADER]: INGRESS_TOKEN },
      }),
    )
    expect(response.status).toBe(411)
  })

  it('rejects a malformed CID returned by the pinning provider', async () => {
    enablePinning()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ Hash: 'not-a-cid' })),
    )
    await expect(pinToIpfs('{}')).rejects.toThrow(/invalid CID/i)
  })

  it('rejects a lexically plausible CID with truncated multihash data', async () => {
    enablePinning()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ Hash: CID_SHAPED_GARBAGE })),
    )
    await expect(pinToIpfs('{}')).rejects.toThrow(/invalid CID/i)
  })

  it('requires real CIDv0 or CIDv1 values in pinned metadata URIs', async () => {
    enablePinning()
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(Response.json({ Hash: CID })),
      )
    vi.stubGlobal('fetch', fetchMock)

    const invalidProject = await pinMetadata(
      pinRequest(
        'pin-json',
        JSON.stringify({ name: 'Project', logoUri: 'ipfs://not-a-real-cid' }),
      ),
    )
    const invalidItem = await pinItem(
      pinRequest(
        'pin-item',
        JSON.stringify({ name: 'Item', image: 'ipfs://abc123' }),
      ),
    )
    expect(invalidProject.status).toBe(400)
    expect(invalidItem.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()

    const validV0 = await pinMetadata(
      pinRequest(
        'pin-json',
        JSON.stringify({ name: 'Project', logoUri: `ipfs://${CID}` }),
      ),
    )
    const validV1 = await pinItem(
      pinRequest(
        'pin-item',
        JSON.stringify({ name: 'Item', image: `ipfs://${CID_V1}` }),
      ),
    )
    expect(validV0.status).toBe(200)
    expect(validV1.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('requires CIDv0 for item metadata encoded into the 721 hook', async () => {
    enablePinning()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ Hash: CID_V1 })),
    )

    const response = await pinItem(
      pinRequest('pin-item', JSON.stringify({ name: 'Item' })),
    )
    expect(response.status).toBe(502)
  })
})

describe('same-origin IPFS proxy boundary', () => {
  it('rejects invalid and traversal paths without reaching the gateway', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const response = await proxyIpfs(
      new NextRequest('http://localhost/api/ipfs/bad'),
      { params: Promise.resolve({ path: [CID, '..'] }) },
    )
    expect(response.status).toBe(400)
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('forces active HTML to download under a sandboxed policy', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('<script>alert(1)</script>', {
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'content-length': '25',
          },
        }),
      ),
    )
    const response = await proxyIpfs(
      new NextRequest(`http://localhost/api/ipfs/${CID}`),
      { params: Promise.resolve({ path: [CID] }) },
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/octet-stream')
    expect(response.headers.get('content-disposition')).toContain('attachment')
    expect(response.headers.get('content-security-policy')).toContain('sandbox')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining(CID),
      expect.objectContaining({ cache: 'no-store' }),
    )
  })

  it('never serves executable JavaScript under the application origin', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('globalThis.compromised = true', {
          headers: { 'content-type': 'application/javascript' },
        }),
      ),
    )
    const response = await proxyIpfs(
      new NextRequest(`http://localhost/api/ipfs/${CID}`),
      { params: Promise.resolve({ path: [CID] }) },
    )
    expect(response.headers.get('content-type')).toBe('application/octet-stream')
    expect(response.headers.get('content-disposition')).toContain('attachment')
  })

  it('preserves SVG image rendering but still sandboxes direct navigation', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('<svg xmlns="http://www.w3.org/2000/svg"/>', {
          headers: { 'content-type': 'image/svg+xml' },
        }),
      ),
    )
    const response = await proxyIpfs(
      new NextRequest(`http://localhost/api/ipfs/${CID}`),
      { params: Promise.resolve({ path: [CID] }) },
    )
    expect(response.headers.get('content-type')).toBe('image/svg+xml')
    expect(response.headers.get('content-disposition')).toBeNull()
    expect(response.headers.get('content-security-policy')).toBe(
      "default-src 'none'; sandbox",
    )
  })

  it('rejects an oversized upstream response before proxying its body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('x', {
          headers: {
            'content-type': 'image/png',
            'content-length': String(25 * 1024 * 1024 + 1),
          },
        }),
      ),
    )
    const response = await proxyIpfs(
      new NextRequest(`http://localhost/api/ipfs/${CID}`),
      { params: Promise.resolve({ path: [CID] }) },
    )
    expect(response.status).toBe(413)
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  })
})
