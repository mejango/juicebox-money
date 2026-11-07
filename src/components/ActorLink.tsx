import { AddressLink } from '@/components/ui/AddressLink'

/** An activity row's actor: opens the account page, or the explorer for a contract. */
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
  return (
    <AddressLink
      address={actor}
      chainId={chainId}
      explorer={contract}
      className="text-smoke-700 underline decoration-smoke-400 underline-offset-2 hover:text-ink"
    />
  )
}
