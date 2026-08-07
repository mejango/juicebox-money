// Sentinels that must agree across encode and decode, and guards on values that collide with
// protocol sentinels. All of these write IMMUTABLE ruleset configs.
import { CASH_OUTS_OFF, CASH_OUTS_OFF_REVNET, splitShares } from '@/lib/launch'
import { describe, expect, it } from 'vitest'

describe('cash-out-off sentinels', () => {
  it('keeps the revnet value below the standard one', () => {
    // REVDeployer reverts with CashOutsCantBeTurnedOffCompletely at >= MAX_CASH_OUT_TAX_RATE,
    // so a revnet cannot encode 10,000 and uses 9,999 instead.
    expect(CASH_OUTS_OFF).toBe(10_000)
    expect(CASH_OUTS_OFF_REVNET).toBe(9_999)
    expect(CASH_OUTS_OFF_REVNET).toBeLessThan(CASH_OUTS_OFF)
  })

  it('round-trips "off" through the export decode', () => {
    // The decode used `< 10_000`, so an exported revnet came back with cash outs ENABLED at
    // 99.99%. Both sentinels must read as off.
    const decodeCashOutsOn = (rate: number) => rate < CASH_OUTS_OFF_REVNET
    expect(decodeCashOutsOn(CASH_OUTS_OFF_REVNET)).toBe(false)
    expect(decodeCashOutsOn(CASH_OUTS_OFF)).toBe(false)
    // A real tax still reads as on.
    expect(decodeCashOutsOn(2_500)).toBe(true)
  })
})

// One normalizer, not three. The copies used two different rounding modes and only one had a
// zero-guard, so the others could emit a final share of zero — which reverts on-chain.
describe('splitShares', () => {
  it('always sums to exactly 1e9', () => {
    for (const values of [[1, 1, 1], [60, 40], [33.33, 33.33, 33.34], [1, 1, 1, 1, 1, 1, 7]]) {
      expect(splitShares(values).reduce((sum, share) => sum + share, 0)).toBe(1e9)
    }
  })

  it('preserves relative order', () => {
    const [small, large] = splitShares([1, 99])
    expect(large).toBeGreaterThan(small)
  })

  it('refuses a share too small to encode, rather than reverting on-chain', () => {
    // Flooring sends a sufficiently tiny row to 0 while the LAST row still absorbs a positive
    // remainder — so the guard has to check every share, not just the last one.
    expect(() => splitShares([1, 1e12])).toThrow(/too small to encode/i)
  })

  it('never emits a zero or negative share for representable inputs', () => {
    for (const values of [[1, 1, 1], [0.01, 99.99], [1, 2, 3, 4, 5]]) {
      for (const share of splitShares(values)) expect(share).toBeGreaterThan(0)
    }
  })

  it('handles a single row and a zero total', () => {
    expect(splitShares([5])).toEqual([1e9])
    expect(splitShares([0, 0])).toEqual([0, 0])
  })
})
