import type { ReactNode } from 'react'
import { explorerAddressUrl } from '@/lib/chainDisplay'
import { AddressLabel } from '@/components/ui/AddressLabel'

/**
 * A truncated address that links to the chain's block explorer, or a plain
 * span when the chain has none. `className` styles both the link and the
 * fallback span (the link additionally gets hover:underline); `children`
 * replaces the truncated-address label and `note` appends the muted
 * annotation some tables show after the address.
 *
 * The hostname is ALWAYS resolved from `chainId` here. There is deliberately
 * no pre-resolved-host escape hatch: every one that existed was filled from
 * the SDK's `etherscanHostname`, which is dead for OP mainnet.
 */
export function AddressLink({
  address,
  chainId,
  className = 'text-ink',
  children,
  note,
  title,
}: {
  address: string
  chainId?: number
  className?: string
  children?: ReactNode
  note?: ReactNode
  title?: string
}) {
  // Resolved through the app's single explorer registry (lib/chainDisplay).
  const url = chainId !== undefined ? explorerAddressUrl(chainId, address) : null
  const label = children ?? <AddressLabel address={address} />
  const core = url ? (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title={title}
      className={`${className} hover:underline`}
    >
      {label}
    </a>
  ) : (
    <span title={title} className={className}>
      {label}
    </span>
  )
  if (note === undefined) return core
  return (
    <span>
      {core}
      {note ? (
        <span className="ml-1.5 text-xs text-smoke-500">{note}</span>
      ) : null}
    </span>
  )
}
