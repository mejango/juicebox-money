import { describe, expect, it } from 'vitest'
import { payNoticeView as view, type PayNotices } from '@bananapus/nana-sdk-core/v6'
import { byChainOrder } from '@/lib/chainDisplay'

// The SDK owns the rule; the site passes its chain order.
const payNoticeView = (chainId: number, notices: PayNotices) => view(chainId, notices, byChainOrder)

describe('the payment notice a payer is shown', () => {
  it('is the paid chain’s own, with the chains that read differently listed in display order', () => {
    const notices = { 10: 'Optimism terms', 1: 'Terms', 8453: 'Terms', 42161: '' }
    expect(payNoticeView(8453, notices)).toEqual({
      notice: 'Terms',
      failed: false,
      others: [{ chainId: 42161, notice: '' }, { chainId: 10, notice: 'Optimism terms' }],
    })
    expect(payNoticeView(10, notices).notice).toBe('Optimism terms')
  })

  it('says a failed read failed instead of showing no notice, and never lists an unread chain as different', () => {
    expect(payNoticeView(1, { 1: null, 10: 'Terms' })).toEqual({ notice: '', failed: true, others: [] })
    expect(payNoticeView(1, { 10: 'Terms' }).failed).toBe(true)
    expect(payNoticeView(10, { 1: null, 10: 'Terms' })).toEqual({ notice: 'Terms', failed: false, others: [] })
  })
})
