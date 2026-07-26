'use client'

import { useEnsName } from '@/hooks/useEnsName'
import { truncateAddress } from '@/lib/format'

export function AddressText({ address }: { address: string }) {
  const { data: ensName } = useEnsName(address)
  return <>{ensName ?? truncateAddress(address)}</>
}

/** Prefer ENS, retain the compact address as the fallback and full-address
 * tooltip. */
export function AddressLabel({
  address,
  className,
}: {
  address: string
  className?: string
}) {
  return (
    <span className={className} title={address}>
      <AddressText address={address} />
    </span>
  )
}
