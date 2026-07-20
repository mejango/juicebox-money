import Image, { type StaticImageData } from 'next/image'
import arbitrumIcon from '@/assets/chains/arbitrum.svg'
import baseIcon from '@/assets/chains/base.svg'
import mainnetIcon from '@/assets/chains/mainnet.svg'
import optimismIcon from '@/assets/chains/optimism.svg'
import { chainName } from '@/lib/urn'

const CHAIN_ICON: Record<number, StaticImageData> = {
  1: mainnetIcon,
  11155111: mainnetIcon,
  10: optimismIcon,
  11155420: optimismIcon,
  8453: baseIcon,
  84532: baseIcon,
  42161: arbitrumIcon,
  421614: arbitrumIcon,
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
