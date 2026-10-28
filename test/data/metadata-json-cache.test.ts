import { beforeEach, describe, expect, it, vi } from 'vitest'

const caches = vi.hoisted(() => ({ definitions: [] as { key: string[]; revalidate: number }[] }))
vi.mock('next/cache', () => ({
  unstable_cache: (read: (url: string) => Promise<unknown>, key: string[], options: { revalidate: number }) => {
    caches.definitions.push({ key, revalidate: options.revalidate })
    const values = new Map<string, { expires: number; value: unknown }>()
    return async (url: string) => {
      const saved = values.get(url)
      if (saved && saved.expires > Date.now()) return saved.value
      const value = await read(url)
      values.set(url, { expires: Date.now() + options.revalidate * 1_000, value })
      return value
    }
  },
}))

import { MAX_METADATA_BYTES } from '@/lib/metadata-json'
import { readIndexedMetadataJson, readProjectMetadataJson } from '@/lib/metadata-json.server'
import { fillIndexedMetadata } from '@/lib/project-metadata-fill'

const URI = 'ipfs://QmbWqxBEKC3P8tqsKc98xmWNzrzDtRLMiMPL8wBuTGsMnR'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-28T00:00:00Z'))
})

describe('server metadata cache admission', () => {
  it('keeps the existing independent 600/300 second TTLs and caches only parsed results', async () => {
    expect(caches.definitions).toEqual([
      { key: ['bounded-project-metadata-v1', '600', '8000'], revalidate: 600 },
      { key: ['bounded-project-metadata-v1', '300', '10000'], revalidate: 300 },
    ])
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ name: 'Current' }))
    vi.stubGlobal('fetch', fetch)
    const url = 'https://example.invalid/ttl'
    await expect(readIndexedMetadataJson(url)).resolves.toEqual({ name: 'Current' })
    await expect(readProjectMetadataJson(url)).resolves.toEqual({ name: 'Current' })
    vi.setSystemTime(Date.now() + 299_999)
    await readIndexedMetadataJson(url)
    await readProjectMetadataJson(url)
    expect(fetch).toHaveBeenCalledTimes(2)
    vi.setSystemTime(Date.now() + 1)
    await readProjectMetadataJson(url)
    expect(fetch).toHaveBeenCalledTimes(3)
    await readIndexedMetadataJson(url)
    expect(fetch).toHaveBeenCalledTimes(3)
    vi.setSystemTime(Date.now() + 300_000)
    await readIndexedMetadataJson(url)
    expect(fetch).toHaveBeenCalledTimes(4)
    for (const [, options] of fetch.mock.calls) {
      expect(options?.cache).toBe('no-store')
      expect(options).not.toHaveProperty('next')
    }
  })

  it('keeps failures and invalid documents outside the parsed cache, with a retryable display fallback', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response('temporarily unavailable', { status: 503 }))
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(Response.json({ padding: 'a'.repeat(MAX_METADATA_BYTES) }))
      .mockResolvedValueOnce(Response.json({ name: 'Recovered' }))
    vi.stubGlobal('fetch', fetch)
    const row = { name: null, logoUri: null, metadataUri: URI }
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(fillIndexedMetadata([row], readIndexedMetadataJson)).resolves.toEqual([row])
    }
    await expect(fillIndexedMetadata([row], readIndexedMetadataJson)).resolves.toEqual([
      { ...row, name: 'Recovered', projectTagline: undefined },
    ])
    await fillIndexedMetadata([row], readIndexedMetadataJson)
    expect(fetch).toHaveBeenCalledTimes(4)
  })

  it('accepts and caches authoritative empty objects', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({}))
    vi.stubGlobal('fetch', fetch)
    const url = 'https://example.invalid/empty'
    await expect(readProjectMetadataJson(url)).resolves.toEqual({})
    await expect(readProjectMetadataJson(url)).resolves.toEqual({})
    expect(fetch).toHaveBeenCalledOnce()
  })
})
