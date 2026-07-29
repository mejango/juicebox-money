import Link from 'next/link'
import { ChainIcon } from '@/components/ChainIcon'
import { ProjectLogo } from '@/components/ProjectLogo'
import { accountProjectHref } from '@/components/account/AccountProjectCard'
import { AddressLabel } from '@/components/ui/AddressLabel'
import type { BsOperatorGrant, BsProject } from '@/lib/bendystraw'
import { permissionDefinition } from '@/lib/permissions'

export type OperatedProjectGroup = {
  chainId: number
  projectId: number
  version: number
  project: BsProject | null
  grants: BsOperatorGrant[]
  isRevnetOperator: boolean
}

/** Group grant rows by exact deployment, pairing each with its indexed project. */
export function groupOperatorGrants(
  grants: BsOperatorGrant[],
  projects: BsProject[],
): OperatedProjectGroup[] {
  const projectByKey = new Map(
    projects.map(project => [
      `${project.chainId}:${project.projectId}:${project.version}`,
      project,
    ]),
  )
  const groups = new Map<string, OperatedProjectGroup>()
  for (const grant of grants) {
    const key = `${grant.chainId}:${grant.projectId}:${grant.version}`
    const group = groups.get(key) ?? {
      chainId: grant.chainId,
      projectId: grant.projectId,
      version: grant.version,
      project: projectByKey.get(key) ?? null,
      grants: [],
      isRevnetOperator: false,
    }
    group.grants.push(grant)
    group.isRevnetOperator = group.isRevnetOperator || !!grant.isRevnetOperator
    groups.set(key, group)
  }
  return [...groups.values()].sort(
    (a, b) => a.chainId - b.chainId || a.projectId - b.projectId,
  )
}

/**
 * Permission chips. The catalog's labels describe V6 permission ids;
 * earlier versions number their ids differently, so those rows show the
 * bare id rather than a possibly wrong name.
 */
function PermissionChips({
  permissions,
  version,
}: {
  permissions: number[]
  version: number
}) {
  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5">
      {permissions.map(id => {
        const definition = version === 6 ? permissionDefinition(id) : null
        return (
          <span
            key={id}
            title={definition?.description}
            className="chip bg-smoke-100 text-smoke-700"
          >
            {definition?.label ?? `Permission #${id}`}
          </span>
        )
      })}
    </div>
  )
}

/** Projects this account operates: grouped grants with permission chips. */
export function AccountOperatedProjects({
  groups,
}: {
  groups: OperatedProjectGroup[]
}) {
  if (groups.length === 0) {
    return (
      <p className="text-sm text-smoke-600">
        No projects have granted this account permissions.
      </p>
    )
  }
  return (
    <div className="space-y-4">
      {groups.map(group => {
        const name =
          group.project?.name ?? `Project ${group.projectId}`
        const { href, external } = accountProjectHref(group)
        const title = external ? (
          <a
            href={href}
            className="font-agrandir font-medium text-ink hover:text-bluebs-600"
          >
            {name}
          </a>
        ) : (
          <Link
            href={href}
            className="font-agrandir font-medium text-ink hover:text-bluebs-600"
          >
            {name}
          </Link>
        )
        return (
          <div
            key={`${group.chainId}:${group.projectId}:${group.version}`}
            className="card p-4"
          >
            <div className="flex flex-wrap items-center gap-3">
              <ProjectLogo
                name={group.project?.name ?? null}
                logoUri={group.project?.logoUri ?? null}
                size={40}
              />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  {title}
                  {group.isRevnetOperator ? (
                    <span className="chip bg-bluebs-500 text-white">
                      Revnet operator
                    </span>
                  ) : null}
                </div>
                <div className="mt-1 flex items-center gap-1.5">
                  <ChainIcon chainId={group.chainId} size={16} standalone />
                  <span className="chip bg-smoke-100 text-smoke-700">
                    V{group.version}
                  </span>
                </div>
              </div>
            </div>
            <div className="mt-3 space-y-3">
              {group.grants.map(grant => (
                <div key={`${grant.account}`}>
                  <p className="text-xs text-smoke-500">
                    Granted by{' '}
                    <AddressLabel
                      address={grant.account}
                      className="text-smoke-700"
                    />
                  </p>
                  <PermissionChips
                    permissions={grant.permissions}
                    version={group.version}
                  />
                </div>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}
