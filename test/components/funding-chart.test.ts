import { describe, expect, it } from 'vitest'
import { bucketize } from '@/components/project/FundingChart'
import type { BsPriceMoment } from '@/lib/bendystraw'

const usd = (n: number) => String(BigInt(n) * 10n ** 18n)

describe('funding chart series', () => {
  it('floors a flow-accrued balance that price moves pushed below zero', () => {
    const now = Math.floor(Date.now() / 1000)
    const moments = [
      { timestamp: now - 600, volumeUsd: usd(2000), balanceUsd: usd(2000) },
      { timestamp: now - 60, volumeUsd: usd(2000), balanceUsd: `-${usd(1000)}` },
    ] as unknown as BsPriceMoment[]
    const balance = bucketize(moments, [], 'balance', 0)
    expect(balance[0].valueUsd).toBe(2000)
    expect(balance[balance.length - 1].valueUsd).toBe(0)
    expect(bucketize(moments, [], 'volume', 0).at(-1)?.valueUsd).toBe(2000)
  })
})
