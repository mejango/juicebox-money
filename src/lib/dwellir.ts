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

export function getDwellirRpcUrl(chainId: number): string | undefined {
  const hostname = DWELLIR_HOSTNAMES[chainId]
  const apiKey = process.env.NEXT_PUBLIC_DWELLIR_API_KEY?.trim()
  if (!hostname || !apiKey) return undefined
  return `https://${hostname}/${encodeURIComponent(apiKey)}`
}
