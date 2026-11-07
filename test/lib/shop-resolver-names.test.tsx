import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BaseError, ContractFunctionRevertedError, type Address } from 'viem'
import { useShop721Media, type Shop, type ShopMediaResult } from '@/hooks/useShop721'
import { resolveShopMedia, resolveTierMedia } from '@/lib/shop-read'

const mocks = vi.hoisted(() => ({ read: vi.fn(), kept: vi.fn() }))
vi.mock('wagmi', () => ({ usePublicClient: () => ({ readContract: mocks.read }) }))
vi.mock('@/hooks/useKeptQuery', () => ({ useKeptQuery: (options: unknown) => { mocks.kept(options); return {} } }))

const HOOK = '0x1111111111111111111111111111111111111111' as Address
const STORE = '0x2222222222222222222222222222222222222222' as Address
const DIGEST = `0x${'a'.repeat(64)}` as `0x${string}`
// The shape the Banny resolver returns for /eth:4 tier 5.
const workStation = `data:application/json,${encodeURIComponent(JSON.stringify({
  name: 'Work Station 50/50 remaining: Background UPC #5', productName: 'Work Station',
  categoryName: 'Background', image: 'data:image/svg+xml;base64,PHN2Zy8+',
}))}`
const tier = (id: number) => ({
  id, price: 1n, initial: 50, remaining: 50, category: 1, discountPercent: 0, reserveFrequency: 0,
  votingUnits: 0n, splitPercent: 0, encodedIpfsUri: DIGEST, resolvedUri: '',
})
const reverted = () => new BaseError('reverted', {
  cause: new ContractFunctionRevertedError({ abi: [], functionName: 'tiersOf', message: 'execution reverted' }),
})
const bareArtwork = () => vi.fn(async () => new Response('{}', { status: 200 }))

beforeEach(() => { mocks.read.mockReset(); mocks.kept.mockReset() })
afterEach(() => vi.unstubAllGlobals())

describe('a tier with a digest in a shop with a resolver', () => {
  it('takes its name and category from the resolver, without fetching the digest', async () => {
    const fetcher = bareArtwork()
    vi.stubGlobal('fetch', fetcher)
    const media = await resolveTierMedia(tier(5), async () => workStation)
    expect(media).toMatchObject({ name: 'Work Station', categoryName: 'Background', image: 'data:image/svg+xml;base64,PHN2Zy8+' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('falls back to the digest when the resolver has nothing or reverts', async () => {
    const fetcher = bareArtwork()
    vi.stubGlobal('fetch', fetcher)
    await resolveTierMedia(tier(5), async () => '')
    await resolveTierMedia(tier(5), () => Promise.reject(reverted()))
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('stays retryable when the read fails', async () => {
    vi.stubGlobal('fetch', bareArtwork())
    const read = vi.fn().mockRejectedValue(new Error('fetch failed'))
    const client = { readContract: read } as never
    const result = await resolveShopMedia([tier(5)], undefined, { client, store: STORE, hook: HOOK })
    expect(result).toEqual({ media: {}, failedTierIds: [5] })
  })

  it('reads one exact tier, and a different returned tier names nothing', async () => {
    vi.stubGlobal('fetch', bareArtwork())
    const read = vi.fn().mockResolvedValue([{ id: 6, resolvedUri: workStation }])
    const client = { readContract: read } as never
    const { media } = await resolveShopMedia([tier(5)], undefined, { client, store: STORE, hook: HOOK })
    expect(read.mock.calls[0][0]).toMatchObject({ address: STORE, functionName: 'tiersOf', args: [HOOK, [], true, 5n, 1n] })
    expect(media[5].name).toBeUndefined()
  })
})

function captured(shop: Shop) {
  function Probe() { useShop721Media(1, shop); return null }
  renderToStaticMarkup(createElement(Probe))
  return mocks.kept.mock.calls.at(-1)![0] as {
    queryKey: readonly unknown[]
    queryFn: (context: { client: QueryClient; queryKey: readonly unknown[] }) => Promise<ShopMediaResult>
  }
}
const baseShop = {
  hook: HOOK, store: STORE, cashOutEnabled: false, transfersPaused: null, transferPauseByStage: null,
  configFlags: null, pricing: { currency: 1, decimals: 18, symbol: 'ETH' }, tiers: [tier(5)],
} satisfies Shop

describe('useShop721Media', () => {
  it('asks the resolver under a key unnamed persisted media cannot answer', async () => {
    mocks.read.mockResolvedValue([{ id: 5, resolvedUri: workStation }])
    const query = captured({ ...baseShop, hasTokenUriResolver: true })
    expect(query.queryKey).not.toEqual(captured(baseShop).queryKey)
    const result = await captured({ ...baseShop, hasTokenUriResolver: true })
      .queryFn({ client: new QueryClient(), queryKey: query.queryKey })
    expect(result.media[5].name).toBe('Work Station')
  })

  it('makes no resolver read for a shop without one', async () => {
    vi.stubGlobal('fetch', bareArtwork())
    const query = captured({ ...baseShop, hasTokenUriResolver: false })
    await query.queryFn({ client: new QueryClient(), queryKey: query.queryKey }).catch(() => null)
    expect(mocks.read).not.toHaveBeenCalled()
  })
})
