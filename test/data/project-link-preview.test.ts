import { describe, expect, it } from 'vitest'
import {
  formatProjectPreviewBalance,
  projectPreviewSlogan,
} from '@/lib/project-link-preview'

describe('project link preview balance', () => {
  it('adds matching accounting-token balances across chains', () => {
    expect(
      formatProjectPreviewBalance([
        { balance: '1250000', decimals: 6, tokenSymbol: 'USDC' },
        { balance: '2750000', decimals: 6, tokenSymbol: 'USDC' },
      ]),
    ).toBe('4 USDC')
  })

  it('keeps unlike accounting tokens visibly separate', () => {
    expect(
      formatProjectPreviewBalance([
        { balance: '1500000000000000000', decimals: 18, tokenSymbol: 'ETH' },
        { balance: '2500000', decimals: 6, tokenSymbol: 'USDC' },
      ]),
    ).toBe('1.5 ETH + 2.5 USDC')
  })

  it('does not turn malformed or unknown data into a zero balance', () => {
    expect(
      formatProjectPreviewBalance([
        { balance: 'not-a-number', decimals: 18, tokenSymbol: 'ETH' },
        { balance: '12', decimals: null, tokenSymbol: 'USDC' },
      ]),
    ).toBe('Unavailable')
  })

  it('uses a plain-text description when a project has no dedicated tagline', () => {
    expect(projectPreviewSlogan(null, '<p>Join our <b>creative</b> mission.</p>')).toBe(
      'Join our creative mission.',
    )
  })
})
