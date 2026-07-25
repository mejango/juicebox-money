import { describe, expect, it } from 'vitest'
import { explainCashOutChange } from '@/lib/cashOutChange'

describe('explainCashOutChange', () => {
  it('explains payments and cash outs from backing and supply changes', () => {
    const first = {
      balance: 100n,
      tokenSupply: 100n,
      cashOutTax: 1_000,
      price: 0.9,
    }
    expect(
      explainCashOutChange(first, {
        balance: 200n,
        tokenSupply: 150n,
        cashOutTax: 1_000,
        price: 1.2,
      }),
    ).toContain('payment added backing and issued tokens')
    expect(
      explainCashOutChange(first, {
        balance: 80n,
        tokenSupply: 70n,
        cashOutTax: 1_000,
        price: 1,
      }),
    ).toContain('cash out removed backing and burned tokens')
  })
})
