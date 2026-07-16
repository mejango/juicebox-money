import Link from 'next/link'
import { BsProject } from '@/lib/bendystraw'
import { formatTokenAmount } from '@/lib/format'
import { toUrn } from '@/lib/urn'
import { ChainBadge } from './ChainBadge'
import { ProjectLogo } from './ProjectLogo'

export function ProjectCard({ project }: { project: BsProject }) {
  const raised = formatTokenAmount(project.volume, project.decimals ?? 18)
  const symbol = project.tokenSymbol ?? 'ETH'

  return (
    <Link
      href={`/${toUrn(project.chainId, project.projectId)}`}
      className="card-lift group flex flex-col gap-4 rounded-2xl border border-ink/10 bg-white p-5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-juice-500"
    >
      <div className="flex items-start gap-3.5">
        <ProjectLogo
          name={project.name}
          logoUri={project.logoUri}
          size={56}
        />
        <div className="min-w-0">
          <h3 className="truncate font-bold leading-snug group-hover:text-juice-600">
            {project.name ?? `Project ${project.projectId}`}
          </h3>
          {project.projectTagline ? (
            <p className="mt-0.5 line-clamp-2 text-sm text-ink/60">
              {project.projectTagline}
            </p>
          ) : null}
        </div>
      </div>
      <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
        <span className="font-semibold">
          {raised} {symbol}
          <span className="font-normal text-ink/50"> raised</span>
        </span>
        <span className="text-ink/50">
          {project.paymentsCount}{' '}
          {project.paymentsCount === 1 ? 'payment' : 'payments'}
        </span>
        <span className="ml-auto">
          <ChainBadge chainId={project.chainId} />
        </span>
      </div>
    </Link>
  )
}
