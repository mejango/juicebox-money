import { describe, expect, it } from 'vitest'
import { smoothPriceSeries } from '@/lib/price-series'

describe('smoothPriceSeries', () => {
  it('attenuates a short-lived spike and preserves exact endpoints', () => {
    const smoothed = smoothPriceSeries([
      { timestamp: 0, value: 10 },
      { timestamp: 40, value: 100 },
      { timestamp: 41, value: 10 },
      { timestamp: 100, value: 10 },
    ])

    expect(smoothed[0]).toEqual({ timestamp: 0, value: 10 })
    expect(smoothed.at(-1)).toEqual({ timestamp: 100, value: 10 })
    expect(Math.max(...smoothed.map(point => point.value))).toBeLessThan(20)
  })

  it('keeps sparse histories exact', () => {
    const points = [
      { timestamp: 0, value: 10 },
      { timestamp: 100, value: 12 },
    ]
    expect(smoothPriceSeries(points)).toEqual(points)
  })
})
