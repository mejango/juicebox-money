import type { ComponentProps } from 'react'
import { SafeBadge } from '@/components/SafeBadge'
import { AddressLink } from './AddressLink'

/** An address link with its existing, independently resolved Safe badge. */
export function SafeAddressLink({
  address,
  chainId,
  ...props
}: Omit<ComponentProps<typeof AddressLink>, 'note' | 'chainId'> & {
  chainId: number
}) {
  return (
    <span className="inline-flex items-center">
      <AddressLink {...props} address={address} chainId={chainId} />
      <SafeBadge address={address} chainId={chainId} />
    </span>
  )
}
