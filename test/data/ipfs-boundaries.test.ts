import { afterEach, describe, expect, it, vi } from 'vitest'
import { createJBCenterIpfsClient } from '@/lib/jbcenter-ipfs'

const CID = 'QmbWqxBEKC3P8tqsKc98xmWNzrzDtRLMiMPL8wBuTGsMnR'
const PIN = {
  cid: CID,
  status: 'queued',
  uri: `ipfs://${CID}`,
  gatewayUrl: `/ipfs/${CID}`,
}

afterEach(() => vi.unstubAllEnvs())

function successfulFetch() {
  return vi.fn<typeof fetch>().mockResolvedValue(Response.json(PIN))
}

describe('Juicebox Center browser IPFS client', () => {
  it('pins JSON directly through the typed SDK without an API key', async () => {
    const fetchMock = successfulFetch()
    const ipfs = createJBCenterIpfsClient({ fetch: fetchMock })

    await expect(
      ipfs.pinJson({ name: 'Project', optional: undefined }),
    ).resolves.toEqual(PIN)

    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toBe('https://juicebox.center/v1/pins/json')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual({ name: 'Project' })
    expect(new Headers(init?.headers).has('authorization')).toBe(false)
  })

  it.each(['https://dev.juicebox.money', 'http://localhost:3001'])(
    'uses the isolated dev Center for %s',
    async (siteUrl) => {
      vi.stubEnv('NEXT_PUBLIC_SITE_URL', siteUrl)
      const fetchMock = successfulFetch()
      const ipfs = createJBCenterIpfsClient({ fetch: fetchMock })

      await expect(ipfs.pinJson({ name: 'Dev project' })).resolves.toEqual(PIN)
      expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
        'https://dev.juicebox.center/v1/pins/json',
      )
    },
  )

  it.each([
    ['pinImage', 'v1/pins/file', 'image/png'],
    ['pinMedia', 'v1/pins/media', 'video/mp4'],
  ] as const)('uses Center %s for multipart uploads', async (method, path, type) => {
    const fetchMock = successfulFetch()
    const ipfs = createJBCenterIpfsClient({ fetch: fetchMock })
    const file = new File(['content'], `asset.${type.split('/')[1]}`, { type })

    await expect(ipfs[method](file)).resolves.toEqual(PIN)

    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toBe(`https://juicebox.center/${path}`)
    expect(init?.body).toBeInstanceOf(FormData)
    expect((init?.body as FormData).get('file')).toBeInstanceOf(File)
    expect(new Headers(init?.headers).has('authorization')).toBe(false)
  })

  it('surfaces bounded Center errors without exposing implementation secrets', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        { error: { code: 'origin_forbidden', message: 'origin not allowed' } },
        { status: 403 },
      ),
    )
    const ipfs = createJBCenterIpfsClient({ fetch: fetchMock })

    await expect(ipfs.pinJson({ name: 'Project' })).rejects.toThrow(
      'Saving metadata failed: origin not allowed',
    )
  })
})
