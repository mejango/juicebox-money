const DWELLIR_HOSTNAMES: Record<number, string> = {
  1: 'api-ethereum-mainnet.n.dwellir.com',
  10: 'api-optimism-mainnet-archive.n.dwellir.com',
  8453: 'api-base-mainnet-archive.n.dwellir.com',
  42161: 'api-arbitrum-mainnet-archive.n.dwellir.com',
  11155111: 'api-ethereum-sepolia.n.dwellir.com',
  11155420: 'api-optimism-sepolia.n.dwellir.com',
  84532: 'api-base-sepolia-archive.n.dwellir.com',
  421614: 'api-arbitrum-sepolia.n.dwellir.com',
}

const BROWSER_FIXTURE_NETWORKS: Record<number, string> = {
  1: 'mainnet',
  10: 'optimism-mainnet',
  8453: 'base-mainnet',
  42161: 'arbitrum-mainnet',
  11155111: 'sepolia',
  11155420: 'optimism-sepolia',
  84532: 'base-sepolia',
  421614: 'arbitrum-sepolia',
}

export function getDwellirRpcUrl(chainId: number): string | undefined {
  if (process.env.NEXT_PUBLIC_DETERMINISTIC_BROWSER === 'true') {
    const network = BROWSER_FIXTURE_NETWORKS[chainId]
    const origin =
      process.env.NEXT_PUBLIC_BROWSER_FIXTURE_ORIGIN ??
      'http://127.0.0.1:4399'
    return network ? `${origin}/rpc/${network}` : undefined
  }
  const hostname = DWELLIR_HOSTNAMES[chainId]
  const apiKey = process.env.NEXT_PUBLIC_DWELLIR_API_KEY?.trim()
  if (!hostname || !apiKey) return undefined
  return `https://${hostname}/${encodeURIComponent(apiKey)}`
}
