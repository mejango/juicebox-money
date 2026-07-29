import { bendystraw, BsProject } from './bendystraw'
import { toUrn } from './urn'

/**
 * One trending card, regardless of protocol version. V6 projects link within
 * this site; V1–V5 projects link out to the current juicebox.money, which
 * keeps serving prior versions.
 */
export type TrendingCard = {
  key: string
  href: string
  external: boolean
  version: number
  name: string
  tagline: string | null
  logoUri: string | null
  volume: string
  decimals: number
  symbol: string
  paymentsCount: number
  chainIds: number[]
  trendingScore: bigint
}

const LEGACY_SITE = 'https://juicebox.money'

type SuckerGroupTrending = {
  id: string
  version: number
  volume: string
  trendingScore: string
  paymentsCount: number
  projects: { items: BsProject[] }
}

async function getBendystrawTrending(limit: number): Promise<TrendingCard[]> {
  const data = await bendystraw<{
    suckerGroups: { items: SuckerGroupTrending[] }
  }>(
    `query($limit: Int!) {
      suckerGroups(
        where: { version_in: [4, 5, 6] }
        orderBy: "trendingScore"
        orderDirection: "desc"
        limit: $limit
      ) {
        items {
          id version volume trendingScore paymentsCount
          projects(orderBy: "chainId", orderDirection: "asc", limit: 8) {
            items {
              projectId chainId name logoUri projectTagline tokenSymbol
              decimals suckerGroupId volume paymentsCount
            }
          }
        }
      }
    }`,
    { limit },
    { revalidate: 120 },
  )

  return data.suckerGroups.items.flatMap(group => {
    const members = group.projects.items
    const representative =
      members.find(m => m.name && m.logoUri) ??
      members.find(m => m.name) ??
      members[0]
    if (!representative) return []
    // Skip unnamed dead groups; the storefront isn't a block explorer.
    if (!representative.name && BigInt(group.volume) === 0n) return []

    const urn = toUrn(representative.chainId, representative.projectId)
    return [
      {
        key: `bs-${group.id}`,
        href:
          group.version === 6 ? `/${urn}` : `${LEGACY_SITE}/v${group.version}/${urn}`,
        external: group.version !== 6,
        version: group.version,
        name: representative.name ?? `Project ${representative.projectId}`,
        tagline: representative.projectTagline,
        logoUri: representative.logoUri,
        volume: group.volume,
        decimals: representative.decimals ?? 18,
        symbol: representative.tokenSymbol ?? 'ETH',
        paymentsCount: group.paymentsCount,
        chainIds: members.map(m => m.chainId),
        trendingScore: BigInt(group.trendingScore),
      },
    ]
  })
}

/**
 * Trending across the Bendystraw-indexed protocol versions. A failed indexer
 * request leaves the storefront usable with an empty trending section.
 */
export async function getTrendingCards(limit = 12): Promise<TrendingCard[]> {
  try {
    return (await getBendystrawTrending(limit)).slice(0, limit)
  } catch {
    return []
  }
}
