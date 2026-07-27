import {
  buildStepPoints,
  formatRate,
  rateAtTime,
  resolveStages,
} from '@/components/project/chartUtils'
import { describe, expect, it } from 'vitest'

const DAY = 86_400

describe('issuance chart projections', () => {
  it('keeps a two-year daily cut discrete and compounds the uint32 cut correctly', () => {
    const resolved = resolveStages([
      {
        start: 0,
        duration: DAY,
        weight: 10_000n * 10n ** 18n,
        weightCutPercent: 9_496,
      },
    ])

    const points = buildStepPoints(resolved, 0, 730 * DAY + 1)

    expect(points.length).toBeGreaterThan(1_400)
    expect(rateAtTime(resolved, 730 * DAY)).toBeCloseTo(9_930.91, 1)
    expect(points.some(([time]) => time === DAY)).toBe(true)
  })

  it('does not round a visible high issuance rate to a misleading integer', () => {
    expect(formatRate(9_999.90504)).toBe('9,999.91')
  })
})
