// Fund-access amounts are stored in the TERMINAL TOKEN's decimals whatever currency
// denominates them: "Amounts use the same decimal precision as the terminal token
// (e.g. 18 for ETH, 6 for USDC)" — JBFundAccessLimitGroup.sol. JBTerminalStore
// .recordPayoutFor compares the requested payout against the limit with NO decimal
// conversion and only then converts by PRICE, which is sound only if both are already
// in the token's decimals. Assuming 18 for a base-currency limit reads 1e12x too small
// on 6-decimal USDC — and looks correct on ETH purely because ETH's decimals are 18,
// which is what let the bug survive.
import { currencyLabel } from '@/components/project/QueueRulesetFlow'
import { formatLimits } from '@/components/project/RulesetsTab'
import { describe, expect, it } from 'vitest'

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const
const NATIVE = '0x000000000000000000000000000000000000EEEe' as const

const usdcCtx = { token: USDC, decimals: 6, currency: 61_167, symbol: 'USDC' }
const ethCtx = { token: NATIVE, decimals: 18, currency: 61_166, symbol: 'ETH' }

const USD = 2
const ETH = 1

describe('fund-access limit units', () => {
  it('renders a USD limit on a USDC terminal at the token decimals', () => {
    // $100 stored as 100_000000 (6 dec). At 18 dec this read as 0.0000001 USD.
    expect(formatLimits([{ amount: 100_000000n, currency: USD }], usdcCtx)).toBe(
      '100 USD',
    )
  })

  it('renders a token-keyed limit on a USDC terminal at the token decimals', () => {
    expect(
      formatLimits([{ amount: 250_000000n, currency: usdcCtx.currency }], usdcCtx),
    ).toBe('250 USDC')
  })

  it('still renders ETH-terminal limits correctly, where the two rules coincide', () => {
    expect(
      formatLimits([{ amount: 1_000000000000000000n, currency: ETH }], ethCtx),
    ).toBe('1 ETH')
    expect(
      formatLimits([{ amount: 3_000000000000000000n, currency: USD }], ethCtx),
    ).toBe('3 USD')
  })

  it('names the denomination, never silently relabelling it as the token', () => {
    // A USD-denominated limit is not a USDC amount, even on a USDC terminal.
    expect(formatLimits([{ amount: 5_000000n, currency: USD }], usdcCtx)).toContain('USD')
    expect(formatLimits([{ amount: 5_000000n, currency: USD }], usdcCtx)).not.toContain(
      'USDC',
    )
  })

  it('reports no limits as None', () => {
    expect(formatLimits([], usdcCtx)).toBe('None')
  })
})

// The queue editor writes an IMMUTABLE ruleset, and its review rows name the unit each
// limit is denominated in. JBCurrencyIds defines only ETH = 1 and USD = 2 as shared
// denominations; any other id is the accounting context's own uint32(tokenAddress),
// which the token's symbol names. Falling through on USD labels a $100 limit "100 ETH".
describe('queue-editor currency labels', () => {
  it('names USD rather than falling through to the accounting token', () => {
    expect(currencyLabel(2, 'ETH')).toBe('USD')
    expect(currencyLabel(2, 'USDC')).toBe('USD')
  })

  it('names ETH for the ETH base currency', () => {
    expect(currencyLabel(1, 'USDC')).toBe('ETH')
  })

  it('falls back to the token symbol for a token-keyed currency', () => {
    expect(currencyLabel(61_167, 'USDC')).toBe('USDC')
  })
})
