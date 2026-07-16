import Link from 'next/link'
import { TrendingCard } from '@/lib/trending'
import { formatTokenAmount } from '@/lib/format'
import { ChainBadge } from './ChainBadge'
import { ProjectLogo } from './ProjectLogo'

/**
 * One framed panel per project across chains and protocol versions. V6 cards
 * link within this site; older-version cards link out to juicebox.money,
 * marked with a version chip.
 */
export function ProjectCard({ card }: { card: TrendingCard }) {
  const raised = formatTokenAmount(card.volume, card.decimals)
  const className =
    'panel card-lift group flex flex-col gap-4 p-4 sm:p-5'

  const body = (
    <>
      <div>
        <div className="flex items-center gap-3.5">
          <ProjectLogo name={card.name} logoUri={card.logoUri} size={56} />
          <h3 className="min-w-0 break-words font-display font-bold leading-snug text-ink group-hover:text-juice">
            {card.name}
          </h3>
        </div>
        {card.tagline ? (
          <p className="mt-3 text-sm leading-relaxed text-dim">{card.tagline}</p>
        ) : null}
      </div>
      <div className="mt-auto flex flex-wrap items-end gap-x-5 gap-y-2">
        <span className="min-w-0">
          <span className="silk-label">Raised</span>
          <span className="text-sm font-bold text-juice">
            {raised} {card.symbol}
          </span>
        </span>
        <span className="min-w-0">
          <span className="silk-label">Payments</span>
          <span className="text-sm font-bold text-ink">
            {card.paymentsCount.toLocaleString('en-US')}
          </span>
        </span>
        <span className="ml-auto flex flex-wrap justify-end gap-1">
          {card.version < 6 ? (
            <span className="chip bg-frame text-ink">V{card.version}</span>
          ) : null}
          {card.chainIds.map(chainId => (
            <ChainBadge key={chainId} chainId={chainId} />
          ))}
        </span>
      </div>
    </>
  )

  if (card.external) {
    return (
      <a href={card.href} className={className}>
        {body}
      </a>
    )
  }
  return (
    <Link href={card.href} className={className}>
      {body}
    </Link>
  )
}
