import { describe, expect, it } from 'vitest'
import { netLoanProceeds } from '@/lib/loanFees'

describe('loan opening fees', () => {
  it('returns minimum-fee spendable proceeds instead of gross principal', () => {
    expect(netLoanProceeds(1_000_000n)).toBe(940_000n)
    expect(netLoanProceeds(4_001n)).toBe(3_761n)
  })

  it('uses the selected prepaid source fee', () => {
    expect(netLoanProceeds(1_000_000n, 100n)).toBe(865_000n)
  })
})
