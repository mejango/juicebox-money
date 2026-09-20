import { describe, expect, it } from 'vitest'
import { tierSaleShares } from '@/components/project/ShopTab'

describe('tierSaleShares', () => {
  it("scales each split by the tier's share and leaves the rest to the project", () => {
    // 80% of each sale is split: 75% of that to A, 25% to B.
    const { rows, treasuryBps } = tierSaleShares(800_000_000, [
      { percent: 750_000_000 },
      { percent: 250_000_000 },
    ])
    expect(rows.map(row => row.bps)).toEqual([6000n, 2000n])
    expect(treasuryBps).toBe(2000n)
  })

  it('credits an under-allocated split group back to the project', () => {
    const { rows, treasuryBps } = tierSaleShares(800_000_000, [{ percent: 500_000_000 }])
    expect(rows[0]!.bps).toBe(4000n)
    expect(treasuryBps).toBe(6000n)
  })
})
