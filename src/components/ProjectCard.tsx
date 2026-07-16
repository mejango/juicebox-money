import Link from 'next/link'
import { BsProject } from '@/lib/bendystraw'
import { formatTokenAmount } from '@/lib/format'
import { toUrn } from '@/lib/urn'
import { ChainBadge } from './ChainBadge'
import { ProjectLogo } from './ProjectLogo'

/**
 * One card per project ACROSS chains: `project` is the representative
 * deployment (used for identity + link), `chainIds` every chain it lives on,
 * and the stats are sucker-group aggregates.
 */
export function ProjectCard({
  project,
  chainIds,
  volume,
  paymentsCount,
}: {
  project: BsProject
  chainIds?: number[]
  volume?: string
  paymentsCount?: number
}) {
  const raised = formatTokenAmount(
    volume ?? project.volume,
    project.decimals ?? 18,
  )
  const symbol = project.tokenSymbol ?? 'ETH'
  const payments = paymentsCount ?? project.paymentsCount
  const chains = chainIds?.length ? chainIds : [project.chainId]

  return (
    <Link
      href={`/${toUrn(project.chainId, project.projectId)}`}
      className="card-lift group flex flex-col gap-4 rounded-2xl border border-ink/10 bg-white p-5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-juice-500"
    >
      <div>
        <div className="flex items-center gap-3.5">
          <ProjectLogo
            name={project.name}
            logoUri={project.logoUri}
            size={56}
          />
          <h3 className="min-w-0 break-words font-bold leading-snug group-hover:text-juice-600">
            {project.name ?? `Project ${project.projectId}`}
          </h3>
        </div>
        {project.projectTagline ? (
          <p className="mt-3 text-sm text-ink/60">{project.projectTagline}</p>
        ) : null}
      </div>
      <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
        <span className="font-semibold">
          {raised} {symbol}
          <span className="font-normal text-ink/50"> raised</span>
        </span>
        <span className="text-ink/50">
          {payments} {payments === 1 ? 'payment' : 'payments'}
        </span>
        <span className="ml-auto flex flex-wrap justify-end gap-1">
          {chains.map(chainId => (
            <ChainBadge key={chainId} chainId={chainId} />
          ))}
        </span>
      </div>
    </Link>
  )
}
