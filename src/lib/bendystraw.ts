/**
 * Minimal bendystraw client: plain fetch, no client library. Every query lives
 * here, typed by hand — auditable end to end. All queries are V6-only.
 */

const MAINNET_URL =
  process.env.NEXT_PUBLIC_BENDYSTRAW_URL ?? 'https://bendystraw.xyz/graphql'
const TESTNET_URL = 'https://testnet.bendystraw.xyz/graphql'
const REQUEST_TIMEOUT_MS = 8_000

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
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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
  volumeUsd: string
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
  projectId chainId version name logoUri projectTagline volume volumeUsd balance
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
    amountUsd: string | null
    beneficiary: string
    memo: string | null
    newlyIssuedTokenCount: string
  } | null
  cashOutTokensEvent: {
    cashOutCount: string
    reclaimAmount: string
    reclaimAmountUsd: string | null
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
          payEvent {
            amount amountUsd beneficiary memo newlyIssuedTokenCount
          }
          cashOutTokensEvent {
            cashOutCount reclaimAmount reclaimAmountUsd beneficiary
          }
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
    logoUri: string | null
    tokenSymbol: string | null
    decimals: number | null
  } | null
  payEvent: {
    amount: string
    amountUsd: string | null
    beneficiary: string
    newlyIssuedTokenCount: string
  } | null
  cashOutTokensEvent: {
    cashOutCount: string
    reclaimAmount: string
    reclaimAmountUsd: string | null
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
          project { name logoUri tokenSymbol decimals }
          payEvent { amount amountUsd beneficiary newlyIssuedTokenCount }
          cashOutTokensEvent {
            cashOutCount reclaimAmount reclaimAmountUsd beneficiary
          }
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

export type BsParticipant = {
  address: string
  balance: string
  chainId: number
  volumeUsd: string
}

/**
 * A project's token holders, largest balances first (website/ parity:
 * BENDYSTRAW_PARTICIPANTS queries). Queried by sucker group when one exists
 * so an omnichain holder's per-chain rows all come back — callers aggregate
 * by address — and by chain + project otherwise. Balances are 18-decimal
 * fixed-point strings.
 */
export async function getParticipants(
  args:
    | { suckerGroupId: string; chainId?: undefined; projectId?: undefined }
    | { suckerGroupId?: undefined; chainId: number; projectId: number },
  limit = 1000,
): Promise<{ items: BsParticipant[]; totalCount: number }> {
  const max = Math.max(1, Math.min(1000, limit))
  const pageSize = 250
  const items: BsParticipant[] = []
  let totalCount = 0
  let offset = 0

  while (items.length < max) {
    const pageLimit = Math.min(pageSize, max - items.length)
    const data = args.suckerGroupId
      ? await bendystraw<{
          participants: { items: BsParticipant[]; totalCount: number }
        }>(
          `query($suckerGroupId: String!, $limit: Int!, $offset: Int!) {
            participants(
              where: { suckerGroupId: $suckerGroupId, version: 6, balance_gt: "0" }
              orderBy: "balance"
              orderDirection: "desc"
              limit: $limit
              offset: $offset
            ) { items { address balance chainId volumeUsd } totalCount }
          }`,
          { suckerGroupId: args.suckerGroupId, limit: pageLimit, offset },
          { revalidate: 60 },
        )
      : await bendystraw<{
          participants: { items: BsParticipant[]; totalCount: number }
        }>(
          `query($chainId: Int!, $projectId: Int!, $limit: Int!, $offset: Int!) {
            participants(
              where: { chainId: $chainId, projectId: $projectId, version: 6, balance_gt: "0" }
              orderBy: "balance"
              orderDirection: "desc"
              limit: $limit
              offset: $offset
            ) { items { address balance chainId volumeUsd } totalCount }
          }`,
          {
            chainId: args.chainId,
            projectId: args.projectId,
            limit: pageLimit,
            offset,
          },
          { revalidate: 60 },
        )

    const page = data.participants.items ?? []
    totalCount = data.participants.totalCount ?? totalCount
    items.push(...page)
    if (page.length === 0 || items.length >= totalCount) break
    offset += page.length
  }

  return { items, totalCount: totalCount || items.length }
}

export type ShopProjectRef = {
  chainId: number
  projectId: number
}

export type BsShopPurchase = {
  chainId: number
  projectId: number
  timestamp: number
  txHash: string
  beneficiary: string
  tierId: number
  tokenId: string
  totalAmountPaid: string
  hook: string
}

export type BsOwnedShopItem = {
  chainId: number
  projectId: number
  createdAt: number
  mintTx: string
  hook: string
  tokenId: string
  owner: string
  tierId: number
}

type BsOwnedShopItemRow = Omit<BsOwnedShopItem, 'hook'> & {
  /** Bendystraw exposes the scalar hook address through this relation. */
  hook: { address: string } | null
}

export type BsShopRows<T> = {
  items: T[]
  totalCount: number
  /** At least one chain had more rows than the per-chain safety cap. */
  capped: boolean
  /** Chains whose indexer request failed. Successful chains remain usable. */
  failedChains: number[]
}

const SHOP_ROWS_PAGE_SIZE = 200
const SHOP_ROWS_MAX_PER_CHAIN = 1000

/**
 * Store-item purchases across linked deployments. Project IDs are paired to
 * their own chains: linked projects are not assumed to share an ID.
 */
export async function getShopPurchases(
  projects: ShopProjectRef[],
): Promise<BsShopRows<BsShopPurchase>> {
  const perChain = await Promise.all(
    projects.map(async project => {
      const items: BsShopPurchase[] = []
      let totalCount = 0
      let offset = 0
      let failed = false

      try {
        while (items.length < SHOP_ROWS_MAX_PER_CHAIN) {
          const limit = Math.min(
            SHOP_ROWS_PAGE_SIZE,
            SHOP_ROWS_MAX_PER_CHAIN - items.length,
          )
          const data = await bendystraw<{
            mintNftEvents: {
              items: BsShopPurchase[]
              totalCount: number
            }
          }>(
            `query($projectId: Int!, $chainId: Int!, $limit: Int!, $offset: Int!) {
              mintNftEvents(
                where: { projectId: $projectId, chainId: $chainId, version: 6 }
                orderBy: "timestamp"
                orderDirection: "desc"
                limit: $limit
                offset: $offset
              ) {
                totalCount
                items {
                  chainId projectId timestamp txHash beneficiary tierId tokenId
                  totalAmountPaid hook
                }
              }
            }`,
            { ...project, limit, offset },
            { revalidate: 15 },
          )
          const page = data.mintNftEvents?.items ?? []
          totalCount = data.mintNftEvents?.totalCount ?? totalCount
          items.push(
            ...page.flatMap(row => {
              // The query constrains this exact pair, but retain that identity
              // check at the trust boundary. Never reinterpret a missing or
              // mismatched row as the requested deployment.
              if (
                Number(row.chainId) !== project.chainId ||
                Number(row.projectId) !== project.projectId
              ) {
                return []
              }
              return [
                {
                  ...row,
                  chainId: project.chainId,
                  projectId: project.projectId,
                  timestamp: Number(row.timestamp),
                  tierId: Number(row.tierId),
                  tokenId: String(row.tokenId),
                  totalAmountPaid: String(row.totalAmountPaid),
                },
              ]
            }),
          )
          offset += page.length
          if (page.length === 0 || items.length >= totalCount) break
        }
      } catch {
        failed = true
      }

      return { project, items, totalCount, failed }
    }),
  )

  const items = perChain
    .flatMap(result => result.items)
    .sort((a, b) => b.timestamp - a.timestamp)
  return {
    items,
    totalCount: perChain.reduce((sum, result) => sum + result.totalCount, 0),
    capped: perChain.some(result => result.totalCount > result.items.length),
    failedChains: perChain
      .filter(result => result.failed)
      .map(result => result.project.chainId),
  }
}

/**
 * The connected account's currently indexed NFT holdings for this project's
 * linked deployments. The caller still verifies ownerOf onchain before a
 * redemption is offered or sent.
 */
export async function getOwnedShopItems(
  projects: ShopProjectRef[],
  owner: string,
): Promise<BsShopRows<BsOwnedShopItem>> {
  const normalizedOwner = owner.toLowerCase()
  const perChain = await Promise.all(
    projects.map(async project => {
      const items: BsOwnedShopItem[] = []
      let totalCount = 0
      let offset = 0
      let failed = false

      try {
        while (items.length < SHOP_ROWS_MAX_PER_CHAIN) {
          const limit = Math.min(
            SHOP_ROWS_PAGE_SIZE,
            SHOP_ROWS_MAX_PER_CHAIN - items.length,
          )
          const data = await bendystraw<{
            nfts: { items: BsOwnedShopItemRow[]; totalCount: number }
          }>(
            `query($projectId: Int!, $chainId: Int!, $owner: String!, $limit: Int!, $offset: Int!) {
              nfts(
                where: {
                  projectId: $projectId
                  chainId: $chainId
                  version: 6
                  owner: $owner
                }
                orderBy: "createdAt"
                orderDirection: "desc"
                limit: $limit
                offset: $offset
              ) {
                totalCount
                items {
                  chainId projectId createdAt mintTx tokenId owner tierId
                  hook { address }
                }
              }
            }`,
            { ...project, owner: normalizedOwner, limit, offset },
            { revalidate: 15 },
          )
          const page = data.nfts?.items ?? []
          totalCount = data.nfts?.totalCount ?? totalCount
          items.push(
            ...page.flatMap(row => {
              const hook = row.hook?.address
              if (
                !hook ||
                Number(row.chainId) !== project.chainId ||
                Number(row.projectId) !== project.projectId
              ) {
                return []
              }
              return [
                {
                  ...row,
                  chainId: project.chainId,
                  projectId: project.projectId,
                  createdAt: Number(row.createdAt),
                  hook,
                  tierId: Number(row.tierId),
                  tokenId: String(row.tokenId),
                  owner: String(row.owner).toLowerCase(),
                },
              ]
            }),
          )
          offset += page.length
          if (page.length === 0 || items.length >= totalCount) break
        }
      } catch {
        failed = true
      }

      return { project, items, totalCount, failed }
    }),
  )

  const items = perChain
    .flatMap(result => result.items)
    .sort((a, b) => b.createdAt - a.createdAt)
  return {
    items,
    totalCount: perChain.reduce((sum, result) => sum + result.totalCount, 0),
    capped: perChain.some(result => result.totalCount > result.items.length),
    failedChains: perChain
      .filter(result => result.failed)
      .map(result => result.project.chainId),
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

/**
 * Turn a sucker-group response into verified per-chain deployments for the
 * exact project route which loaded it. A linked project may have a different
 * project ID on every chain. Conflicting rows are therefore never repaired by
 * copying the home ID: the route chain fails closed to home-only, while an
 * ambiguous remote chain is omitted.
 */
export function resolveProjectDeployments(
  home: BsProject,
  members: readonly BsProject[],
): BsProject[] {
  const homeOnly = [home]
  if (!home.suckerGroupId) return homeOnly

  const isUsable = (member: BsProject) =>
    member.version === 6 &&
    Number.isSafeInteger(member.chainId) &&
    member.chainId > 0 &&
    Number.isSafeInteger(member.projectId) &&
    member.projectId > 0

  // A group which identifies another project on the route's own chain cannot
  // authorize any remote identity for this route.
  if (
    members.some(
      member =>
        isUsable(member) &&
        member.chainId === home.chainId &&
        member.projectId !== home.projectId,
    )
  ) {
    return homeOnly
  }

  const reportedIdByChain = new Map<number, number>()
  const conflictedChains = new Set<number>()
  for (const member of members) {
    if (!isUsable(member) || member.chainId === home.chainId) continue
    const reported = reportedIdByChain.get(member.chainId)
    if (reported !== undefined && reported !== member.projectId) {
      conflictedChains.add(member.chainId)
    } else if (reported === undefined) {
      reportedIdByChain.set(member.chainId, member.projectId)
    }
  }

  const byChain = new Map<number, BsProject>([[home.chainId, home]])

  for (const member of members) {
    if (
      !isUsable(member) ||
      member.suckerGroupId !== home.suckerGroupId ||
      conflictedChains.has(member.chainId)
    ) {
      continue
    }
    if (member.chainId === home.chainId) continue

    const existing = byChain.get(member.chainId)
    if (existing && existing.projectId !== member.projectId) continue
    if (!existing) byChain.set(member.chainId, member)
  }

  return [...byChain.values()].sort((a, b) => a.chainId - b.chainId)
}

export type BsPriceMoment = {
  timestamp: number
  balance: string
  tokenSupply: string
}

export type BsSwapEvent = {
  timestamp: number
  direction: string
  terminalTokenAmount: string
  projectTokenAmount: string
  poolId: string
  chainId: number
}

export type BsRevnetPriceHistory = {
  moments: BsPriceMoment[]
  swaps: BsSwapEvent[]
}

async function getPagedItems<T>(
  query: string,
  field: string,
  variables: Record<string, unknown>,
): Promise<T[]> {
  const limit = 1_000
  const max = 3_000
  const items: T[] = []

  while (items.length < max) {
    const data = await bendystraw<
      Record<string, { items: T[]; totalCount: number }>
    >(query, { ...variables, limit, offset: items.length }, { revalidate: 30 })
    const page = data[field]
    if (!page?.items.length) break
    items.push(...page.items)
    if (items.length >= page.totalCount || page.items.length < limit) break
  }

  return items.slice(0, max)
}

/**
 * Real indexed cash-out inputs and AMM swaps for a revnet. Consumers derive
 * prices using the project's own decimals/rulesets and filter swaps to the
 * currently resolved pool; no values are projected beyond the last event.
 */
export async function getRevnetPriceHistory(
  suckerGroupId: string,
): Promise<BsRevnetPriceHistory> {
  const [moments, swaps] = await Promise.all([
    getPagedItems<BsPriceMoment>(
      `query($suckerGroupId: String!, $limit: Int!, $offset: Int!) {
        suckerGroupMoments(
          where: { suckerGroupId: $suckerGroupId, version: 6 }
          orderBy: "timestamp"
          orderDirection: "asc"
          limit: $limit
          offset: $offset
        ) {
          items { timestamp balance tokenSupply }
          totalCount
        }
      }`,
      'suckerGroupMoments',
      { suckerGroupId },
    ),
    getPagedItems<BsSwapEvent>(
      `query($suckerGroupId: String!, $limit: Int!, $offset: Int!) {
        swapEvents(
          where: { suckerGroupId: $suckerGroupId, version: 6 }
          orderBy: "timestamp"
          orderDirection: "asc"
          limit: $limit
          offset: $offset
        ) {
          items {
            timestamp direction terminalTokenAmount projectTokenAmount
            poolId chainId
          }
          totalCount
        }
      }`,
      'swapEvents',
      { suckerGroupId },
    ),
  ])

  return { moments, swaps }
}

export type BsPermissionHolder = {
  /** Chain where this grant exists. */
  chainId: number
  /** The account that granted the permissions (usually the project owner). */
  account: string
  /** The operator holding the permissions. */
  operator: string
  /** JBPermissionIds the operator holds (see JBPermissionIdsV6). */
  permissions: number[]
  /** Bendystraw's marker for the active revnet operator grant. */
  isRevnetOperator: boolean
}

/**
 * Every operator holding live permissions for a project (same table
 * getRevnetOperator reads, without the revnet filter). Revoked rows
 * (empty permission sets) are dropped.
 */
export async function getPermissionHolders(
  chainId: number,
  projectId: number,
): Promise<BsPermissionHolder[]> {
  try {
    const data = await bendystraw<{
      permissionHolders: { items: BsPermissionHolder[] }
    }>(
      `query($chainId: Int!, $projectId: Int!) {
        permissionHolders(
          where: { chainId: $chainId, projectId: $projectId, version: 6 }
          limit: 100
        ) { items { chainId account operator permissions isRevnetOperator } }
      }`,
      { chainId, projectId },
      { revalidate: 60 },
    )
    return (data.permissionHolders?.items ?? []).filter(
      row => (row.permissions?.length ?? 0) > 0,
    )
  } catch {
    return []
  }
}

/**
 * Every live grant across an omnichain project, including deployments whose
 * local project id differs. Most sucker groups share an id, but imported or
 * migrated projects are not required to do so.
 */
export async function getPermissionHoldersAcrossDeployments(
  deployments: { chainId: number; projectId: number }[],
): Promise<BsPermissionHolder[]> {
  const unique = new Map(
    deployments.map(deployment => [
      `${deployment.chainId}:${deployment.projectId}`,
      deployment,
    ]),
  )
  const rows = await Promise.all(
    [...unique.values()].map(deployment =>
      getPermissionHolders(deployment.chainId, deployment.projectId),
    ),
  )
  return rows.flat()
}
