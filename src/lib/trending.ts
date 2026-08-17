import {
  bendystraw,
  suckerGroupAccountingToken,
  BsProject,
} from './bendystraw'
import { legacyProjectHref, toUrn } from './urn'

/**
 * One trending card, regardless of protocol version. V6 projects link within
 * this site; V1–V5 projects link out to old.juicebox.money, which keeps
 * serving prior versions now that this app holds the apex domain.
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
  /** null when the group's members disagree on the accounting token, so the
   *  group volume has no single unit to state it in. */
  decimals: number | null
  symbol: string | null
  paymentsCount: number
  chainIds: number[]
  trendingScore: bigint
}

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
    { policy: 'stable' },
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

    // `volume` is the GROUP total, so labelling it with one member's symbol and
    // decimals is only correct when every member agrees — a USDC member paired
    // with an ETH one renders the total 1e12x off and calls it ETH. The query
    // caps members at 8; a full page can't be checked for agreement at all.
    const accounting =
      members.length < 8 ? suckerGroupAccountingToken(members) : null

    const urn = toUrn(representative.chainId, representative.projectId)
    return [
      {
        key: `bs-${group.id}`,
        href:
          group.version === 6
            ? `/${urn}`
            : legacyProjectHref(
                representative.chainId,
                representative.projectId,
                group.version,
              ),
        external: group.version !== 6,
        version: group.version,
        name: representative.name ?? `Project ${representative.projectId}`,
        tagline: representative.projectTagline,
        logoUri: representative.logoUri,
        volume: group.volume,
        decimals: accounting?.decimals ?? null,
        symbol: accounting?.symbol ?? null,
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
