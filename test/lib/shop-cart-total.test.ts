import { describe, expect, it } from 'vitest'
import { shopCartTotal } from '@/lib/shop-cart-total'

describe('shop subtotal', () => {
  it('totals mixed discounted prices exactly, independently of category ordering and omitted quantities', () => {
    const tiers = [
      { id: 3, price: 101n, discountPercent: 1 },
      { id: 1, price: 1_000_000_000_000_000_001n, discountPercent: 0 },
      { id: 2, price: 200n, discountPercent: 50 },
      { id: 4, price: 999n, discountPercent: 0 },
    ]
    expect(shopCartTotal(tiers, { 1: 2, 2: 3, 3: 4, 99: 12 })).toBe(2_000_000_000_000_000_856n)
    expect(shopCartTotal(tiers.filter(tier => tier.id === 2), { 1: 2, 2: 3 })).toBe(450n)
  })

  it('returns zero for empty selections and free tiers without requiring a payment route', () => {
    expect(shopCartTotal([], { 1: 2 })).toBe(0n)
    expect(shopCartTotal([{ id: 1, price: 100n, discountPercent: 0 }], {})).toBe(0n)
    expect(shopCartTotal([{ id: 1, price: 0n, discountPercent: 0 }], { 1: 8 })).toBe(0n)
  })
})
