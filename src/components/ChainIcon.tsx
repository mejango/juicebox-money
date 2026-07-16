import Image from 'next/image'
import { chainName } from '@/lib/urn'

const CHAIN_ICON: Record<number, string> = {
  1: '/chains/mainnet.svg',
  11155111: '/chains/mainnet.svg',
  10: '/chains/optimism.svg',
  11155420: '/chains/optimism.svg',
  8453: '/chains/base.svg',
  84532: '/chains/base.svg',
  42161: '/chains/arbitrum.svg',
  421614: '/chains/arbitrum.svg',
}

/** A small round chain mark — icon only, name available on hover. */
export function ChainIcon({
  chainId,
  size = 18,
  className = '',
}: {
  chainId: number
  size?: number
  className?: string
}) {
  const src = CHAIN_ICON[chainId]
  const name = chainName(chainId)
  if (!src) {
    return (
      <span title={name} className={`text-xs text-smoke-500 ${className}`}>
        {name}
      </span>
    )
  }
  return (
    <Image
      src={src}
      alt={name}
      title={name}
      width={size}
      height={size}
      className={`inline-block rounded-full ${className}`}
    />
  )
}
