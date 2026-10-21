import { describe, expect, it } from 'vitest'
import { treasuryTotal } from '@/components/project/ProjectStats'

const row = (symbol: string, balance: bigint, usd: bigint | null) => ({
  chainId: 1,
  symbol,
  decimals: 18,
  balance,
  usd,
})

describe('project treasury total', () => {
  it('totals the priced tokens and names the unpriced ones', () => {
    expect(
      treasuryTotal(
        [row('ETH', 1n, 2_000n), row('USDC', 1n, 1n), row('FOO', 5n, null), row('BAR', 0n, null)],
        [],
      ),
    ).toEqual({ usd: 2_001n, unpriced: ['FOO'] })
  })

  it('is unknown while a chain is unread', () => {
    expect(treasuryTotal([row('ETH', 1n, 2_000n)], [10])).toBeNull()
  })
})
