// `JBFundAccessLimitGroup.payoutLimits` is an ARRAY — a token can carry limits in several
// currencies at once, and they are additive within their reset windows. This editor models one
// value per token, and the ruleset it queues is IMMUTABLE, so emitting only the first limit
// would permanently delete the rest with nothing in the diff to show it. It fails closed instead.
import { multiCurrencyLimitBlock } from '@/components/project/QueueRulesetFlow'
import { describe, expect, it } from 'vitest'

const limit = (amount: bigint, currency: number) => ({ amount, currency })

describe('multiCurrencyLimitBlock', () => {
  it('allows a token with a single payout limit', () => {
    expect(
      multiCurrencyLimitBlock([{ symbol: 'USDC', unrepresentableLimits: [] }]),
    ).toBeNull()
  })

  it('allows a token with no limits at all', () => {
    expect(multiCurrencyLimitBlock([{ symbol: 'ETH' }])).toBeNull()
  })

  it('blocks when a token carries a second currency, naming it', () => {
    const message = multiCurrencyLimitBlock([
      { symbol: 'USDC', unrepresentableLimits: [limit(100n, 2)] },
    ])
    expect(message).toContain('USDC')
    expect(message).toContain("can't preserve")
  })

  it('names every affected token', () => {
    const message = multiCurrencyLimitBlock([
      { symbol: 'ETH', unrepresentableLimits: [limit(1n, 1)] },
      { symbol: 'USDC', unrepresentableLimits: [limit(2n, 2)] },
    ])
    expect(message).toContain('ETH')
    expect(message).toContain('USDC')
  })

  it('ignores zero-amount extras, which delete nothing', () => {
    expect(
      multiCurrencyLimitBlock([{ symbol: 'ETH', unrepresentableLimits: [] }]),
    ).toBeNull()
  })
})
