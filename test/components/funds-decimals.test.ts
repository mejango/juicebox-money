import { parseUnits } from 'viem'
import { describe, expect, it } from 'vitest'

import { currencyDecimals } from '@/components/project/FundsTab'
import type { JBAccountingContext } from '@bananapus/nana-sdk-core/v6'

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const
/** The token's own accounting currency id: uint32(uint160(token)). */
const USDC_CURRENCY = Number(BigInt(USDC) & 0xffffffffn)
const USD_BASE_CURRENCY = 2
const ETH_BASE_CURRENCY = 1

const usdcContext: JBAccountingContext = {
  token: USDC,
  decimals: 6,
  currency: USDC_CURRENCY,
}

const ethContext: JBAccountingContext = {
  token: '0x000000000000000000000000000000000000EEEe',
  decimals: 18,
  currency: 61166,
}

/**
 * Ground truth (JBTerminalStore.recordPayoutFor / recordUsedAllowanceOf):
 * `amount` is compared directly against the stored limit and converted with
 * `mulDiv(amount, 10^18, pricePerUnitOf(..., decimals: 18))` — the price is a
 * dimensionless human ratio whose 10^18 scaling cancels, so the fixed-point
 * scale of the input carries through to the accounting-token output. Limit
 * amounts are therefore ALWAYS fixed-point scaled to the accounting context's
 * decimals, regardless of the denomination currency.
 */
describe('FundsTab currencyDecimals', () => {
  it('uses the context decimals for a USD-denominated limit on a 6-dec USDC context', () => {
    expect(currencyDecimals(USD_BASE_CURRENCY, usdcContext)).toBe(6)
  })

  it('parses a $100 limit on a 6-dec USDC context as 100e6, not 100e18', () => {
    const decimals = currencyDecimals(USD_BASE_CURRENCY, usdcContext)
    expect(parseUnits('100', decimals)).toBe(100_000_000n)
  })

  it('uses the context decimals for a token-currency limit', () => {
    expect(currencyDecimals(USDC_CURRENCY, usdcContext)).toBe(6)
  })

  it('keeps 18 decimals for base-currency limits on an 18-dec native context', () => {
    expect(currencyDecimals(USD_BASE_CURRENCY, ethContext)).toBe(18)
    expect(currencyDecimals(ETH_BASE_CURRENCY, ethContext)).toBe(18)
  })
})
