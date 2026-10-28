// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { dehydrate, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useShop721Media, type Shop, type ShopMediaResult } from '@/hooks/useShop721'
import { installQueryPersistence, PERSIST, serializeState } from '@/lib/query-persist'
import { ShopMediaStatus } from '@/components/project/ShopMediaStatus'
import { bytes32ToCidV0 } from '@bananapus/nana-sdk-core'

vi.mock('wagmi', () => ({ usePublicClient: () => undefined }))
const digest = (digit: string) => `0x${digit.repeat(64)}` as `0x${string}`
const shop = { hook: `0x${'1'.repeat(40)}`, tiers: [1, 2].map(id => ({ id, encodedIpfsUri: digest(String(id)), resolvedUri: '' })) } as Shop
const sourceKey = shop.tiers.map(tier => `${tier.id}:${tier.encodedIpfsUri}:${tier.resolvedUri}`).join(',')
const key = ['shop721Media', 2, 1, shop.hook, sourceKey]
const oldKey = ['shop721Media', 1, shop.hook, sourceKey]
const firstCid = bytes32ToCidV0(shop.tiers[0].encodedIpfsUri)!
const firstMedia = { name: 'First item', image: 'data:image/png;base64,aGVsbG8=' }
let host: HTMLDivElement
let root: Root | undefined
const clients: QueryClient[] = []
const teardowns: (() => void)[] = []
function client() { const value = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } }); clients.push(value); return value }
function View() {
  const media = useShop721Media(1, shop)
  return <><output>{JSON.stringify(media.data)}</output><ShopMediaStatus failed={media.hasFailures} fetching={media.isFetching} retry={media.refetch} /></>
}
async function mount(queries: QueryClient) { await act(async () => { root = createRoot(host); root.render(<QueryClientProvider client={queries}><View /></QueryClientProvider>) }) }
async function waitFor(check: () => void) {
  await vi.waitFor(async () => {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    check()
  })
}
function restore(previous: QueryClient) {
  const storage = { getItem: () => serializeState(dehydrate(previous)), setItem: vi.fn(), removeItem: vi.fn() } as unknown as Storage
  const next = client()
  teardowns.push(installQueryPersistence(next, storage))
  return next
}
beforeEach(() => { host = document.createElement('div'); document.body.append(host) })
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; teardowns.splice(0).forEach(fn => fn()); clients.splice(0).forEach(value => value.clear()); host.remove() })

describe('shop media availability and persisted recovery', () => {
  it('keeps successful sibling art and retries only the failed item with visible pending feedback', async () => {
    let finish!: (response: Response) => void
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockImplementationOnce(async () => Response.json(firstMedia))
      .mockImplementationOnce(async () => new Response('', { status: 503 }))
      .mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve }))
    vi.stubGlobal('fetch', fetch)
    const queries = client()
    await mount(queries)
    await waitFor(() => expect(host.textContent).toContain('Retry item details'))
    expect(host.querySelector('output')!.textContent).toContain(firstMedia.image)
    expect(queries.getQueryData<ShopMediaResult>(key)?.failedTierIds).toEqual([2])
    await act(async () => host.querySelector('button')!.click())
    await waitFor(() => { expect(fetch).toHaveBeenCalledTimes(3); expect(host.querySelector('button')!.disabled).toBe(true) })
    expect(String(fetch.mock.calls[2][0])).not.toContain(firstCid)
    expect(host.querySelector('button')!.disabled).toBe(true)
    expect(host.textContent).toContain('Retrying…')
    expect(host.querySelector('output')!.textContent).toContain(firstMedia.image)
    await act(async () => { finish(Response.json({ name: 'Second item' })) })
    await waitFor(() => expect(host.querySelector('button')).toBeNull())
    expect(host.textContent).toContain('Second item')
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('revalidates a persisted partial result after reload while retaining successful siblings', async () => {
    const previous = client()
    await previous.fetchQuery({ queryKey: key, meta: PERSIST, queryFn: async (): Promise<ShopMediaResult> => ({ media: { 1: firstMedia }, failedTierIds: [2] }) })
    const queries = restore(previous)
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ name: 'Recovered item' }))
    vi.stubGlobal('fetch', fetch)
    await mount(queries)
    await waitFor(() => expect(host.textContent).toContain('Recovered item'))
    expect(fetch).toHaveBeenCalledOnce()
    expect(host.textContent).toContain(firstMedia.image)
    expect(queries.getQueryData<ShopMediaResult>(key)?.failedTierIds).toEqual([])
  })

  it('ignores pre-fix persisted empty maps instead of trusting them forever', async () => {
    const previous = client()
    await previous.fetchQuery({ queryKey: oldKey, meta: PERSIST, queryFn: async () => ({ 1: {}, 2: {} }) })
    const queries = restore(previous)
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => Response.json({ name: 'Fresh metadata' }))
    vi.stubGlobal('fetch', fetch)
    await mount(queries)
    await waitFor(() => expect(host.textContent).toContain('Fresh metadata'))
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(queries.getQueryData(oldKey)).toEqual({ 1: {}, 2: {} })
  })

  it('treats valid empty JSON as complete and reuses it without presenting a retry', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => Response.json({}))
    vi.stubGlobal('fetch', fetch)
    const queries = client()
    await mount(queries)
    await waitFor(() => expect(queries.getQueryData<ShopMediaResult>(key)?.failedTierIds).toEqual([]))
    expect(host.querySelector('button')).toBeNull()
    await act(async () => { root!.unmount(); root = undefined })
    await mount(restore(queries))
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(host.querySelector('button')).toBeNull()
  })
})
