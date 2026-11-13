import { describe, expect, it } from 'vitest'
import { registrationTwapIssue } from '@/components/project/MultiChainBuybackRouterCard'

describe('pool registration TWAP window', () => {
  it('refuses exactly the maximum, which the hook stores as 30 minutes', () => {
    expect(registrationTwapIssue(172_800)).toMatch(/stores the hook's 30-minute default/)
    expect(registrationTwapIssue(172_800n)).not.toBeNull()
  })
  it('accepts every other allowed window', () => {
    expect(registrationTwapIssue(172_799)).toBeNull()
    expect(registrationTwapIssue(1800)).toBeNull()
  })
})
