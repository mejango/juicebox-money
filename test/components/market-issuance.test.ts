import { JBCoreContracts } from '@bananapus/nana-sdk-core'
import { parseUnits, type PublicClient } from 'viem'
import { describe, expect, it, vi } from 'vitest'

import { issuanceCeilingOf } from '@/components/project/MarketSection'
import { addrOf } from '@/lib/contracts'

/** The native-token accounting-context currency: uint32(uint160(0xEEEe)). */
const NATIVE_CURRENCY = 61166
const USD_BASE_CURRENCY = 2

function stubClient(price: bigint | Error) {
  const readContract = vi.fn(async () => {
    if (price instanceof Error) throw price
    return price
  })
  return { client: { readContract } as unknown as PublicClient, readContract }
}

describe('issuanceCeilingOf', () => {
  it('converts a base-currency ceiling onto the pair-token axis via JBPrices', async () => {
    // weight = 4 tokens per base unit → 0.25 base per token. The feed prices
    // 1 base unit at 0.5 pair tokens (pricingCurrency=pair, unitCurrency=base,
    // exactly the direction JBTerminalStore uses), so the ceiling is
    // 0.25 * 0.5 = 0.125 pair per token.
    const { client, readContract } = stubClient(parseUnits('0.5', 18))
    await expect(
      issuanceCeilingOf(client, {
        chainId: 1,
        projectId: 5n,
        weight: parseUnits('4', 18),
        baseCurrency: USD_BASE_CURRENCY,
        pairCurrency: NATIVE_CURRENCY,
      }),
    ).resolves.toBeCloseTo(0.125, 12)
    expect(readContract).toHaveBeenCalledTimes(1)
    expect(readContract).toHaveBeenCalledWith({
      address: addrOf(JBCoreContracts.JBPrices, 1),
      abi: expect.anything(),
      functionName: 'pricePerUnitOf',
      args: [5n, BigInt(NATIVE_CURRENCY), BigInt(USD_BASE_CURRENCY), 18n],
    })
  })

  it('skips the feed read when the ruleset base currency IS the pair currency', async () => {
    const { client, readContract } = stubClient(new Error('must not be called'))
    await expect(
      issuanceCeilingOf(client, {
        chainId: 1,
        projectId: 5n,
        weight: parseUnits('1000', 18),
        baseCurrency: NATIVE_CURRENCY,
        pairCurrency: NATIVE_CURRENCY,
      }),
    ).resolves.toBeCloseTo(0.001, 12)
    expect(readContract).not.toHaveBeenCalled()
  })

  it('omits the ceiling instead of guessing when no price feed exists', async () => {
    const { client } = stubClient(new Error('JBPrices_PriceFeedNotFound'))
    await expect(
      issuanceCeilingOf(client, {
        chainId: 1,
        projectId: 5n,
        weight: parseUnits('4', 18),
        baseCurrency: USD_BASE_CURRENCY,
        pairCurrency: NATIVE_CURRENCY,
      }),
    ).resolves.toBeNull()
  })

  it('returns null for a zero weight without reading anything', async () => {
    const { client, readContract } = stubClient(new Error('must not be called'))
    await expect(
      issuanceCeilingOf(client, {
        chainId: 1,
        projectId: 5n,
        weight: 0n,
        baseCurrency: USD_BASE_CURRENCY,
        pairCurrency: NATIVE_CURRENCY,
      }),
    ).resolves.toBeNull()
    expect(readContract).not.toHaveBeenCalled()
  })
})
