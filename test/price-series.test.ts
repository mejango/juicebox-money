import { describe, expect, it } from 'vitest'
import { bucketPoolReserves, smoothPriceSeries, floorAtMoment } from '@/lib/price-series'

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
      { timestamp: 37.5, pairValue: 1, tokenValue: 2, tokenAmount: 20, pairAmount: 1 },
      { timestamp: 62.5, pairValue: 3, tokenValue: 4, tokenAmount: 40, pairAmount: 3 },
      { timestamp: 87.5, pairValue: 3, tokenValue: 4, tokenAmount: 40, pairAmount: 3 },
    ])
  })

  it('shows a change landing in the last half of the final bucket', () => {
    const latest = { timestamp: 99, pairValue: 9, tokenValue: 9, tokenAmount: 90, pairAmount: 9 }
    const buckets = bucketPoolReserves(
      [{ timestamp: 10, pairValue: 1, tokenValue: 2, tokenAmount: 20, pairAmount: 1 }, latest],
      0,
      100,
      4,
    )
    expect(buckets.at(-1)).toEqual({ ...latest, timestamp: 87.5 })
  })
})

describe('floorAtMoment', () => {
  const E18 = 10n ** 18n
  // A group holding 1 ETH ($2,000) and 1,000 USDC: the raw balance adds them
  // as 1e18 + 1e9, the USD balance is $3,000. 1,000 tokens, no tax, net of
  // the 2.5% protocol fee.
  const moment = {
    timestamp: 1,
    balance: String(E18 + 1_000_000_000n),
    volume: '0',
    volumeUsd: '0',
    balanceUsd: String(3_000n * E18),
    tokenSupply: String(1_000n * E18),
    accountingTokenUsdRate: String(2_000n * E18),
  }
  const options = { tax: 0, decimals: 18, historyRate: 1 }

  it('prices from the USD balance on a USD axis', () => {
    expect(floorAtMoment(moment, { ...options, perPointRates: true })?.value).toBeCloseTo(2.925)
  })

  it('converts the USD floor to the accounting token on a token axis', () => {
    expect(floorAtMoment(moment, { ...options, perPointRates: false })?.value).toBeCloseTo(0.0014625, 8)
  })

  it('keeps the raw balance for a moment the indexer could not value', () => {
    const unvalued = { ...moment, balance: String(E18), balanceUsd: '0' }
    expect(floorAtMoment(unvalued, { ...options, perPointRates: false })?.value).toBeCloseTo(0.000975, 8)
  })
})
