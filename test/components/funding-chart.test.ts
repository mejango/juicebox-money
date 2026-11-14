import { describe, expect, it } from 'vitest'
import { bucketize, holdingsEvents, holdingsNote, rateKey, volumeEvents } from '@/components/project/FundingChart'
import type { BsPriceMoment, BsTokenBalanceMoment } from '@/lib/bendystraw'

const usd = (n: number) => String(BigInt(n) * 10n ** 18n)
const ETH = '0x000000000000000000000000000000000000EEEe'
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

describe('funding chart series', () => {
  const now = Math.floor(Date.now() / 1000)

  it('values every past holding at today’s price, across tokens and chains', () => {
    const moments = [
      // 2 ETH on Base when ETH was 1000, then 1 ETH after a payout at 4000.
      { chainId: 8453, projectId: 7, token: ETH, decimals: 18, balance: String(2n * 10n ** 18n), timestamp: now - 600, tokenUsdRate: usd(1000) },
      { chainId: 8453, projectId: 7, token: USDC, decimals: 6, balance: '500000000', timestamp: now - 300, tokenUsdRate: usd(1) },
      { chainId: 8453, projectId: 7, token: ETH, decimals: 18, balance: String(10n ** 18n), timestamp: now - 60, tokenUsdRate: usd(4000) },
    ] as BsTokenBalanceMoment[]
    const live = bucketize(holdingsEvents(moments, new Map([[rateKey(8453, ETH), 3000]])), 0)
    // The first bar holds 2 ETH at today’s 3000, not at the 1000 it was worth then.
    expect(live[0].valueUsd).toBe(6000)
    // USDC has no live price here, so its newest indexed rate stands in.
    expect(live.at(-1)?.valueUsd).toBe(3000 + 500)
    // With no live price at all, the newest indexed rate prices the whole history.
    expect(bucketize(holdingsEvents(moments, new Map()), 0)[0].valueUsd).toBe(8000)
    // The figure says when it is not all live prices.
    expect(holdingsNote(moments, new Map([[rateKey(8453, ETH), 3000], [rateKey(8453, USDC), 1]]))).toBeNull()
    expect(holdingsNote(moments, new Map([[rateKey(8453, ETH), 3000]]))).toBe('Some prices are recent, not live.')
    const unpriced = [...moments, { ...moments[0], token: '0x' + '9'.repeat(40), tokenUsdRate: null }] as BsTokenBalanceMoment[]
    expect(holdingsNote(unpriced, new Map([[rateKey(8453, ETH), 3000]]))).toBe('Leaves out tokens with no dollar price.')
  })

  it('adds direct additions to indexed volume', () => {
    const moments = [{ timestamp: now - 600, volumeUsd: usd(2000) }] as unknown as BsPriceMoment[]
    const adds = [{ suckerGroupId: 'g', timestamp: now - 60, amount: '1', amountUsd: usd(50) }]
    expect(bucketize(volumeEvents(moments, adds), 0).at(-1)?.valueUsd).toBe(2050)
  })
})
