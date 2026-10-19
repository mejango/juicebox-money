import { describe, expect, it } from 'vitest'

import { indexedAmountsTrusted } from '@/lib/indexed-amounts-trusted'

describe('indexedAmountsTrusted', () => {
  it('trusts indexed amounts only when every deployment has at most one accounting context', () => {
    expect(indexedAmountsTrusted([1, 1, 0])).toBe(true)
    expect(indexedAmountsTrusted([])).toBe(true)
  })

  it('distrusts a deployment with several accounting contexts, even while others load', () => {
    // eth:12 accepts ETH and USDC; Bendystraw indexed its 0.0001 ETH payment as 100,000,000 USDC.
    expect(indexedAmountsTrusted([2])).toBe(false)
    expect(indexedAmountsTrusted([1, undefined, 2])).toBe(false)
  })

  it('stays pending while a read is outstanding and never trusts a failed read', () => {
    expect(indexedAmountsTrusted([1, undefined])).toBeUndefined()
    expect(indexedAmountsTrusted([1, null])).toBe(false)
  })
})
