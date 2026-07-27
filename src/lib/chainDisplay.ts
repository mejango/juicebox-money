/**
 * Display-only chain metadata.
 *
 * Keep this deliberately small: navigation, activity links, and server-rendered
 * project cards do not need to pull the contract-heavy SDK into their client
 * bundles just to spell a chain name or explorer URL.
 */
const CHAIN_DISPLAY = {
  1: {
    name: 'Ethereum',
    slug: 'eth',
    explorer: 'etherscan.io',
  },
  10: {
    name: 'Optimism',
    slug: 'op',
    explorer: 'optimism.etherscan.io',
  },
  8453: {
    name: 'Base',
    slug: 'base',
    explorer: 'basescan.org',
  },
  42161: {
    name: 'Arbitrum',
    slug: 'arb',
    explorer: 'arbiscan.io',
  },
  11155111: {
    name: 'Sepolia',
    slug: 'sep',
    explorer: 'sepolia.etherscan.io',
  },
  11155420: {
    name: 'Optimism Sepolia',
    slug: 'opsep',
    explorer: 'sepolia-optimism.etherscan.io',
  },
  84532: {
    name: 'Base Sepolia',
    slug: 'basesep',
    explorer: 'sepolia.basescan.org',
  },
  421614: {
    name: 'Arbitrum Sepolia',
    slug: 'arbsep',
    explorer: 'sepolia.arbiscan.io',
  },
} as const

type DisplayChainId = keyof typeof CHAIN_DISPLAY

function displayChain(chainId: number) {
  return CHAIN_DISPLAY[chainId as DisplayChainId]
}

export function displayChainName(chainId: number): string {
  return displayChain(chainId)?.name ?? `Chain ${chainId}`
}

export function displayChainSlug(chainId: number): string | null {
  return displayChain(chainId)?.slug ?? null
}

export function displayChainId(slug: string): number | null {
  const entry = Object.entries(CHAIN_DISPLAY).find(
    ([, chain]) => chain.slug === slug,
  )
  return entry ? Number(entry[0]) : null
}

export function explorerHostname(chainId: number): string | null {
  return displayChain(chainId)?.explorer ?? null
}
