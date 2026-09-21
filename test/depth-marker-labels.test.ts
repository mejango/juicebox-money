import { describe, expect, it } from 'vitest'
import { layoutMarkerLabels } from '@/components/project/MarketSection'

describe('layoutMarkerLabels', () => {
  it('leaves separated labels where their markers are', () => {
    expect(
      layoutMarkerLabels(
        [
          { x: 100, label: 'floor' },
          { x: 200, label: 'price' },
          { x: 300, label: 'ceiling' },
        ],
        320,
      ),
    ).toEqual([100, 200, 300])
  })

  it('pulls "price" left of a "ceiling" pinned to the right edge', () => {
    const [price, ceiling] = layoutMarkerLabels(
      [
        { x: 318, label: 'price' },
        { x: 319, label: 'ceiling' },
      ],
      320,
    )
    // ceiling: half 17.5, pinned at 320 - 17.5 - 1; price sits 4 clear of it.
    expect(ceiling).toBe(301.5)
    expect(price + 12.5 + 4).toBeLessThanOrEqual(ceiling - 17.5)
  })
})
