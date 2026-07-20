import { JB_CHAINS, JBChainId } from '@bananapus/nana-sdk-core'
import { bendystraw, BsProject } from './bendystraw'
import { ipfsUrl } from './format'
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

/**
 * The v1–v3 mainnet subgraph (v1 pv "1", v2/v3 pv "2"). Same trendingScore
 * formula lineage as bendystraw's, so scores merge directly.
 */
const LEGACY_SUBGRAPH_URL =
  process.env.NEXT_PUBLIC_LEGACY_SUBGRAPH_URL ??
  'https://api.subgraph.migration.ormilabs.com/api/public/c7abcd86-002e-4cba-8a21-7319b9239191/subgraphs/juicebox/v0.0.1/gn'
const REQUEST_TIMEOUT_MS = 8_000

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

type LegacyProject = {
  projectId: number
  pv: '1' | '2'
  handle: string | null
  metadataUri: string | null
  trendingScore: string
  volume: string
  paymentsCount: number
}

async function getLegacyTrending(limit: number): Promise<TrendingCard[]> {
  const res = await fetch(LEGACY_SUBGRAPH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: `query($limit: Int!) {
        projects(
          orderBy: trendingScore
          orderDirection: desc
          where: { pv_in: ["1", "2"], trendingScore_gt: 0 }
          first: $limit
        ) { projectId pv handle metadataUri trendingScore volume paymentsCount }
      }`,
      variables: { limit },
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    next: { revalidate: 300 },
  })
  if (!res.ok) throw new Error(`legacy subgraph ${res.status}`)
  const json = (await res.json()) as {
    data?: { projects: LegacyProject[] }
  }
  const projects = json.data?.projects ?? []

  // Resolve names/logos from IPFS metadata, best-effort with a short timeout.
  const withMetadata = await Promise.all(
    projects.map(async project => {
      let name: string | null = project.handle
      let tagline: string | null = null
      let logoUri: string | null = null
      const url = project.metadataUri
        ? ipfsUrl(`ipfs://${project.metadataUri}`)
        : null
      if (url) {
        try {
          const meta = await fetch(url, {
            signal: AbortSignal.timeout(4000),
            next: { revalidate: 3600 },
          }).then(r => (r.ok ? r.json() : null))
          if (meta) {
            name = meta.name ?? name
            tagline = meta.projectTagline ?? null
            logoUri = meta.logoUri ?? null
          }
        } catch {
          // Keep handle-only identity when IPFS is slow.
        }
      }
      return { project, name, tagline, logoUri }
    }),
  )

  return withMetadata.flatMap(({ project, name, tagline, logoUri }) => {
    if (!name) return [] // No identity at all: not storefront material.
    const version = project.pv === '1' ? 1 : 2
    // juicebox.money routes v1 by handle only; a handle-less v1 project has
    // no correct destination, so leave it out rather than mislink it.
    if (version === 1 && !project.handle) return []
    const href =
      version === 1
        ? `${LEGACY_SITE}/p/${project.handle}`
        : `${LEGACY_SITE}/v2/p/${project.projectId}`
    return [
      {
        key: `legacy-${project.pv}-${project.projectId}`,
        href,
        external: true,
        version,
        name,
        tagline,
        logoUri,
        volume: project.volume,
        decimals: 18,
        symbol: 'ETH',
        paymentsCount: project.paymentsCount,
        chainIds: [1],
        trendingScore: BigInt(project.trendingScore),
      },
    ]
  })
}

/**
 * Trending across every protocol version, ranked by the shared trending
 * score. Either source failing degrades gracefully to the other.
 */
export async function getTrendingCards(limit = 12): Promise<TrendingCard[]> {
  const [bs, legacy] = await Promise.allSettled([
    getBendystrawTrending(limit),
    getLegacyTrending(limit),
  ])
  const cards = [
    ...(bs.status === 'fulfilled' ? bs.value : []),
    ...(legacy.status === 'fulfilled' ? legacy.value : []),
  ]
  return cards
    .sort((a, b) => (b.trendingScore > a.trendingScore ? 1 : -1))
    .slice(0, limit)
}

export function chainNameFor(chainId: number): string {
  return JB_CHAINS[chainId as JBChainId]?.name ?? `Chain ${chainId}`
}
