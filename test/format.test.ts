import { describe, expect, it } from 'vitest'
import {
  billionthsToPct,
  fmtPct,
  formatUsd18,
  projectLogoUrl,
  treasuryUsdValue,
} from '@/lib/format'

describe('percent formatting', () => {
  it('keeps ordinary percentages compact', () => {
    expect(fmtPct(38)).toBe('38%')
    expect(billionthsToPct(75_000_000)).toBe('7.5%')
  })

  it('never presents a non-zero issuance cut as zero', () => {
    expect(billionthsToPct(9_496)).toBe('0.0009496%')
  })
})

describe('project logo URLs', () => {
  it('passes supported inline images through without rewriting them as IPFS', () => {
    const svg =
      'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E'
    expect(projectLogoUrl(svg)).toBe(svg)
    expect(projectLogoUrl('data:image/png;base64,iVBORw0KGgo=')).toBe(
      'data:image/png;base64,iVBORw0KGgo=',
    )
  })

  it('keeps IPFS support and rejects script-bearing or non-image schemes', () => {
    expect(projectLogoUrl('ipfs://QmLogo')).toBe('/api/ipfs/QmLogo')
    expect(projectLogoUrl('data:text/html,<script>alert(1)</script>')).toBeNull()
    expect(
      projectLogoUrl(
        'data:image/svg+xml,%3Csvg%3E%3Cscript%3Ealert(1)%3C%2Fscript%3E%3C%2Fsvg%3E',
      ),
    ).toBeNull()
    expect(projectLogoUrl('javascript:alert(1)')).toBeNull()
    expect(projectLogoUrl('blob:https://example.com/id')).toBeNull()
  })
})

// USD is formatted BigInt-exact with half-up rounding and a sub-cent floor. The activity
// feed used to re-derive this through `Number` (truncating) and `toLocaleString`, so it
// could disagree with every other USD figure in the app; it now shares this one path.
describe('formatUsd18', () => {
  const usd = (dollars: string) => BigInt(dollars) * 10n ** 18n

  it('keeps cents by default', () => {
    expect(formatUsd18(usd('340') + 5n * 10n ** 17n)).toBe('$340.50')
  })

  it('drops cents above $1,000 only in compact mode', () => {
    const value = usd('12345') + 67n * 10n ** 16n
    expect(formatUsd18(value, { compact: true })).toBe('$12,346')
    expect(formatUsd18(value)).toBe('$12,345.67')
  })

  it('keeps cents below $1,000 even in compact mode', () => {
    expect(formatUsd18(usd('340') + 5n * 10n ** 17n, { compact: true })).toBe('$340.50')
  })

  it('floors a real sub-cent amount rather than rendering $0.00', () => {
    // "$0.00" reads as "nothing happened" for a payment that did happen.
    expect(formatUsd18(10n ** 15n)).toBe('<$0.01')
  })

  it('rounds half-up rather than truncating', () => {
    // The old Number-based path divided by 1e12 first and lost this.
    expect(formatUsd18(usd('1') + 5n * 10n ** 15n)).toBe('$1.01')
  })
})

describe('treasuryUsdValue', () => {
  it('prices a balance from the feed', () => {
    // 2 ETH at $3,000
    expect(
      treasuryUsdValue({
        balance: 2n * 10n ** 18n,
        usdPrice: 3_000n * 10n ** 18n,
        symbol: 'ETH',
        decimals: 18,
      }),
    ).toBe(6_000n * 10n ** 18n)
  })

  it('never reads an unavailable or zero feed as $0', () => {
    for (const usdPrice of [null, undefined, 0n]) {
      expect(
        treasuryUsdValue({
          balance: 10n ** 18n,
          usdPrice,
          symbol: 'ETH',
          decimals: 18,
        }),
      ).toBeNull()
    }
  })

  it('values USDC at par without an oracle', () => {
    expect(
      treasuryUsdValue({
        balance: 1_500_000n,
        usdPrice: null,
        symbol: 'usdc',
        decimals: 6,
      }),
    ).toBe(1n * 10n ** 18n + 5n * 10n ** 17n)
  })

  it('is zero for an empty balance regardless of the feed', () => {
    expect(
      treasuryUsdValue({
        balance: 0n,
        usdPrice: null,
        symbol: 'ETH',
        decimals: 18,
      }),
    ).toBe(0n)
  })
})
