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
    explorer: 'optimistic.etherscan.io',
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
    // Matches the SDK's `JB_CHAINS[11155420].etherscanHostname`; the parity
    // test in test/explorer-and-safe-registries.test.ts holds them together.
    explorer: 'optimism-sepolia.blockscout.com',
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

/** Mainnets in display order. Every chain list on the site follows this one. */
export const PRODUCTION_CHAIN_IDS = [1, 8453, 42161, 10] as const
const CHAIN_DISPLAY_ORDER: readonly number[] = [
  ...PRODUCTION_CHAIN_IDS,
  11155111,
  84532,
  421614,
  11155420,
]

/** Sort key for a chain list. An unknown chain sorts last, by chain ID. */
function chainSortIndex(chainId: number): number {
  const index = CHAIN_DISPLAY_ORDER.indexOf(chainId)
  return index < 0 ? CHAIN_DISPLAY_ORDER.length + chainId : index
}

export function byChainOrder(a: number, b: number): number {
  return chainSortIndex(a) - chainSortIndex(b)
}

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

/**
 * THE explorer URL builders. Every explorer link in this app routes through these.
 *
 * This map used to be one of three sources (a second registry in transaction-review.ts, the
 * SDK's `etherscanHostname` inline, plus a dozen hand-built concatenations) and they DRIFTED:
 * OP mainnet was `optimism.etherscan.io` here — a host that does not resolve — while the
 * other map had the working `optimistic.` one. Every link built from this map was dead.
 *
 * Returns null for an unknown chain so callers omit the link rather than rendering
 * `https://undefined/tx/…`.
 */
export function explorerTxUrl(chainId: number, hash: string): string | null {
  const host = explorerHostname(chainId)
  return host ? `https://${host}/tx/${hash}` : null
}

export function explorerAddressUrl(chainId: number, address: string): string | null {
  const host = explorerHostname(chainId)
  return host ? `https://${host}/address/${address}` : null
}

export function explorerTokenUrl(chainId: number, token: string): string | null {
  const host = explorerHostname(chainId)
  return host ? `https://${host}/token/${token}` : null
}

/** Origin only, for callers that append their own path. */
export function explorerOrigin(chainId: number): string | null {
  const host = explorerHostname(chainId)
  return host ? `https://${host}` : null
}
