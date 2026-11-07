import Link from 'next/link'
import { AddressLabel } from '@/components/ui/AddressLabel'
import { explorerAddressUrl } from '@/lib/chainDisplay'

const LINK_CLASS = 'text-smoke-700 underline decoration-smoke-400 underline-offset-2 hover:text-ink'

/**
 * An activity row's actor: opens the account page, or the explorer for a contract.
 * Not built on AddressLink, whose Safe badge would load on every page with a feed.
 */
export function ActorLink({
  actor,
  chainId,
  contract = false,
}: {
  actor: string
  chainId?: number
  contract?: boolean
}) {
  if (!actor) return null
  if (!contract) {
    return (
      <Link href={`/account/${actor}`} prefetch={false} className={LINK_CLASS}>
        <AddressLabel address={actor} />
      </Link>
    )
  }
  const url = chainId !== undefined ? explorerAddressUrl(chainId, actor) : null
  return url ? (
    <a href={url} target="_blank" rel="noopener noreferrer" className={LINK_CLASS}>
      <AddressLabel address={actor} />
    </a>
  ) : (
    <AddressLabel address={actor} className="text-smoke-700" />
  )
}
