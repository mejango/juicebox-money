// One source of truth per concept. Explorer hosts used to live in three places in this app
// (plus ~12 inline concatenations) and they DRIFTED: OP mainnet was `optimism.etherscan.io`
// here — a host that does not resolve — while a second map had the working `optimistic.` one,
// so every link built from the first was dead.
import { explorerAddressUrl, explorerOrigin, explorerTxUrl } from '@/lib/chainDisplay'
import { describe, expect, it } from 'vitest'

describe('explorer URL builders', () => {
  it('uses the OP mainnet host that actually resolves', () => {
    // `optimism.etherscan.io` does not resolve; `optimistic.` does.
    expect(explorerTxUrl(10, '0xabc')).toBe('https://optimistic.etherscan.io/tx/0xabc')
  })

  it('builds tx and address URLs for every supported chain', () => {
    for (const chainId of [1, 10, 8453, 42161, 11155111, 11155420, 84532, 421614]) {
      expect(explorerTxUrl(chainId, '0xabc')).toMatch(/^https:\/\/[^/]+\/tx\/0xabc$/)
      expect(explorerAddressUrl(chainId, '0xdef')).toMatch(/^https:\/\/[^/]+\/address\/0xdef$/)
    }
  })

  it('returns null for an unknown chain instead of interpolating undefined', () => {
    // The previous template produced `https://undefined/tx/…`.
    expect(explorerTxUrl(999_999, '0xabc')).toBeNull()
    expect(explorerAddressUrl(999_999, '0xdef')).toBeNull()
    expect(explorerOrigin(999_999)).toBeNull()
  })
})
