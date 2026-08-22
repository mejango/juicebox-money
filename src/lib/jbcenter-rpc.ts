import { createJBCenterRpcProvider } from '@bananapus/nana-sdk-core/jbcenter'
import { custom, http, type Transport } from 'viem'

const APP_ORIGIN = 'https://juicebox.money'
const FIXTURE_NETWORKS: Record<number, string> = {
  1: 'mainnet',
  10: 'optimism-mainnet',
  8453: 'base-mainnet',
  42161: 'arbitrum-mainnet',
  11155111: 'sepolia',
  11155420: 'optimism-sepolia',
  84532: 'base-sepolia',
  421614: 'arbitrum-sepolia',
}

const serverFetch: typeof fetch = (input, init) => {
  const headers = new Headers(init?.headers)
  headers.set('Origin', APP_ORIGIN)
  return fetch(input, { ...init, headers })
}

export function jbCenterRpcTransport(
  chainId: number,
  timeoutMs = 15_000,
): Transport {
  if (process.env.NEXT_PUBLIC_DETERMINISTIC_BROWSER === 'true') {
    const network = FIXTURE_NETWORKS[chainId]
    const origin =
      process.env.NEXT_PUBLIC_BROWSER_FIXTURE_ORIGIN ??
      'http://127.0.0.1:4399'
    return network ? http(`${origin}/rpc/${network}`) : http()
  }
  return custom(
    createJBCenterRpcProvider(chainId, {
      fetch: typeof window === 'undefined' ? serverFetch : undefined,
      timeoutMs,
    }),
    { retryCount: 1 },
  )
}
