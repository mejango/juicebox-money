import { unstable_cache } from 'next/cache'
import { fillIndexedMetadata } from '@/lib/project-metadata-fill'
import { formatUnits } from 'viem'
import { bendystraw, type BsProject } from './bendystraw'
import { toUrn } from './urn'

export type TopBalanceProject = {
  key: string
  href: string
  name: string
  tagline: string | null
  logoUri: string | null
  balanceUsd: number
}

export type BalanceGroup = {
  id: string
  /** Every token's balance at its latest USD rate. 18-dec. */
  balanceUsd: string
  projects: { items: BsProject[] }
}

type BalanceGroupsPage = {
  suckerGroups: { items: BalanceGroup[]; totalCount: number }
}

const cachedBalanceGroups = unstable_cache(
  async () => {
    const items: BalanceGroup[] = []
    let totalCount = 0
    do {
      const data = await bendystraw<BalanceGroupsPage>(
        `query($limit: Int!, $offset: Int!) {
          suckerGroups(
            where: { version: 6 }
            orderBy: "balanceUsd"
            orderDirection: "desc"
            limit: $limit
            offset: $offset
          ) {
            totalCount
            items {
              id balanceUsd
              projects(orderBy: "chainId", orderDirection: "asc", limit: 8) {
                items {
                  projectId chainId version name logoUri projectTagline volume volumeUsd balance
                  paymentsCount contributorsCount createdAt suckerGroupId token tokenSymbol
                  decimals currency isRevnet owner metadataUri
                }
              }
            }
          }
        }`,
        { limit: 250, offset: items.length },
        { policy: 'stable' },
      )
      const page = data.suckerGroups.items
      totalCount = data.suckerGroups.totalCount
      items.push(...page)
      if (!page.length) break
    } while (items.length < totalCount)
    return Promise.all(
      items.map(async group => ({
        ...group,
        projects: { items: await fillIndexedMetadata(group.projects.items) },
      })),
    )
  },
  ['juicebox-home-balance-groups-v4'],
  { revalidate: 600 },
)

export async function getHomepageBalanceGroups(): Promise<BalanceGroup[]> {
  try {
    return await cachedBalanceGroups()
  } catch {
    return []
  }
}

export async function getTopBalanceProjects(
  limit = 8,
  offset = 0,
): Promise<TopBalanceProject[]> {
  try {
    const groups = await cachedBalanceGroups()
    return groups
      .flatMap(group => {
        const project = group.projects.items.find(item => item.name) ?? group.projects.items[0]
        if (!project) return []
        const balanceUsd = Number(formatUnits(BigInt(group.balanceUsd), 18))
        if (!Number.isFinite(balanceUsd)) return []
        return [{
          key: group.id,
          href: `/${toUrn(project.chainId, project.projectId)}`,
          name: project.name ?? `Project ${project.projectId}`,
          tagline: project.projectTagline,
          logoUri: project.logoUri,
          balanceUsd,
        }]
      })
      .sort((a, b) => b.balanceUsd - a.balanceUsd)
      .slice(offset, offset + limit)
  } catch {
    return []
  }
}
