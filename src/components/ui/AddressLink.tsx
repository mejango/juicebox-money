import type { ReactNode } from 'react'
import { explorerHostname } from '@/lib/chainDisplay'
import { AddressLabel } from '@/components/ui/AddressLabel'

/**
 * A truncated address that links to the chain's block explorer, or a plain
 * span when the chain has none. Pass `host` when the explorer hostname is
 * already resolved, or `chainId` to look it up. `className` styles both the
 * link and the fallback span (the link additionally gets hover:underline);
 * `children` replaces the truncated-address label and `note` appends the
 * muted annotation some tables show after the address.
 */
export function AddressLink({
  address,
  chainId,
  host,
  className = 'text-ink',
  children,
  note,
  title,
}: {
  address: string
  chainId?: number
  host?: string
  className?: string
  children?: ReactNode
  note?: ReactNode
  title?: string
}) {
  // Resolved through the app's single explorer registry (lib/chainDisplay), not a fourth
  // source — the SDK hostname was one of the maps that drifted on OP mainnet.
  const explorerHost =
    host ?? (chainId !== undefined ? (explorerHostname(chainId) ?? undefined) : undefined)
  const label = children ?? <AddressLabel address={address} />
  const core = explorerHost ? (
    <a
      href={`https://${explorerHost}/address/${address}`}
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
