import { formatUnits } from 'viem'

export function formatTokenAmount(
  wei: bigint | string,
  decimals = 18,
  maxDigits = 4,
): string {
  const value = Number(formatUnits(BigInt(wei), decimals))
  if (value === 0) return '0'
  if (value < 0.0001) return '<0.0001'
  return value.toLocaleString('en-US', { maximumFractionDigits: maxDigits })
}

export function formatDate(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

/** Compact relative time for activity rows: "7m", "3h", "2d". */
export function timeAgo(timestamp: number): string {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - timestamp)
  if (seconds < 60) return 'now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86400)}d`
}

export function truncateAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

export function ipfsUrl(uri: string | null | undefined): string | null {
  if (!uri) return null
  // Juicebox's dedicated gateway — far faster and more reliable than ipfs.io.
  return `https://jbm.infura-ipfs.io/ipfs/${uri.replace('ipfs://', '')}`
}
