import Link from 'next/link'
import { TrendingCard } from '@/lib/trending'
import { formatTokenAmount } from '@/lib/format'
import { ChainIcon } from './ChainIcon'
import { ProjectLogo } from './ProjectLogo'

/**
 * One white card per project across chains and protocol versions. V6 cards
 * link within this site; older-version cards link out to juicebox.money,
 * marked with a version chip.
 */
export function ProjectCard({ card }: { card: TrendingCard }) {
  const raised = formatTokenAmount(card.volume, card.decimals)
  const className = 'card card-lift group flex flex-col gap-4 p-4 sm:p-5'

  const body = (
    <>
      <div>
        <div className="flex items-center gap-3.5">
          <ProjectLogo name={card.name} logoUri={card.logoUri} size={56} />
          <h3 className="min-w-0 break-words font-agrandir font-medium leading-snug text-ink group-hover:text-bluebs-600">
            {card.name}
          </h3>
        </div>
        <div className="mt-3 flex items-center gap-1.5 text-sm text-smoke-700">
          <span>On</span>
          {card.chainIds.map(chainId => (
            <ChainIcon key={chainId} chainId={chainId} size={18} />
          ))}
        </div>
        {card.tagline ? (
          <p className="mt-2.5 text-sm leading-relaxed text-smoke-700">
            {card.tagline}
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap items-end gap-x-5 gap-y-2">
        <span className="min-w-0">
          <span className="field-label">Raised</span>
          <span className="text-sm font-bold text-ink">
            {raised} {card.symbol}
          </span>
        </span>
        <span className="min-w-0">
          <span className="field-label">Payments</span>
          <span className="text-sm font-bold text-ink">
            {card.paymentsCount.toLocaleString('en-US')}
          </span>
        </span>
        <span className="ml-auto">
          <span className="chip bg-smoke-100 text-smoke-700">
            V{card.version}
          </span>
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
