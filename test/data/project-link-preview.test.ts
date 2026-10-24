import { describe, expect, it } from 'vitest'
import { USDC_ADDRESSES } from '@bananapus/nana-sdk-core'
import {
  formatProjectPreviewBalance,
  projectPreviewSlogan,
} from '@/lib/project-link-preview'

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const ETH = '0x000000000000000000000000000000000000eeee'

function deployment(balance: string, decimals: number | null, tokenSymbol: string, rows?: { token: string; tokenSymbol: string | null; decimals: number; balance: string }[]) {
  return {
    chainId: 1,
    token: tokenSymbol === 'ETH' ? ETH : tokenSymbol === 'USDC' ? USDC : null,
    balance,
    decimals,
    tokenSymbol,
    projectTokenBalances: rows ? { items: rows.map(row => ({ ...row, balanceUsd: '0' })) } : undefined,
  }
}

describe('project link preview balance', () => {
  it('adds matching accounting-token balances across chains', () => {
    expect(
      formatProjectPreviewBalance([
        deployment('1250000', 6, 'USDC'),
        { ...deployment('2750000', 6, 'USDC'), chainId: 10, token: USDC_ADDRESSES[10] },
      ]),
    ).toBe('4 USDC')
  })

  it('keeps unrelated addresses with identical symbols separate', () => {
    expect(formatProjectPreviewBalance([
      { ...deployment('1000000', 6, 'CASH'), token: '0x00000000000000000000000000000000000000aa' },
      { ...deployment('2000000', 6, 'CASH'), token: '0x00000000000000000000000000000000000000bb' },
    ])).toBe('1 CASH + 2 CASH')
  })

  it('does not infer cross-chain identity from an identical custom-token address', () => {
    const token = '0x00000000000000000000000000000000000000aa'
    expect(formatProjectPreviewBalance([
      { ...deployment('1000000', 6, 'CASH'), token },
      { ...deployment('2000000', 6, 'CASH'), token, chainId: 10 },
    ])).toBe('1 CASH + 2 CASH')
  })

  it.each(['ETH', 'USDC'])('does not merge a token claiming the known symbol %s', symbol => {
    const decimals = symbol === 'ETH' ? 18 : 6
    const unit = 10n ** BigInt(decimals)
    expect(formatProjectPreviewBalance([
      deployment(String(unit), decimals, symbol),
      { ...deployment(String(2n * unit), decimals, symbol), token: '0x00000000000000000000000000000000000000aa' },
    ])).toBe(`1 ${symbol} + 2 ${symbol}`)
  })

  it('requires the configured chain for a known USDC address', () => {
    expect(formatProjectPreviewBalance([
      deployment('1000000', 6, 'USDC'),
      { ...deployment('2000000', 6, 'USDC'), chainId: 10 },
    ])).toBe('1 USDC + 2 USDC')
  })

  it('aggregates verified equivalent native assets', () => {
    expect(formatProjectPreviewBalance([
      deployment('1000000000000000000', 18, 'ETH'),
      { ...deployment('2000000000000000000', 18, 'ETH'), chainId: 10 },
    ])).toBe('3 ETH')
  })

  it('keeps native testnet balances separate from mainnet even with the same indexed symbol', () => {
    expect(formatProjectPreviewBalance([
      deployment('1000000000000000000', 18, 'ETH'),
      { ...deployment('2000000000000000000', 18, 'ETH'), chainId: 11155111 },
    ])).toBe('1 ETH + 2 ETH')
  })

  it('keeps rows without token identity separate', () => {
    expect(formatProjectPreviewBalance([
      deployment('1000000', 6, 'CASH'),
      deployment('2000000', 6, 'CASH'),
    ])).toBe('1 CASH + 2 CASH')
  })

  it('keeps unlike accounting tokens visibly separate', () => {
    expect(
      formatProjectPreviewBalance([
        deployment('1500000000000000000', 18, 'ETH'),
        deployment('2500000', 6, 'USDC'),
      ]),
    ).toBe('1.5 ETH + 2.5 USDC')
  })

  it('reads a multi-token project from its per-token rows, not its mixed raw balance', () => {
    expect(
      formatProjectPreviewBalance([
        deployment('100000005000000', 6, 'USDC', [
          { token: ETH, tokenSymbol: 'ETH', decimals: 18, balance: '100000000000000' },
          { token: USDC, tokenSymbol: null, decimals: 6, balance: '5000000' },
        ]),
        deployment('0', 18, 'ETH', [
          { token: ETH, tokenSymbol: 'ETH', decimals: 18, balance: '0' },
        ]),
      ]),
    ).toBe('0.0001 ETH + 5 USDC')
  })

  it('leaves out tokens it does not hold, unless it holds none', () => {
    const rows = [
      { token: ETH, tokenSymbol: 'ETH', decimals: 18, balance: '0' },
      { token: USDC, tokenSymbol: 'USDC', decimals: 6, balance: '0' },
    ]
    expect(formatProjectPreviewBalance([deployment('0', 18, 'ETH', rows)])).toBe('0 ETH')
    rows[1].balance = '2000000'
    expect(formatProjectPreviewBalance([deployment('0', 18, 'ETH', rows)])).toBe('2 USDC')
  })

  it('falls back to the accounting-token balance when a project has no per-token rows yet', () => {
    expect(formatProjectPreviewBalance([deployment('0', 18, 'ETH', [])])).toBe('0 ETH')
  })

  it('values a multi-token project without per-token rows in USD, never its mixed raw balance', () => {
    expect(
      formatProjectPreviewBalance([
        { ...deployment('100000005000000', 6, 'USDC', []), accountingTokenCount: 2, balanceUsd: '5200000000000000000' },
        deployment('1000000', 6, 'USDC'),
      ]),
    ).toBe('1 USDC + $5.20')
  })

  it('shows a held token with no known symbol in USD', () => {
    expect(
      formatProjectPreviewBalance([
        {
          ...deployment('0', 18, 'ETH'),
          projectTokenBalances: {
            items: [
              { token: ETH, tokenSymbol: 'ETH', decimals: 18, balance: '2000000000000000000', balanceUsd: '0' },
              { token: '0x00000000000000000000000000000000000000aa', tokenSymbol: null, decimals: 18, balance: '1', balanceUsd: '12500000000000000000' },
            ],
          },
        },
      ]),
    ).toBe('2 ETH + $12.50')
  })

  it('values a deployment without rows or a usable symbol in USD', () => {
    expect(
      formatProjectPreviewBalance([
        { ...deployment('5', 18, ''), balanceUsd: '12500000000000000000' },
        deployment('1000000', 6, 'USDC'),
      ]),
    ).toBe('1 USDC + $12.50')
  })

  it('does not turn malformed or unknown data into a zero balance', () => {
    expect(
      formatProjectPreviewBalance([
        deployment('not-a-number', 18, 'ETH'),
        deployment('12', null, 'USDC'),
      ]),
    ).toBe('Unavailable')
  })

  it('uses a plain-text description when a project has no dedicated tagline', () => {
    expect(projectPreviewSlogan(null, '<p>Join our <b>creative</b> mission.</p>')).toBe(
      'Join our creative mission.',
    )
  })
})
