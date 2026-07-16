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

export async function getTrendingProjects(limit = 12): Promise<BsProject[]> {
  const data = await bendystraw<{ projects: { items: BsProject[] } }>(
    `query($limit: Int!) {
      projects(
        where: { version: 6 }
        orderBy: "volume"
        orderDirection: "desc"
        limit: $limit
      ) { items { ${PROJECT_FIELDS} } }
    }`,
    { limit },
    { revalidate: 120 },
  )
  return data.projects.items
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
