import { downsampleTimeSeries } from '@/lib/downsample'
import { describe, expect, it } from 'vitest'

describe('downsampleTimeSeries', () => {
  it('keeps the endpoints, requested size, order, and a material spike', () => {
    const rows = Array.from({ length: 100 }, (_, timestamp) => ({
      timestamp,
      value: timestamp === 50 ? 10_000 : timestamp,
    }))
    const sampled = downsampleTimeSeries(
      rows,
      12,
      row => row.timestamp,
      row => row.value,
    )
    expect(sampled).toHaveLength(12)
    expect(sampled[0]).toBe(rows[0])
    expect(sampled.at(-1)).toBe(rows.at(-1))
    expect(sampled).toContain(rows[50])
    expect(sampled.map(row => row.timestamp)).toEqual(
      [...sampled].map(row => row.timestamp).sort((a, b) => a - b),
    )
  })
})
