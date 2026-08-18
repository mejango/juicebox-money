import { describe, expect, it } from 'vitest'

import { amountsModeNote, solveRangeFromAmounts } from '@/lib/uniswap-v4'

// The amounts-first mode explains WHY the solved range landed where it did,
// in plain language keyed to the anchor the solver chose.

const PRICE = 0.00001
const FLOOR = 6.68961e-8
const CEILING = 0.0016

const noteFor = (tokenAmount: number, pairAmount: number, hints?: {
  floorHint?: number | null
  ceilingHint?: number | null
}) => {
  const floorHint = hints ? hints.floorHint : FLOOR
  const ceilingHint = hints ? hints.ceilingHint : CEILING
  const solved = solveRangeFromAmounts({
    price: PRICE,
    tokenAmount,
    pairAmount,
    floorHint,
    ceilingHint,
  })
  return amountsModeNote({
    tokenAmount,
    pairAmount,
    solved,
    floorHint,
    ceilingHint,
    tokenSymbol: 'MARKEE',
    pairSymbol: 'ETH',
  })
}

describe('amountsModeNote', () => {
  it('prompts when nothing is entered', () => {
    expect(noteFor(0, 0)).toContain('Enter')
  })

  it('explains the cash-out floor anchor', () => {
    expect(noteFor(1_000, 0.08)).toContain('cash-out')
  })

  it('explains the fallback floor when no cash-out floor exists', () => {
    expect(noteFor(1_000, 0.08, { floorHint: null, ceilingHint: CEILING })).toContain(
      'half the current price',
    )
  })

  it('explains the issuance ceiling anchor for a heavy token side', () => {
    expect(noteFor(100_000, 0.08)).toContain('issuance')
  })

  it('explains the fallback ceiling when no issuance price exists', () => {
    expect(noteFor(100_000, 0.08, { floorHint: FLOOR, ceilingHint: null })).toContain(
      'twice the current price',
    )
  })

  it('explains a pair-only deposit', () => {
    expect(noteFor(0, 0.08)).toContain('below the current price')
    expect(noteFor(0, 0.08)).toContain('ETH')
  })

  it('explains a token-only deposit', () => {
    expect(noteFor(100_000, 0)).toContain('above the current price')
    expect(noteFor(100_000, 0)).toContain('MARKEE')
  })
})
