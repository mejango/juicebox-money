/**
 * Minimal bendystraw client: plain fetch, no client library. Every query lives
 * here, typed by hand — auditable end to end. All queries are V6-only.
 */

const MAINNET_URL =
  process.env.NEXT_PUBLIC_BENDYSTRAW_URL ?? 'https://bendystraw.xyz/graphql'
const TESTNET_URL = 'https://testnet.bendystraw.xyz/graphql'

export const IS_TESTNET = process.env.NEXT_PUBLIC_TESTNET === 'true'

export async function bendystraw<T>(
  query: string,
  variables: Record<string, unknown>,
  opts: { revalidate?: number } = {},
): Promise<T> {
  const res = await fetch(IS_TESTNET ? TESTNET_URL : MAINNET_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    next: { revalidate: opts.revalidate ?? 60 },
  })
  if (!res.ok) throw new Error(`bendystraw ${res.status}`)
  const json = (await res.json()) as {
    data?: T
    errors?: { message: string }[]
  }
  if (json.errors?.length) throw new Error(json.errors[0].message)
  if (!json.data) throw new Error('bendystraw: empty response')
  return json.data
}

export type BsProject = {
  projectId: number
  chainId: number
  version: number
  name: string | null
  logoUri: string | null
  projectTagline: string | null
  volume: string
  balance: string
  paymentsCount: number
  contributorsCount: number
  createdAt: number
  suckerGroupId: string | null
  token: string | null
  tokenSymbol: string | null
  decimals: number | null
  currency: number | null
  isRevnet: boolean | null
  owner: string | null
  metadataUri: string | null
}

const PROJECT_FIELDS = `
  projectId chainId version name logoUri projectTagline volume balance
  paymentsCount contributorsCount createdAt suckerGroupId token tokenSymbol
  decimals currency isRevnet owner metadataUri
`

export async function getProject(
  chainId: number,
  projectId: number,
): Promise<BsProject | null> {
  const data = await bendystraw<{ project: BsProject | null }>(
    `query($chainId: Float!, $projectId: Float!) {
      project(chainId: $chainId, projectId: $projectId, version: 6) { ${PROJECT_FIELDS} }
    }`,
    { chainId, projectId },
    { revalidate: 30 },
  )
  return data.project
}

export type BsSuckerGroup = {
  id: string
  volume: string
  balance: string
  paymentsCount: number
  contributorsCount: number
  projects: { items: BsProject[] }
}

/**
 * Trending = one entry per SUCKER GROUP: an omnichain project's per-chain
 * deployments collapse into a single row with aggregated stats.
 */
export async function getTrendingSuckerGroups(
  limit = 12,
): Promise<BsSuckerGroup[]> {
  const data = await bendystraw<{ suckerGroups: { items: BsSuckerGroup[] } }>(
    `query($limit: Int!) {
      suckerGroups(
        where: { version: 6 }
        orderBy: "volume"
        orderDirection: "desc"
        limit: $limit
      ) {
        items {
          id volume balance paymentsCount contributorsCount
          projects(orderBy: "chainId", orderDirection: "asc", limit: 8) {
            items { ${PROJECT_FIELDS} }
          }
        }
      }
    }`,
    { limit },
    { revalidate: 120 },
  )
  return data.suckerGroups.items
}

export async function searchProjects(
  text: string,
  limit = 8,
): Promise<BsProject[]> {
  const data = await bendystraw<{ projects: { items: BsProject[] } }>(
    `query($text: String!, $limit: Int!) {
      projects(
        where: { version: 6, name_contains_nocase: $text }
        orderBy: "volume"
        orderDirection: "desc"
        limit: $limit
      ) { items { ${PROJECT_FIELDS} } }
    }`,
    { text, limit },
    { revalidate: 30 },
  )
  return data.projects.items
}

export type BsActivityEvent = {
  id: string
  chainId: number
  projectId: number
  timestamp: number
  txHash: string
  payEvent: {
    amount: string
    beneficiary: string
    memo: string | null
    newlyIssuedTokenCount: string
  } | null
  cashOutTokensEvent: {
    cashOutCount: string
    reclaimAmount: string
    beneficiary: string
  } | null
}

export async function getProjectActivity(
  suckerGroupId: string,
  limit = 20,
): Promise<BsActivityEvent[]> {
  const data = await bendystraw<{
    activityEvents: { items: BsActivityEvent[] }
  }>(
    `query($suckerGroupId: String!, $limit: Int!) {
      activityEvents(
        where: { suckerGroupId: $suckerGroupId }
        orderBy: "timestamp"
        orderDirection: "desc"
        limit: $limit
      ) {
        items {
          id chainId projectId timestamp txHash
          payEvent { amount beneficiary memo newlyIssuedTokenCount }
          cashOutTokensEvent { cashOutCount reclaimAmount beneficiary }
        }
      }
    }`,
    { suckerGroupId, limit },
    { revalidate: 15 },
  )
  return data.activityEvents.items
}

export type BsFreshActivityEvent = {
  id: string
  chainId: number
  projectId: number
  timestamp: number
  txHash: string
  from: string
  project: {
    name: string | null
    tokenSymbol: string | null
    decimals: number | null
  } | null
  payEvent: { amount: string; beneficiary: string } | null
  cashOutTokensEvent: {
    cashOutCount: string
    reclaimAmount: string
    beneficiary: string
  } | null
}

/**
 * The "Fresh activity" rail: latest pay/cash-out events across ALL V6
 * projects, in one query — the nested `project` field carries the name.
 */
export async function getRecentActivity(
  limit = 12,
): Promise<BsFreshActivityEvent[]> {
  const data = await bendystraw<{
    activityEvents: { items: BsFreshActivityEvent[] }
  }>(
    `query($limit: Int!) {
      activityEvents(
        where: { version: 6, type_in: [payEvent, cashOutTokensEvent] }
        orderBy: "timestamp"
        orderDirection: "desc"
        limit: $limit
      ) {
        items {
          id chainId projectId timestamp txHash from
          project { name tokenSymbol decimals }
          payEvent { amount beneficiary }
          cashOutTokensEvent { cashOutCount reclaimAmount beneficiary }
        }
      }
    }`,
    { limit },
    { revalidate: 15 },
  )
  return data.activityEvents.items
}

/**
 * A revnet's operator (website/ parity): the permissionHolders row flagged
 * isRevnetOperator, preferring one that still holds permissions. Null when
 * the indexer has nothing — callers hide the operator rather than fabricate.
 */
export async function getRevnetOperator(
  chainId: number,
  projectId: number,
): Promise<string | null> {
  try {
    const data = await bendystraw<{
      permissionHolders: {
        items: { operator: string; permissions: number[] }[]
      }
    }>(
      `query($chainId: Int!, $projectId: Int!) {
        permissionHolders(
          where: { chainId: $chainId, projectId: $projectId, version: 6, isRevnetOperator: true }
          limit: 10
        ) { items { operator permissions } }
      }`,
      { chainId, projectId },
      { revalidate: 60 },
    )
    const rows = data.permissionHolders?.items ?? []
    const live = rows.filter(r => r.permissions?.length > 0)
    const pick = live[0] ?? rows[0]
    return pick?.operator ?? null
  } catch {
    return null
  }
}

export async function getSuckerGroupProjects(
  suckerGroupId: string,
): Promise<BsProject[]> {
  const data = await bendystraw<{
    suckerGroup: { projects: { items: BsProject[] } } | null
  }>(
    `query($id: String!) {
      suckerGroup(id: $id) {
        projects(limit: 10) { items { ${PROJECT_FIELDS} } }
      }
    }`,
    { id: suckerGroupId },
    { revalidate: 60 },
  )
  return data.suckerGroup?.projects.items ?? []
}
