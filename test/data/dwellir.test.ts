import { afterEach, describe, expect, it } from 'vitest'
import { getDwellirRpcUrl } from '@/lib/dwellir'

const originalKey = process.env.NEXT_PUBLIC_DWELLIR_API_KEY

afterEach(() => {
  if (originalKey === undefined) {
    delete process.env.NEXT_PUBLIC_DWELLIR_API_KEY
  } else {
    process.env.NEXT_PUBLIC_DWELLIR_API_KEY = originalKey
  }
})

describe('Dwellir RPC configuration', () => {
  it('maps every supported mainnet and testnet chain', () => {
    process.env.NEXT_PUBLIC_DWELLIR_API_KEY = 'dedicated-browser-key'

    expect(getDwellirRpcUrl(1)).toBe(
      'https://api-ethereum-mainnet.n.dwellir.com/dedicated-browser-key',
    )
    expect(getDwellirRpcUrl(10)).toContain(
      'api-optimism-mainnet-archive.n.dwellir.com',
    )
    expect(getDwellirRpcUrl(8453)).toContain(
      'api-base-mainnet-archive.n.dwellir.com',
    )
    expect(getDwellirRpcUrl(42161)).toContain(
      'api-arbitrum-mainnet-archive.n.dwellir.com',
    )
    expect(getDwellirRpcUrl(11155111)).toContain(
      'api-ethereum-sepolia.n.dwellir.com',
    )
    expect(getDwellirRpcUrl(11155420)).toContain(
      'api-optimism-sepolia.n.dwellir.com',
    )
    expect(getDwellirRpcUrl(84532)).toContain(
      'api-base-sepolia-archive.n.dwellir.com',
    )
    expect(getDwellirRpcUrl(421614)).toContain(
      'api-arbitrum-sepolia.n.dwellir.com',
    )
  })

  it('fails closed for a missing key or unsupported chain', () => {
    delete process.env.NEXT_PUBLIC_DWELLIR_API_KEY
    expect(getDwellirRpcUrl(1)).toBeUndefined()

    process.env.NEXT_PUBLIC_DWELLIR_API_KEY = 'dedicated-browser-key'
    expect(getDwellirRpcUrl(999)).toBeUndefined()
  })
})
