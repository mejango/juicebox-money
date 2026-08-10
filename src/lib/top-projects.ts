import { unstable_cache } from 'next/cache'
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
  balance: string
  volume: string
  projects: { items: BsProject[] }
}

type BalanceGroupsPage = {
  suckerGroups: { items: BalanceGroup[]; totalCount: number }
}

const cachedEthPrice = unstable_cache(
  async () => {
    const response = await fetch('https://juicebox.money/api/juicebox/prices/ethusd')
    if (!response.ok) throw new Error(`ETH price feed returned ${response.status}`)
    const value = Number.parseFloat((await response.json()).price)
    if (!Number.isFinite(value) || value <= 0) throw new Error('ETH price unavailable')
    return value
  },
  ['juicebox-home-eth-price'],
  { revalidate: 1200 },
)

const cachedBalanceGroups = unstable_cache(
  async () => {
    const items: BalanceGroup[] = []
    let totalCount = 0
    do {
      const data = await bendystraw<BalanceGroupsPage>(
        `query($limit: Int!, $offset: Int!) {
          suckerGroups(
            where: { version: 6 }
            orderBy: "balance"
            orderDirection: "desc"
            limit: $limit
            offset: $offset
          ) {
            totalCount
            items {
              id balance volume
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
    return items
  },
  ['juicebox-home-balance-groups-v2'],
  { revalidate: 600 },
)

export async function getHomepageBalanceGroups(): Promise<BalanceGroup[]> {
  try {
    return await cachedBalanceGroups()
  } catch {
    return []
  }
}

export async function getHomepageEthPrice(): Promise<number | null> {
  try {
    return await cachedEthPrice()
  } catch {
    return null
  }
}

export async function getTopBalanceProjects(
  limit = 8,
  offset = 0,
): Promise<TopBalanceProject[]> {
  try {
    const [groups, ethPrice] = await Promise.all([
      cachedBalanceGroups(),
      cachedEthPrice().catch(() => null),
    ])

    return groups
      .flatMap(group => {
        const project = group.projects.items.find(item => item.name) ?? group.projects.items[0]
        if (!project || project.decimals == null) return []
        const symbol = project.tokenSymbol?.toUpperCase()
        if (symbol !== 'ETH' && symbol !== 'USDC') return []
        if (symbol === 'ETH' && ethPrice === null) return []
        const balance = Number(formatUnits(BigInt(group.balance), project.decimals))
        const balanceUsd = symbol === 'ETH' ? balance * (ethPrice ?? 0) : balance
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
