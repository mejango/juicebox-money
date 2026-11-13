import { describe, expect, it } from 'vitest'
import { holderActionChains } from '@/lib/holder-action-chains'

const chains: [number, number][] = [[1, 5], [8453, 7], [42161, 9]]

describe('holderActionChains', () => {
  it('lists only the chains the holder holds on', () => {
    expect(holderActionChains(chains, [0n, 12n, 0n])).toEqual([[8453, 7]])
  })
  it('keeps every chain while balances are unread', () => {
    expect(holderActionChains(chains, undefined)).toEqual(chains)
  })
  it('keeps each chain paired with its own project id', () => {
    expect(holderActionChains(chains, [3n, 0n, 4n])).toEqual([[1, 5], [42161, 9]])
  })
})
