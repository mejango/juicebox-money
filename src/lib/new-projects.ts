import { unstable_cache } from 'next/cache'
import { bendystraw, type BsProject } from './bendystraw'
import { toUrn } from './urn'

export type NewProject = {
  key: string
  href: string
  name: string
  tagline: string | null
  logoUri: string | null
  createdAt: number
}

const cachedNewProjects = unstable_cache(
  async () => {
    const data = await bendystraw<{ projects: { items: BsProject[] } }>(
      `query($limit: Int!) {
        projects(
          where: { version: 6 }
          orderBy: "createdAt"
          orderDirection: "desc"
          limit: $limit
        ) {
          items {
            projectId chainId name logoUri projectTagline createdAt suckerGroupId
          }
        }
      }`,
      // Omnichain launches land as one project per chain, so overfetch and
      // collapse each sucker group to its first row.
      { limit: 64 },
      { policy: 'stable' },
    )
    const seen = new Set<string>()
    return data.projects.items.flatMap<NewProject>(project => {
      const group = project.suckerGroupId ?? `${project.chainId}-${project.projectId}`
      if (seen.has(group)) return []
      seen.add(group)
      return [{
        key: group,
        href: `/${toUrn(project.chainId, project.projectId)}`,
        name: project.name ?? `Project ${project.projectId}`,
        tagline: project.projectTagline,
        logoUri: project.logoUri,
        createdAt: project.createdAt,
      }]
    })
  },
  ['juicebox-home-new-projects-v1'],
  { revalidate: 120 },
)

/** Most recently launched V6 projects, one row per sucker group. */
export async function getNewProjects(limit = 8): Promise<NewProject[]> {
  try {
    return (await cachedNewProjects()).slice(0, limit)
  } catch {
    return []
  }
}
