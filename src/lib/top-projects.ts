import { unstable_cache } from 'next/cache'
import { fillIndexedMetadata } from '@/lib/project-metadata-fill'
import { formatUnits } from 'viem'
import { bendystraw, type BsProject } from './bendystraw'
import { displayChainSlug } from './chainDisplay'
import { toUrn } from './urn'

export type TopBalanceProject = {
  key: string
  rank: number
  projectId: number
  chainId: number
  chainSlug: string | null
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
  /** Payment volume, each payment valued in USD at its own time. 18-dec. */
  volumeUsd: string
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
              id balanceUsd volumeUsd
              projects(orderBy: "chainId", orderDirection: "asc", limit: 8) {
                items {
                  projectId chainId version name logoUri projectTagline volume volumeUsd balance balanceUsd
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
  ['juicebox-home-balance-groups-v6'],
  { revalidate: 600 },
)

function scaledUsd(value: string | null | undefined): bigint | null {
  if (!value) return null
  try {
    return BigInt(value.split('.')[0])
  } catch {
    return null
  }
}

/**
 * The group member holding the most money, so a cross-chain group links to the chain its
 * balance is on. Ties and unpriced members fall back to the earliest member. Revnet
 * Money's top-projects reader applies the same rule.
 */
export function largestBalanceProject(projects: readonly BsProject[]): BsProject | undefined {
  let best = projects[0]
  let bestUsd = scaledUsd(best?.balanceUsd)
  for (const project of projects.slice(1)) {
    const usd = scaledUsd(project.balanceUsd)
    if (usd !== null && (bestUsd === null || usd > bestUsd)) {
      best = project
      bestUsd = usd
    }
  }
  return best
}

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
        const project = largestBalanceProject(group.projects.items)
        if (!project) return []
        const named = project.name ? project : group.projects.items.find(item => item.name)
        const balanceUsd = Number(formatUnits(BigInt(group.balanceUsd), 18))
        if (!Number.isFinite(balanceUsd)) return []
        return [{
          key: group.id,
          projectId: project.projectId,
          chainId: project.chainId,
          chainSlug: displayChainSlug(project.chainId),
          href: `/${toUrn(project.chainId, project.projectId)}`,
          name: named?.name ?? `Project ${project.projectId}`,
          tagline: project.projectTagline,
          logoUri: project.logoUri,
          balanceUsd,
        }]
      })
      .sort((a, b) => b.balanceUsd - a.balanceUsd)
      .slice(offset, offset + limit)
      .map((project, index) => ({ ...project, rank: offset + index + 1 }))
  } catch {
    return []
  }
}
