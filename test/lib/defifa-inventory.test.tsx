import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { NATIVE_TOKEN } from '@bananapus/nana-sdk-core'
import type { ProjectDefifaInventory } from '@bananapus/nana-sdk-core/v6'
import type { PublicClient } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ inventory: vi.fn(), current: vi.fn() }))
vi.mock('@bananapus/nana-sdk-core/v6', async original => ({
  ...await original(), getProjectNftInventory: mocks.inventory, getCurrentRuleset: mocks.current,
}))
import { readShop, resolveTierMedia } from '@/lib/shop-read'
import { DefifaInventory } from '@/components/project/DefifaInventory'

const hook = '0x1111111111111111111111111111111111111111'
function page(id: number, next: bigint | null): ProjectDefifaInventory {
  return {
    protocol: 'defifa', hook, store: hook, implementation: hook,
    contractUri: 'ipfs://market', blockNumber: 99n, phase: 4,
    pricing: { currency: 1, decimals: 6, token: NATIVE_TOKEN },
    capabilities: { genericPay: false, genericCashOut: false, manageTiers: false },
    nextStartingId: next,
    tiers: [{ id, name: `Range ${id}`, currentSupply: 123n, price: 1250000n,
      remainingSupply: 100, initialSupply: 1000, category: 0, discountPercent: 0,
      reserveFrequency: 0, votingUnits: 0n, encodedIpfsUri: `0x${'0'.repeat(64)}`,
      resolvedUri: '', }],
    ruleset: {} as ProjectDefifaInventory['ruleset'],
  }
}

beforeEach(() => { vi.clearAllMocks(); mocks.current.mockResolvedValue(null) })

describe('native market inventory', () => {
  it('uses SDK native names, exact decimals and current supply, snapshots every page, and has no generic writer identity', async () => {
    mocks.inventory.mockResolvedValueOnce(page(1, 2n)).mockResolvedValueOnce(page(2, null))
    const readContract = vi.fn(() => { throw new Error('Unexpected generic shop read') })
    const shop = await readShop({ readContract } as unknown as PublicClient, 8453, 27, false, 'ETH')
    expect(shop?.protocol).toBe('defifa')
    expect(shop?.idTarget).toBeUndefined()
    expect(shop?.cashOutEnabled).toBe(false)
    expect(shop?.capabilities).toEqual({ genericPay: false, genericCashOut: false, manageTiers: false })
    expect(shop?.tiers.map(tier => [tier.name, tier.currentSupply])).toEqual([['Range 1', 123n], ['Range 2', 123n]])
    expect(mocks.inventory.mock.calls[1][1]).toMatchObject({ blockNumber: 99n, startingId: 2n })
    expect(readContract).not.toHaveBeenCalled()
    expect(await resolveTierMedia(shop!.tiers[0])).toEqual({ name: 'Range 1' })
    const html = renderToStaticMarkup(createElement(DefifaInventory, { chainId: 8453, projectId: 27, shop: shop! }))
    expect(html).toContain('Range 1')
    expect(html).toContain('1.25')
    expect(html).toContain('123')
    expect(html).toContain('https://metalog.money/markets/8453/27')
    expect(html).not.toContain('<button')
    expect(html).not.toContain('Unlimited')
  })

  it('propagates unknown/RPC failures rather than inventing a missing market', async () => {
    mocks.inventory.mockRejectedValue(new Error('Center unavailable'))
    await expect(readShop({} as PublicClient, 8453, 27, false, 'ETH')).rejects.toThrow('Center unavailable')
  })

  it('refuses repeated native ranges and cyclic cursors', async () => {
    mocks.inventory.mockResolvedValueOnce(page(1, 2n)).mockResolvedValueOnce(page(1, null))
    await expect(readShop({} as PublicClient, 8453, 27, false, 'ETH')).rejects.toThrow('repeated a range')
    mocks.inventory.mockResolvedValueOnce(page(1, 2n)).mockResolvedValueOnce(page(2, 2n))
    await expect(readShop({} as PublicClient, 8453, 27, false, 'ETH')).rejects.toThrow('invalid inventory cursor')
  })

  it('refuses a family change during pagination', async () => {
    mocks.inventory.mockResolvedValueOnce(page(1, 2n)).mockResolvedValueOnce(null)
    await expect(readShop({} as PublicClient, 8453, 27, false, 'ETH')).rejects.toThrow('inventory changed')
  })
})
