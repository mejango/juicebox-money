import { describe, expect, it, vi } from 'vitest'
import { USDC_ADDRESSES } from '@bananapus/nana-sdk-core'
import type { PublicClient } from 'viem'
import { knownTokenSymbol, tokenSymbol } from '@/lib/token-symbol'

describe('chain-authenticated known tokens', () => {
  it('recognizes USDC only on its configured chain', () => {
    const token = USDC_ADDRESSES[1]
    expect(knownTokenSymbol(token, { chainId: 1 })).toBe('USDC')
    expect(knownTokenSymbol(token, { chainId: 10 })).toBeNull()
    expect(knownTokenSymbol(token)).toBeNull()
  })
  it('uses the client chain before trusting a known deployment, otherwise reads the custom token', async () => {
    const readContract = vi.fn(async () => 'XYZ')
    const client = { chain: { id: 10 }, readContract } as unknown as PublicClient
    expect(await tokenSymbol(client, USDC_ADDRESSES[1])).toBe('XYZ')
    expect(readContract).toHaveBeenCalledOnce()
    expect(await tokenSymbol(client, USDC_ADDRESSES[10])).toBe('USDC')
    expect(readContract).toHaveBeenCalledOnce()
  })
})
