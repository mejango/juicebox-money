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
    ).toContain('payment increased backing faster than token supply')
    expect(
      explainCashOutChange(first, {
        balance: 80n,
        tokenSupply: 70n,
        cashOutTax: 1_000,
        price: 1,
      }),
    ).toContain('cash out burned supply faster than it removed backing')
  })

  it('names a rate move instead of a flow when only USD values change', () => {
    const first = { balance: 100n, tokenSupply: 100n, cashOutTax: 0, price: 2, balanceUsd: 200n }
    expect(
      explainCashOutChange(first, { ...first, price: 1.5, balanceUsd: 150n }),
    ).toBe('Cash-out price fell because token prices moved the USD value of the backing.')
    expect(
      explainCashOutChange(first, {
        balance: 80n,
        tokenSupply: 70n,
        cashOutTax: 0,
        price: 1.9,
        balanceUsd: 133n,
      }),
    ).toBe(
      'Cash-out price fell because a cash out burned supply faster than it removed backing, increasing backing per remaining token and token prices moved the USD value of the backing.',
    )
    expect(explainCashOutChange(first, { ...first, balance: 150n, balanceUsd: 300n })).not.toContain('token prices')
  })

  it('explains a dilutive payment', () => {
    const first = {
      balance: 100n,
      tokenSupply: 100n,
      cashOutTax: 1_000,
      price: 0.9,
    }
    expect(
      explainCashOutChange(first, {
        balance: 150n,
        tokenSupply: 200n,
        cashOutTax: 1_000,
        price: 0.65,
      }),
    ).toContain('increased token supply faster than backing')
  })
})
