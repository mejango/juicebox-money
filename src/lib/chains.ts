import {
  arbitrum,
  arbitrumSepolia,
  base,
  baseSepolia,
  mainnet,
  optimism,
  optimismSepolia,
  sepolia,
} from '@bananapus/nana-sdk-core/chains'

// Literal tuples for wagmi's types. test/chain-order.test.ts holds them to the display order in chainDisplay.ts.
export const PRODUCTION_CHAINS = [mainnet, base, arbitrum, optimism] as const
export const TESTNET_CHAINS = [
  sepolia,
  baseSepolia,
  arbitrumSepolia,
  optimismSepolia,
] as const
export const SUPPORTED_CHAINS = [
  ...PRODUCTION_CHAINS,
  ...TESTNET_CHAINS,
] as const

export type ChainEnvironment = 'production' | 'testnet'

export function chainsForEnvironment(environment: ChainEnvironment) {
  return environment === 'production' ? PRODUCTION_CHAINS : TESTNET_CHAINS
}

export function environmentForChainIds(
  chainIds: readonly number[],
): ChainEnvironment {
  const firstChainId = chainIds.find(chainId =>
    SUPPORTED_CHAINS.some(chain => chain.id === chainId),
  )
  return TESTNET_CHAINS.some(chain => chain.id === firstChainId)
    ? 'testnet'
    : 'production'
}
