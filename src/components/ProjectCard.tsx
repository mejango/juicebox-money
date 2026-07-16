import Link from 'next/link'
import { TrendingCard } from '@/lib/trending'
import { formatTokenAmount } from '@/lib/format'
import { ChainBadge } from './ChainBadge'
import { ProjectLogo } from './ProjectLogo'

/**
 * One card per project across chains and protocol versions. V6 cards link
 * within this site; older-version cards link out to juicebox.money, marked
 * with a small version chip.
 */
export function ProjectCard({ card }: { card: TrendingCard }) {
  const raised = formatTokenAmount(card.volume, card.decimals)
  const className =
    'card-lift group flex flex-col gap-4 rounded-2xl border border-ink/10 bg-white p-5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-juice-500'

  const body = (
    <>
      <div>
        <div className="flex items-center gap-3.5">
          <ProjectLogo name={card.name} logoUri={card.logoUri} size={56} />
          <h3 className="min-w-0 break-words font-bold leading-snug group-hover:text-juice-600">
            {card.name}
          </h3>
        </div>
        {card.tagline ? (
          <p className="mt-3 text-sm text-ink/60">{card.tagline}</p>
        ) : null}
      </div>
      <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
        <span className="font-semibold">
          {raised} {card.symbol}
          <span className="font-normal text-ink/50"> raised</span>
        </span>
        <span className="text-ink/50">
          {card.paymentsCount}{' '}
          {card.paymentsCount === 1 ? 'payment' : 'payments'}
        </span>
        <span className="ml-auto flex flex-wrap justify-end gap-1">
          {card.version < 6 ? (
            <span className="inline-flex items-center rounded-full border border-ink/10 bg-ink/5 px-2.5 py-0.5 text-xs font-medium text-ink/60">
              V{card.version}
            </span>
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
