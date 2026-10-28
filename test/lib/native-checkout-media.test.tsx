import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Address } from 'viem'
import { NFT_CHECKOUT_PREVIEW_PAGE_SIZE, useShop721Media, type Shop, type ShopMediaResult } from '@/hooks/useShop721'

const mocks = vi.hoisted(() => ({ read: vi.fn(), kept: vi.fn() }))
vi.mock('wagmi', () => ({ usePublicClient: () => ({ readContract: mocks.read }) }))
vi.mock('@/hooks/useKeptQuery', () => ({ useKeptQuery: (options: unknown) => { mocks.kept(options); return {} } }))

type MediaQuery = { queryKey: readonly unknown[]; queryFn: () => Promise<Record<number, { name?: string; image?: string }>> }
type TierRead = { address: Address; functionName: string; args: readonly [Address, readonly number[], boolean, bigint, bigint]; blockNumber?: bigint }
const HOOK = '0x1111111111111111111111111111111111111111' as Address
const STORE = '0x2222222222222222222222222222222222222222' as Address
const OTHER = '0x3333333333333333333333333333333333333333' as Address
const IMAGE = 'data:image/png;base64,aGVsbG8='
const resolved = (id: number) => `data:application/json,${encodeURIComponent(JSON.stringify({ name: `Resolver name ${id}`, image: IMAGE }))}`
function inventory(): Shop {
  return {
    protocol: 'defifa', hook: HOOK, store: STORE, inventoryBlockNumber: 12345n,
    cashOutEnabled: false, transfersPaused: null, transferPauseByStage: null, configFlags: null,
    pricing: { currency: 1, decimals: 18, symbol: 'ETH' },
    tiers: Array.from({ length: 20 }, (_, index) => ({
      id: index + 1, name: `Authoritative team ${index + 1}`, price: BigInt(index + 1), initial: 100,
      remaining: 50, currentSupply: 50n, category: 0, discountPercent: 0, reserveFrequency: 0,
      votingUnits: 1n, splitPercent: 0, encodedIpfsUri: `0x${'0'.repeat(64)}` as `0x${string}`, resolvedUri: '',
    })),
  }
}
function MediaProbe({ shop, ids, chainId }: { shop: Shop; ids: readonly number[]; chainId: 1 | 8453 }) {
  useShop721Media(chainId, shop, ids)
  return null
}
function query(shop: Shop, ids: readonly number[], chainId: 1 | 8453 = 8453): MediaQuery {
  renderToStaticMarkup(createElement(MediaProbe, { shop, ids, chainId }))
  const captured = mocks.kept.mock.calls.at(-1)![0] as { queryKey: readonly unknown[]; queryFn: (context: { client: QueryClient; queryKey: readonly unknown[] }) => Promise<ShopMediaResult> }
  const client = new QueryClient()
  return { queryKey: captured.queryKey, queryFn: async () => (await captured.queryFn({ client, queryKey: captured.queryKey })).media }
}
const allIds = Array.from({ length: 20 }, (_, index) => index + 1)
let fetch: ReturnType<typeof vi.fn>
beforeEach(() => {
  mocks.read.mockReset()
  mocks.kept.mockReset()
  fetch = vi.fn(() => { throw new Error('Native inline media must not use a network gateway.') })
  vi.stubGlobal('fetch', fetch)
})
afterEach(() => vi.unstubAllGlobals())

describe('native checkout cosmetic media admission', () => {
  it('bounds twenty requested previews and pending RPC concurrency at the authenticated one-tier snapshot', async () => {
    expect(NFT_CHECKOUT_PREVIEW_PAGE_SIZE).toBe(12)
    const shop = inventory()
    const original = structuredClone(shop)
    const pending: (() => void)[] = []
    let running = 0
    let highest = 0
    mocks.read.mockImplementation((request: TierRead) => new Promise(resolve => {
      running += 1
      highest = Math.max(highest, running)
      pending.push(() => { running -= 1; resolve([{ id: Number(request.args[3]), resolvedUri: resolved(Number(request.args[3])) }]) })
    }))
    const loading = query(shop, allIds).queryFn()
    await vi.waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(2))
    pending.shift()!()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(mocks.read).toHaveBeenCalledTimes(2)
    expect(running).toBe(1)
    pending.shift()!()
    for (let completed = 2; completed < NFT_CHECKOUT_PREVIEW_PAGE_SIZE; completed += 2) {
      await vi.waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(completed + 2))
      pending.shift()!(); pending.shift()!()
    }
    const media = await loading
    expect(highest).toBe(2)
    expect(mocks.read).toHaveBeenCalledTimes(NFT_CHECKOUT_PREVIEW_PAGE_SIZE)
    expect(Object.keys(media).map(Number)).toEqual(allIds.slice(0, NFT_CHECKOUT_PREVIEW_PAGE_SIZE))
    for (const [request] of mocks.read.mock.calls as [TierRead][]) {
      expect(request.address).toBe(STORE)
      expect(request.functionName).toBe('tiersOf')
      expect(request.args).toEqual([HOOK, [], true, request.args[3], 1n])
      expect(request.blockNumber).toBe(12345n)
    }
    expect(media[1]).toMatchObject({ name: 'Authoritative team 1', image: IMAGE })
    expect(shop).toEqual(original)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('separates cosmetic caches by authenticated chain, store, block, selected tiers and URI identity', () => {
    const shop = inventory()
    const client = new QueryClient()
    const baseline = query(shop, allIds).queryKey
    client.setQueryData(baseline, { 1: { image: IMAGE } })
    const variants = [
      query(shop, allIds, 1).queryKey,
      query({ ...shop, store: OTHER }, allIds).queryKey,
      query({ ...shop, inventoryBlockNumber: 12346n }, allIds).queryKey,
      query(shop, [13, 14]).queryKey,
      query({ ...shop, tiers: shop.tiers.map(tier => tier.id === 1 ? { ...tier, resolvedUri: resolved(1) } : tier) }, allIds).queryKey,
    ]
    for (const key of variants) {
      expect(key).not.toEqual(baseline)
      expect(client.getQueryData(key)).toBeUndefined()
    }
    expect(client.getQueryData(query(shop, allIds).queryKey)).toEqual({ 1: { image: IMAGE } })
    client.clear()
  })

  it('keeps authoritative names and inventory intact when cosmetic resolver reads fail', async () => {
    const shop = inventory()
    const original = structuredClone(shop)
    mocks.read.mockRejectedValue(new Error('Cosmetic resolver unavailable'))
    const media = await query(shop, allIds).queryFn()
    expect(mocks.read).toHaveBeenCalledTimes(NFT_CHECKOUT_PREVIEW_PAGE_SIZE)
    expect(media).toEqual({})
    expect(shop).toEqual(original)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('loads only selected later-page tiers and reuses admitted inline media without another resolver read', async () => {
    const shop = inventory()
    shop.tiers[12].resolvedUri = resolved(13)
    mocks.read.mockImplementation(async (request: TierRead) => [{ id: Number(request.args[3]), resolvedUri: resolved(Number(request.args[3])) }])
    const media = await query(shop, allIds.slice(12)).queryFn()
    expect(Object.keys(media).map(Number)).toEqual(allIds.slice(12))
    expect(mocks.read).toHaveBeenCalledTimes(7)
    expect(mocks.read.mock.calls.map(([request]) => Number((request as TierRead).args[3]))).toEqual(allIds.slice(13))
    expect(media[13]).toMatchObject({ name: 'Authoritative team 13', image: IMAGE })
    expect(fetch).not.toHaveBeenCalled()
  })
})
