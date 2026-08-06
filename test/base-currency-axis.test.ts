// The price chart's Y axis is the ruleset's BASE CURRENCY — what the project denominates
// issuance in, and what the protocol prices against (JBTerminalStore converts every payment
// into `ruleset.baseCurrency()` before applying the weight, JBTerminalStore.sol:1165-1175;
// JBBuybackHook repeats it at :1153-1164). Issuance (1/weight) is exact on that axis; the
// AMM price and cash-out floor are ACCOUNTING-token denominated and must be converted onto
// it. Labelling the axis with the base currency while feeding it unconverted accounting
// values — the defect this replaced — puts two units on one axis.
import { toBaseAxis } from '@/lib/base-currency-axis'
import { describe, expect, it } from 'vitest'

describe('toBaseAxis', () => {
  it('converts an accounting-denominated price onto the axis', () => {
    // 0.0005 ETH per token at 1700 USD/ETH = 0.85 USD per token.
    expect(toBaseAxis(0.0005, 1700)).toBeCloseTo(0.85, 10)
  })

  it('is a no-op at the identity rate a same-currency project gets', () => {
    // JBPrices returns exactly 1e18 when pricingCurrency == unitCurrency (JBPrices.sol:238).
    expect(toBaseAxis(0.0005, 1)).toBe(0.0005)
  })

  it('omits the value rather than guessing when no feed exists', () => {
    expect(toBaseAxis(0.0005, null)).toBeNull()
  })

  it('passes through absent values without inventing one', () => {
    expect(toBaseAxis(null, 1700)).toBeNull()
    expect(toBaseAxis(undefined, 1700)).toBeNull()
  })

  it('never turns a real price into zero', () => {
    // A zero would render as a floor of 0 and read as "worthless", so it must not be
    // reachable from a positive input.
    expect(toBaseAxis(0.0005, 1e-9)).toBeGreaterThan(0)
  })
})
