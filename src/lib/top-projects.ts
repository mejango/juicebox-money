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

type BalanceGroup = {
  id: string
  balance: string
  projects: { items: BsProject[] }
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

export async function getTopBalanceProjects(limit = 8): Promise<TopBalanceProject[]> {
  try {
    const [data, ethPrice] = await Promise.all([
      bendystraw<{ suckerGroups: { items: BalanceGroup[] } }>(
        `query($limit: Int!) {
          suckerGroups(
            where: { version: 6 }
            orderBy: "balance"
            orderDirection: "desc"
            limit: $limit
          ) {
            items {
              id balance
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
        { limit: Math.max(limit * 3, 24) },
        { policy: 'stable' },
      ),
      cachedEthPrice().catch(() => null),
    ])

    return data.suckerGroups.items
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
      .slice(0, limit)
  } catch {
    return []
  }
}
