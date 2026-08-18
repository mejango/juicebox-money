import { describe, expect, it } from 'vitest'

import { fullRangeBounds, lpCounterpart, solveRangeFromAmounts } from '@/lib/uniswap-v4'

// The solver turns "I have X project tokens and Y pair tokens" into a concrete
// price range. It pins the floor at the cash-out price and solves the ceiling;
// when the token side is too heavy for any ceiling, it pins the ceiling at the
// issuance price and solves the floor instead. Every valid pair of amounts must
// produce a range, verified by round-tripping through the independent SDK
// counterpart math.

const PRICE = 0.00001
const FLOOR = 6.68961e-8

const relDiff = (a: number, b: number) => Math.abs(a - b) / Math.max(a, b)

describe('solveRangeFromAmounts', () => {
  it('pins the floor and solves the ceiling when the token side fits', () => {
    const solved = solveRangeFromAmounts({
      price: PRICE,
      tokenAmount: 1_000,
      pairAmount: 0.08,
      floorHint: FLOOR,
    })
    expect(solved).not.toBeNull()
    expect(solved!.anchor).toBe('floor')
    expect(solved!.minPrice).toBe(FLOOR)
    expect(solved!.maxPrice).toBeGreaterThan(PRICE)
    const tokenSide = lpCounterpart(0.08, true, PRICE, solved!.minPrice, solved!.maxPrice)
    expect(tokenSide).not.toBeNull()
    expect(relDiff(tokenSide!, 1_000)).toBeLessThan(1e-3)
  })

  it('pins the ceiling and solves the floor when the token side is too heavy', () => {
    // 100k tokens + 0.08 ETH cannot fit above the cash-out floor.
    const solved = solveRangeFromAmounts({
      price: PRICE,
      tokenAmount: 100_000,
      pairAmount: 0.08,
      floorHint: FLOOR,
    })
    expect(solved).not.toBeNull()
    expect(solved!.anchor).toBe('ceiling')
    expect(solved!.maxPrice).toBeCloseTo(PRICE * 2, 10)
    expect(solved!.minPrice).toBeGreaterThan(FLOOR)
    expect(solved!.minPrice).toBeLessThan(PRICE)
    const tokenSide = lpCounterpart(0.08, true, PRICE, solved!.minPrice, solved!.maxPrice)
    expect(tokenSide).not.toBeNull()
    expect(relDiff(tokenSide!, 100_000)).toBeLessThan(1e-3)
  })

  it('honors the issuance ceiling hint when solving the floor', () => {
    const CEILING = 0.0016
    const solved = solveRangeFromAmounts({
      price: PRICE,
      tokenAmount: 100_000,
      pairAmount: 0.08,
      floorHint: FLOOR,
      ceilingHint: CEILING,
    })
    expect(solved).not.toBeNull()
    expect(solved!.anchor).toBe('ceiling')
    expect(solved!.maxPrice).toBe(CEILING)
    const tokenSide = lpCounterpart(0.08, true, PRICE, solved!.minPrice, solved!.maxPrice)
    expect(tokenSide).not.toBeNull()
    expect(relDiff(tokenSide!, 100_000)).toBeLessThan(1e-3)
  })

  it('produces a single-sided token position above spot when pairAmount is 0', () => {
    const CEILING = 0.0016
    const solved = solveRangeFromAmounts({
      price: PRICE,
      tokenAmount: 100_000,
      pairAmount: 0,
      floorHint: FLOOR,
      ceilingHint: CEILING,
    })
    expect(solved).not.toBeNull()
    expect(solved!.anchor).toBe('ceiling')
    expect(solved!.minPrice).toBe(PRICE)
    expect(solved!.maxPrice).toBe(CEILING)
  })

  it('produces a single-sided pair position below spot when tokenAmount is 0', () => {
    const solved = solveRangeFromAmounts({
      price: PRICE,
      tokenAmount: 0,
      pairAmount: 0.08,
      floorHint: FLOOR,
    })
    expect(solved).not.toBeNull()
    expect(solved!.anchor).toBe('floor')
    expect(solved!.minPrice).toBe(FLOOR)
    expect(solved!.maxPrice).toBe(PRICE)
  })

  it('solves a wider ceiling for a heavier token side', () => {
    const small = solveRangeFromAmounts({
      price: PRICE,
      tokenAmount: 500,
      pairAmount: 0.08,
      floorHint: FLOOR,
    })
    const large = solveRangeFromAmounts({
      price: PRICE,
      tokenAmount: 1_000,
      pairAmount: 0.08,
      floorHint: FLOOR,
    })
    expect(small!.maxPrice).toBeLessThan(large!.maxPrice)
  })

  it('falls back to spot/2 when the floor hint is missing or not below spot', () => {
    for (const floorHint of [undefined, null, 0, PRICE, PRICE * 3]) {
      const solved = solveRangeFromAmounts({
        price: PRICE,
        tokenAmount: 1_000,
        pairAmount: 0.08,
        floorHint,
      })
      expect(solved).not.toBeNull()
      expect(solved!.minPrice).toBeCloseTo(PRICE / 2, 12)
    }
  })

  it('falls back to spot*2 when the ceiling hint is not above spot', () => {
    const solved = solveRangeFromAmounts({
      price: PRICE,
      tokenAmount: 100_000,
      pairAmount: 0.08,
      floorHint: FLOOR,
      ceilingHint: PRICE / 2,
    })
    expect(solved).not.toBeNull()
    expect(solved!.anchor).toBe('ceiling')
    expect(solved!.maxPrice).toBeCloseTo(PRICE * 2, 10)
  })

  it('returns null for degenerate inputs', () => {
    const base = {
      price: PRICE,
      tokenAmount: 1_000,
      pairAmount: 0.08,
      floorHint: FLOOR,
    }
    expect(solveRangeFromAmounts({ ...base, tokenAmount: 0, pairAmount: 0 })).toBeNull()
    expect(solveRangeFromAmounts({ ...base, price: 0 })).toBeNull()
    expect(solveRangeFromAmounts({ ...base, price: Number.NaN })).toBeNull()
    expect(solveRangeFromAmounts({ ...base, tokenAmount: -1 })).toBeNull()
    expect(
      solveRangeFromAmounts({ ...base, pairAmount: Number.POSITIVE_INFINITY }),
    ).toBeNull()
  })
})

describe('fullRangeBounds', () => {
  it('spans nine orders of magnitude around spot and yields the v2 pool ratio', () => {
    const bounds = fullRangeBounds(PRICE)
    expect(bounds).not.toBeNull()
    expect(bounds!.minPrice).toBeCloseTo(PRICE / 1e9, 20)
    expect(bounds!.maxPrice).toBeCloseTo(PRICE * 1e9, 2)
    const tokenSide = lpCounterpart(0.08, true, PRICE, bounds!.minPrice, bounds!.maxPrice)
    expect(tokenSide).not.toBeNull()
    expect(relDiff(tokenSide!, 0.08 / PRICE)).toBeLessThan(1e-3)
  })

  it('returns null without a live price', () => {
    expect(fullRangeBounds(0)).toBeNull()
    expect(fullRangeBounds(Number.NaN)).toBeNull()
  })
})
