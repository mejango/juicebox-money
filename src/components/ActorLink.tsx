import { AddressLabel } from '@/components/ui/AddressLabel'

/** An activity row's actor: an explorer link when one resolves, else plain text. */
export function ActorLink({
  href,
  actor,
}: {
  href: string | null
  actor: string
}) {
  return href ? (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-smoke-700 underline decoration-smoke-400 underline-offset-2 hover:text-ink"
    >
      <AddressLabel address={actor} />
    </a>
  ) : (
    <AddressLabel address={actor} className="text-smoke-700" />
  )
}
