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

export function truncateAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

export function ipfsUrl(uri: string | null | undefined): string | null {
  if (!uri) return null
  // Juicebox's dedicated gateway — far faster and more reliable than ipfs.io.
  return `https://jbm.infura-ipfs.io/ipfs/${uri.replace('ipfs://', '')}`
}
