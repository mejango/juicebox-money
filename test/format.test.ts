import { describe, expect, it } from 'vitest'
import { billionthsToPct, fmtPct } from '@/lib/format'

describe('percent formatting', () => {
  it('keeps ordinary percentages compact', () => {
    expect(fmtPct(38)).toBe('38%')
    expect(billionthsToPct(75_000_000)).toBe('7.5%')
  })

  it('never presents a non-zero issuance cut as zero', () => {
    expect(billionthsToPct(9_496)).toBe('0.0009496%')
  })
})
