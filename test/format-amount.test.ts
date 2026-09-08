import { describe, expect, it } from 'vitest'
import { formatAmount } from '@/lib/format'

describe('formatAmount', () => {
  it("shows a tiny amount's first significant figure instead of a floor", () => {
    expect(formatAmount(0.000004586733)).toBe('0.000005')
    expect(formatAmount(0.00004)).toBe('0.00004')
    expect(formatAmount(0)).toBe('0')
    expect(formatAmount(1.5)).toBe('1.5')
  })
})
