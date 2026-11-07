import { describe, expect, it } from 'vitest'
import { resolveProjectDeployments } from '@/lib/bendystraw'
import { byChainOrder, displayChainName, PRODUCTION_CHAIN_IDS } from '@/lib/chainDisplay'
import { PRODUCTION_CHAINS, TESTNET_CHAINS } from '@/lib/chains'

describe('chain display order', () => {
  it('is Ethereum, Base, Arbitrum, Optimism', () => {
    expect(PRODUCTION_CHAIN_IDS.map(displayChainName)).toEqual(['Ethereum', 'Base', 'Arbitrum', 'Optimism'])
    expect([10, 42161, 1, 8453].sort(byChainOrder)).toEqual(PRODUCTION_CHAIN_IDS)
  })

  it('holds the wagmi chain tuples to the same order', () => {
    expect(PRODUCTION_CHAINS.map(chain => chain.id)).toEqual(PRODUCTION_CHAIN_IDS)
    const testnets = TESTNET_CHAINS.map(chain => chain.id)
    expect(testnets.map(displayChainName)).toEqual(['Sepolia', 'Base Sepolia', 'Arbitrum Sepolia', 'Optimism Sepolia'])
    expect([...testnets].sort(byChainOrder)).toEqual(testnets)
  })

  it('orders a project\'s deployments, which feed the header and the Pay select', () => {
    const row = (chainId: number) => ({ chainId, projectId: 3, version: 6, suckerGroupId: 'group' })
    const home = row(10)
    expect(resolveProjectDeployments(home, [1, 10, 8453, 42161].map(row)).map(item => item.chainId)).toEqual([1, 8453, 42161, 10])
  })
})
