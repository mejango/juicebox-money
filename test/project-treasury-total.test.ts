import { BaseError, ContractFunctionRevertedError, zeroAddress, type PublicClient } from 'viem'
import { describe, expect, it, vi } from 'vitest'
import { readTreasuryUsdPrice, treasuryTotal } from '@/components/project/ProjectStats'

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

describe('a balance token\'s USD price', () => {
  const clientThat = (readContract: () => Promise<bigint>) => ({ readContract: vi.fn(readContract) }) as unknown as PublicClient
  const read = (client: PublicClient) => readTreasuryUsdPrice(client, zeroAddress, 1n, 61166)

  it('is the feed\'s answer', async () => {
    await expect(read(clientThat(async () => 5n))).resolves.toBe(5n)
  })

  it('is absent when the chain answers that no feed exists', async () => {
    const revert = new BaseError('reverted', {
      cause: new ContractFunctionRevertedError({ abi: [], functionName: 'pricePerUnitOf', message: 'no feed' }),
    })
    await expect(read(clientThat(async () => { throw revert }))).resolves.toBeNull()
  })

  it('leaves the chain unread when the read itself fails, so the total is unknown and not $0.00', async () => {
    await expect(read(clientThat(async () => { throw new Error('429') }))).rejects.toThrow('429')
  })
})
