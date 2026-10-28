import { describe, expect, it, vi } from 'vitest'
import { fetchMetadataJson, MAX_METADATA_BYTES, readMetadataJson } from '@/lib/metadata-json'
import { fillIndexedMetadata } from '@/lib/project-metadata-fill'
import { fetchProjectMetadataJson, mergeProjectMetadata } from '@/lib/project-metadata'
import { getProjectMetadata } from '@/lib/project-server-data'
import { readOriginalShopMetadata } from '@/lib/shop-batch'

vi.mock('next/cache', () => ({ unstable_cache: (read: unknown) => read }))

const URI = 'ipfs://QmbWqxBEKC3P8tqsKc98xmWNzrzDtRLMiMPL8wBuTGsMnR'
const ENCODED_URI = `0x${'a'.repeat(64)}` as const
const encoder = new TextEncoder()

function streamed(text: string, contentLength?: string) {
  const bytes = encoder.encode(text)
  let offset = 0
  const cancel = vi.fn()
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) { controller.close(); return }
      controller.enqueue(bytes.subarray(offset, offset + 65_536))
      offset += 65_536
    },
    cancel,
  })
  return {
    response: new Response(body, { headers: contentLength === undefined ? {} : { 'content-length': contentLength } }),
    cancel,
    consumed: () => Math.min(offset, bytes.length),
  }
}

function exactLimitMetadata() {
  const base = { name: '世界', extensions: { arbitrary: '' } }
  base.extensions.arbitrary = 'a'.repeat(MAX_METADATA_BYTES - encoder.encode(JSON.stringify(base)).byteLength)
  return base
}

describe('bounded metadata JSON', () => {
  it('accepts the full Center JSON pin limit, including UTF-8 split across chunks', async () => {
    expect(MAX_METADATA_BYTES).toBe(2 * 1024 * 1024)
    const metadata = exactLimitMetadata()
    const text = JSON.stringify(metadata)
    expect(encoder.encode(text).byteLength).toBe(MAX_METADATA_BYTES)
    const { response, cancel } = streamed(text)
    await expect(readMetadataJson(response)).resolves.toEqual(metadata)
    expect(cancel).not.toHaveBeenCalled()
    expect(response.body?.locked).toBe(false)
    const utf8 = encoder.encode('{"name":"世界"}')
    const split = new Response(new ReadableStream({ start(controller) {
      for (const byte of utf8) controller.enqueue(new Uint8Array([byte]))
      controller.close()
    } }))
    await expect(readMetadataJson(split)).resolves.toEqual({ name: '世界' })
  })

  it.each([undefined, '2', 'not-a-number'])('counts actual bytes with Content-Length %s and cancels before draining the oversized body', async contentLength => {
    const { response, cancel, consumed } = streamed(JSON.stringify({ extra: 'a'.repeat(MAX_METADATA_BYTES * 2) }), contentLength)
    await expect(readMetadataJson(response)).rejects.toThrow('supported 2 MiB')
    expect(cancel).toHaveBeenCalledOnce()
    expect(consumed()).toBeLessThan(MAX_METADATA_BYTES * 2)
    expect(response.body?.locked).toBe(false)
  })

  it('counts non-ASCII bytes rather than JavaScript characters', async () => {
    const text = JSON.stringify({ extra: '界'.repeat(Math.floor(MAX_METADATA_BYTES / 3)) })
    expect(text.length).toBeLessThan(MAX_METADATA_BYTES)
    expect(encoder.encode(text).byteLength).toBeGreaterThan(MAX_METADATA_BYTES)
    await expect(readMetadataJson(streamed(text).response)).rejects.toThrow('supported 2 MiB')
  })

  it('does not wait for an unread response clone when refusing an oversized body', async () => {
    const { response } = streamed(JSON.stringify({ extra: 'a'.repeat(MAX_METADATA_BYTES) }))
    const clone = response.clone()
    await expect(readMetadataJson(response)).rejects.toThrow('supported 2 MiB')
    expect(response.body?.locked).toBe(false)
    await clone.body?.cancel()
  })

  it('rejects an oversized declared response without reading or parsing it', async () => {
    const { response, cancel } = streamed('{}', String(MAX_METADATA_BYTES + 1))
    await expect(readMetadataJson(response)).rejects.toThrow('supported 2 MiB')
    expect(cancel).toHaveBeenCalledOnce()
    expect(response.body?.locked).toBe(false)
  })

  it('preserves JSON parsing failures, valid empty metadata and missing-body errors', async () => {
    await expect(readMetadataJson(new Response('{}'))).resolves.toEqual({})
    await expect(readMetadataJson(new Response('{'))).rejects.toBeInstanceOf(SyntaxError)
    await expect(readMetadataJson(new Response(null))).rejects.toThrow('no readable body')
  })

  it('disables whole-response fetch caching and aborts the original request after a size failure', async () => {
    let signal: AbortSignal | undefined
    vi.stubGlobal('fetch', vi.fn(async (_url, options: RequestInit) => {
      signal = options.signal ?? undefined
      expect(options.cache).toBe('no-store')
      return streamed(JSON.stringify({ extra: 'a'.repeat(MAX_METADATA_BYTES) })).response
    }))
    await expect(fetchMetadataJson('https://example.invalid/metadata')).rejects.toThrow('supported 2 MiB')
    expect(signal?.aborted).toBe(true)
  })
})

describe('metadata consumer boundaries', () => {
  it('keeps display fallback and fails closed for editing after an oversized response', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => streamed(JSON.stringify({ name: 'Too large', extra: 'a'.repeat(MAX_METADATA_BYTES) }), '2').response)
    vi.stubGlobal('fetch', fetch)
    const row = { projectId: 7, name: null, logoUri: null, metadataUri: URI }
    await expect(fillIndexedMetadata([row])).resolves.toEqual([row])
    await expect(getProjectMetadata(URI)).resolves.toBeNull()
    await expect(fetchProjectMetadataJson(URI)).rejects.toThrow('saving would drop its existing fields')
    await expect(readOriginalShopMetadata(ENCODED_URI)).rejects.toThrow('Could not load the original item metadata')
    expect(fetch).toHaveBeenCalledTimes(4)
    expect(fetch.mock.calls[0][1]).toMatchObject({ cache: 'no-store' })
    expect(fetch.mock.calls[1][1]).toMatchObject({ cache: 'no-store' })
  })

  it('retains the largest supported custom metadata through display and name-only edits', async () => {
    const metadata = exactLimitMetadata()
    vi.stubGlobal('fetch', vi.fn(async () => streamed(JSON.stringify(metadata)).response))
    const row = { projectId: 7, name: null, logoUri: null, metadataUri: URI }
    await expect(fillIndexedMetadata([row])).resolves.toEqual([{ ...row, name: '世界', projectTagline: undefined }])
    await expect(getProjectMetadata(URI)).resolves.toEqual(metadata)
    const current = await fetchProjectMetadataJson(URI)
    expect(mergeProjectMetadata(current, { name: 'New name' }).extensions).toEqual(metadata.extensions)
    await expect(readOriginalShopMetadata(ENCODED_URI)).resolves.toEqual(metadata)
  })

  it('keeps the read timeout active after headers arrive', async () => {
    const controller = new AbortController()
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal)
    vi.stubGlobal('fetch', vi.fn(async (_url, options: RequestInit) => new Response(new ReadableStream({
      start(stream) { options.signal!.addEventListener('abort', () => stream.error(controller.signal.reason)) },
    }))))
    const pending = fetchProjectMetadataJson(URI)
    const rejected = expect(pending).rejects.toThrow('saving would drop its existing fields')
    await Promise.resolve()
    controller.abort()
    await rejected
    expect(AbortSignal.timeout).toHaveBeenCalledWith(15_000)
  })
})
