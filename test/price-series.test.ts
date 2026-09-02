import { describe, expect, it } from 'vitest'
import { bucketPoolReserves, smoothPriceSeries } from '@/lib/price-series'

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

describe('bucketPoolReserves', () => {
  it('resamples onto even buckets, holding the last observation and skipping the pre-pool span', () => {
    const buckets = bucketPoolReserves(
      [
        { timestamp: 70, pairValue: 3, tokenValue: 4, tokenAmount: 40, pairAmount: 3 },
        { timestamp: 50, pairValue: 1, tokenValue: 2, tokenAmount: 20, pairAmount: 1 },
      ],
      0,
      100,
      4,
    )
    expect(buckets).toEqual([
      { timestamp: 62.5, pairValue: 1, tokenValue: 2, tokenAmount: 20, pairAmount: 1 },
      { timestamp: 87.5, pairValue: 3, tokenValue: 4, tokenAmount: 40, pairAmount: 3 },
    ])
  })
})
