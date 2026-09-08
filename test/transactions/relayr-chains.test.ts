import { describe, expect, it } from 'vitest'
import { relayrPaymentChains, relayrSupportsChain, relayrSupportsChains } from '@/lib/relayr-chains'

const mainnets = [1, 10, 8453, 42161]
const testnets = [11155111, 11155420, 84532, 421614]

describe('Relayr destination and funding network families', () => {
  it.each([...mainnets, ...testnets])('supports configured destination %s', chain => {
    expect(relayrSupportsChain(chain)).toBe(true)
    expect(relayrSupportsChains([chain])).toBe(true)
    expect(relayrPaymentChains([chain])).toEqual(mainnets.includes(chain) ? mainnets : testnets)
  })

  it('accepts all four destinations in either family without offering the other family', () => {
    expect(relayrSupportsChains(mainnets)).toBe(true)
    expect(relayrSupportsChains(testnets)).toBe(true)
    expect(relayrPaymentChains(testnets)).toEqual(testnets)
    expect(relayrPaymentChains(mainnets)).toEqual(mainnets)
  })

  it.each([[], [1, 11155111], [8453, 84532], [1, 1], [999], [NaN]].map(chains => ({ chains })))('rejects ambiguous or unsupported destinations $chains', ({ chains }) => {
    expect(relayrSupportsChains(chains)).toBe(false)
    expect(relayrPaymentChains(chains)).toEqual([])
  })

  it('rejects an unknown individual destination', () => {
    expect(relayrSupportsChain(999)).toBe(false)
  })
})
