import { ChainIcon } from '@/components/ChainIcon'
import { ProjectLink } from '@/components/ProjectLink'
import { ProjectLogo } from '@/components/ProjectLogo'
import type { BsProject } from '@/lib/bendystraw'
import { truncateAddress } from '@/lib/format'
import { toUrn } from '@/lib/urn'

const LEGACY_SITE = 'https://juicebox.money'

/** Stable per-deployment identity for deduping owned-project cards. */
export function projectKey(
  project: Pick<BsProject, 'chainId' | 'projectId'>,
): string {
  return `${project.chainId}:${project.projectId}`
}

/** Where a project card links: V6 in-site, earlier versions to the legacy site. */
export function accountProjectHref(
  project: Pick<BsProject, 'chainId' | 'projectId' | 'version'>,
): { href: string; external: boolean } {
  const urn = toUrn(project.chainId, project.projectId)
  return project.version === 6
    ? { href: `/${urn}`, external: false }
    : { href: `${LEGACY_SITE}/v${project.version}/${urn}`, external: true }
}

export type SafeOwnership = {
  safe: string
  threshold: number | null
  ownerCount: number | null
}

/**
 * One owned-project card on the account view: logo, name, chain, version —
 * and, when ownership routes through a multisig, the Safe it belongs to.
 */
export function AccountProjectCard({
  project,
  viaSafe,
}: {
  project: BsProject
  viaSafe?: SafeOwnership | null
}) {
  const name = project.name ?? `Project ${project.projectId}`
  const { href, external } = accountProjectHref(project)
  const className = 'card card-lift group flex flex-col gap-3 p-4'
  const body = (
    <>
      <div className="flex items-center gap-3.5">
        <ProjectLogo name={project.name} logoUri={project.logoUri} size={48} />
        <div className="min-w-0">
          <h3 className="min-w-0 break-words font-agrandir font-medium leading-snug text-ink group-hover:text-bluebs-600">
            {name}
          </h3>
          <div className="mt-1.5 flex items-center gap-1.5">
            <ChainIcon chainId={project.chainId} size={16} standalone />
            <span className="chip bg-smoke-100 text-smoke-700">
              V{project.version}
            </span>
          </div>
        </div>
      </div>
      {viaSafe ? (
        <p className="text-xs text-smoke-600" title={viaSafe.safe}>
          via Safe {truncateAddress(viaSafe.safe)}
          {viaSafe.threshold && viaSafe.ownerCount
            ? ` (${viaSafe.threshold}/${viaSafe.ownerCount})`
            : ''}
        </p>
      ) : null}
    </>
  )

  if (external) {
    return (
      <a href={href} className={className} aria-label={`Open ${name}`}>
        {body}
      </a>
    )
  }
  return (
    <ProjectLink
      href={href}
      projectHint={{
        name,
        logoUri: project.logoUri,
        tagline: project.projectTagline,
      }}
      className={className}
      aria-label={`Open ${name}`}
    >
      {body}
    </ProjectLink>
  )
}
