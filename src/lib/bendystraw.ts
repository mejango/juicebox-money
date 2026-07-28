/**
 * Minimal bendystraw client: plain fetch, no client library. Every query lives
 * here, typed by hand — auditable end to end. All queries are V6-only.
 */

import { JB_CHAINS, type JBChainId } from '@bananapus/nana-sdk-core'

const MAINNET_URL = process.env.BROWSER_BUILD_FIXTURE_ORIGIN
  ? `${process.env.BROWSER_BUILD_FIXTURE_ORIGIN}/graphql`
  : (process.env.NEXT_PUBLIC_BENDYSTRAW_URL ?? 'https://bendystraw.xyz/graphql')
const TESTNET_URL = 'https://testnet.bendystraw.xyz/graphql'
const REQUEST_TIMEOUT_MS = 8_000
const IS_DETERMINISTIC_BROWSER =
  process.env.NEXT_PUBLIC_DETERMINISTIC_BROWSER === 'true'

export const IS_TESTNET = process.env.NEXT_PUBLIC_TESTNET === 'true'

/**
 * Endpoint-routing hint for queries whose variables carry no chainId (e.g.
 * suckerGroup-keyed reads): mirrors the chainId-variable routing in
 * `bendystraw` below. Undefined (unknown chain or no hint) falls back to the
 * default endpoint selection.
 */
export function testnetHint(chainId?: number | null): boolean | undefined {
  return typeof chainId === 'number'
    ? JB_CHAINS[chainId as JBChainId]?.chain?.testnet
    : undefined
}

export async function bendystraw<T>(
  query: string,
  variables: Record<string, unknown>,
  opts: { revalidate?: number; testnet?: boolean } = {},
): Promise<T> {
  const variableChainId =
    typeof variables.chainId === 'number' ? variables.chainId : null
  const variableChain =
    variableChainId === null
      ? undefined
      : JB_CHAINS[variableChainId as JBChainId]?.chain
  const useTestnet =
    opts.testnet ?? variableChain?.testnet ?? IS_TESTNET
  const res = await fetch(useTestnet ? TESTNET_URL : MAINNET_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    ...(IS_DETERMINISTIC_BROWSER
      ? { cache: 'no-store' as const }
      : { next: { revalidate: opts.revalidate ?? 60 } }),
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

export type BsSearchProject = BsProject & {
  searchTicker: string | null
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
  limit = 24,
): Promise<BsSearchProject[]> {
  const searchText = text.trim().replace(/^\$/, '')
  const numericId = /^\d+$/.test(searchText) ? Number(searchText) : null
  const idFilter =
    numericId !== null && Number.isSafeInteger(numericId) && numericId > 0
      ? `{ projectId: ${numericId} }`
      : null
  const filters = [
    '{ name_contains_nocase: $text }',
    ...(idFilter ? [idFilter] : []),
  ].join('\n')
  const [projectData, tickerData] = await Promise.all([
    bendystraw<{ projects: { items: BsProject[] } }>(
      `query($text: String!, $limit: Int!) {
        projects(
          where: {
            version: 6
            OR: [
              ${filters}
            ]
          }
          orderBy: "volume"
          orderDirection: "desc"
          limit: $limit
        ) { items { ${PROJECT_FIELDS} } }
      }`,
      { text: searchText, limit },
      { revalidate: 30 },
    ),
    bendystraw<{
      deployErc20Events: {
        items: { chainId: number; projectId: number; symbol: string }[]
      }
    }>(
      `query($text: String!) {
        deployErc20Events(
          where: { symbol_contains_nocase: $text, version: 6 }
          limit: 100
        ) {
          items { chainId projectId symbol }
        }
      }`,
      { text: searchText },
      { revalidate: 30 },
    ),
  ])

  const tickerByDeployment = new Map<string, string>()
  for (const event of tickerData.deployErc20Events.items) {
    tickerByDeployment.set(
      `${event.chainId}:${event.projectId}`,
      event.symbol,
    )
  }
  // Bendystraw does not AND sibling fields inside one OR branch, so each
  // ticker deployment becomes an explicit AND group (see getProjectsByRefs).
  const tickerPairs = Array.from(tickerByDeployment.keys()).map(pair => {
    const [chainId, projectId] = pair.split(':').map(Number)
    return `{ AND: [{ chainId: ${chainId} }, { projectId: ${projectId} }, { version: 6 }] }`
  })
  const tickerProjects =
    tickerPairs.length > 0
      ? (
          await bendystraw<{ projects: { items: BsProject[] } }>(
            `query($limit: Int!) {
              projects(
                where: { OR: [${tickerPairs.join('\n')}] }
                orderBy: "volume"
                orderDirection: "desc"
                limit: $limit
              ) { items { ${PROJECT_FIELDS} } }
            }`,
            { limit },
            { revalidate: 30 },
          )
        ).projects.items
      : []

  const projects = new Map<string, BsProject>()
  for (const project of [...projectData.projects.items, ...tickerProjects]) {
    projects.set(`${project.chainId}:${project.projectId}`, project)
  }
  return Array.from(projects.values())
    .map(project => ({
      ...project,
      searchTicker:
        tickerByDeployment.get(
          `${project.chainId}:${project.projectId}`,
        ) ?? null,
    }))
    .slice(0, limit)
}

export type BsActivityEvent = {
  id: string
  chainId: number
  projectId: number
  timestamp: number
  from: string
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
  projectCreateEvent?: {
    from: string
  } | null
  addToBalanceEvent?: {
    amount: string
    from: string
    memo: string | null
  } | null
  mintTokensEvent?: {
    beneficiaryTokenCount: string
    beneficiary: string
    caller: string
    from: string
  } | null
  sendPayoutsEvent?: {
    amount: string
    amountPaidOut: string
    amountPaidOutUsd: string | null
    caller: string
    from: string
  } | null
  sendPayoutToSplitEvent?: {
    amount: string
    amountUsd: string | null
    beneficiary: string
    splitProjectId: number
    from: string
  } | null
  sendReservedTokensToSplitEvent?: {
    tokenCount: string
    beneficiary: string
    splitProjectId: number
    from: string
  } | null
  sendReservedTokensToSplitsEvent?: {
    tokenCount: string
    from: string
  } | null
  autoIssueEvent?: {
    beneficiary: string
    count: string
    stageId: string
    from: string
  } | null
  borrowLoanEvent?: {
    borrowAmount: string
    collateral: string
    beneficiary: string
    token: string
    from: string
  } | null
  repayLoanEvent?: {
    repayBorrowAmount: string
    collateralCountToReturn: string
    from: string
  } | null
  liquidateLoanEvent?: {
    borrowAmount: string
    collateral: string
    from: string
  } | null
  mintNftEvent?: {
    tierId: string
    tokenId: string
    beneficiary: string
    totalAmountPaid: string
    from: string
  } | null
  deployErc20Event?: {
    symbol: string
    name: string
    token: string
    from: string
  } | null
  setUriEvent?: {
    uri: string
    caller: string
    from: string
  } | null
  projectTransferEvent?: {
    previousOwner: string
    owner: string
    from: string
  } | null
  operatorPermissionsSetEvent?: {
    account: string
    operator: string
    isRevnetOperator: boolean | null
    caller: string
    from: string
  } | null
  addNftTierEvent?: {
    tierId: string
    price: string
    category: string
    caller: string
    from: string
  } | null
  removeNftTierEvent?: {
    tierId: string
    caller: string
    from: string
  } | null
  swapEvent?: {
    direction: boolean
    terminalTokenAmount: string
    projectTokenAmount: string
    caller: string
    from: string
  } | null
  buybackPoolEvent?: {
    terminalToken: string
    poolId: string
    caller: string
    from: string
  } | null
  bridgeClaimEvent?: {
    peerChainId: number
    token: string
    beneficiary: string
    projectTokenCount: string
    terminalTokenAmount: string
    caller: string
    from: string
  } | null
}

const ACTIVITY_EVENT_FIELDS = `
  id chainId projectId timestamp from txHash
  payEvent {
    amount amountUsd beneficiary memo newlyIssuedTokenCount
  }
  cashOutTokensEvent {
    cashOutCount reclaimAmount reclaimAmountUsd beneficiary
  }
  projectCreateEvent { from }
  addToBalanceEvent { amount memo from }
  mintTokensEvent {
    beneficiary beneficiaryTokenCount caller from
  }
  sendPayoutsEvent {
    amount amountPaidOut amountPaidOutUsd caller from
  }
  sendReservedTokensToSplitsEvent { tokenCount from }
  sendPayoutToSplitEvent {
    amount amountUsd beneficiary splitProjectId from
  }
  sendReservedTokensToSplitEvent {
    tokenCount beneficiary splitProjectId from
  }
  autoIssueEvent { beneficiary count stageId from }
  borrowLoanEvent {
    borrowAmount collateral beneficiary token from
  }
  repayLoanEvent {
    repayBorrowAmount collateralCountToReturn from
  }
  liquidateLoanEvent { borrowAmount collateral from }
  mintNftEvent {
    tierId tokenId beneficiary totalAmountPaid from
  }
  deployErc20Event { symbol name token from }
  setUriEvent { uri caller from }
  projectTransferEvent { previousOwner owner from }
  operatorPermissionsSetEvent {
    account operator isRevnetOperator caller from
  }
  addNftTierEvent { tierId price category caller from }
  removeNftTierEvent { tierId caller from }
  swapEvent {
    direction terminalTokenAmount projectTokenAmount caller from
  }
  buybackPoolEvent { terminalToken poolId caller from }
  bridgeClaimEvent {
    peerChainId token beneficiary projectTokenCount
    terminalTokenAmount caller from
  }
`

export async function getProjectActivity(
  suckerGroupId: string,
  limit = 20,
  chainId?: number,
): Promise<BsActivityEvent[]> {
  const data = await bendystraw<{
    activityEvents: { items: BsActivityEvent[] }
  }>(
    `query($suckerGroupId: String!, $limit: Int!) {
      activityEvents(
        where: {
          suckerGroupId: $suckerGroupId
          version: 6
          OR: [
            { payEvent_not: null }
            { cashOutTokensEvent_not: null }
            { sendPayoutsEvent_not: null }
            { sendReservedTokensToSplitsEvent_not: null }
            { autoIssueEvent_not: null }
            { mintTokensEvent_not: null }
            { borrowLoanEvent_not: null }
            { repayLoanEvent_not: null }
            { liquidateLoanEvent_not: null }
            { mintNftEvent_not: null }
            { deployErc20Event_not: null }
            { projectCreateEvent_not: null }
            { addToBalanceEvent_not: null }
            { setUriEvent_not: null }
            { projectTransferEvent_not: null }
            { operatorPermissionsSetEvent_not: null }
            { addNftTierEvent_not: null }
            { removeNftTierEvent_not: null }
            { swapEvent_not: null }
            { buybackPoolEvent_not: null }
            { bridgeClaimEvent_not: null }
          ]
        }
        orderBy: "timestamp"
        orderDirection: "desc"
        limit: $limit
      ) {
        items { ${ACTIVITY_EVENT_FIELDS} }
      }
    }`,
    { suckerGroupId, limit },
    {
      revalidate: 15,
      testnet:
        chainId === undefined
          ? undefined
          : JB_CHAINS[chainId as JBChainId]?.chain.testnet,
    },
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
 *
 * On the suckerGroup branch `chainId` is only an endpoint-routing hint
 * (testnet groups live on the testnet indexer); it never filters the group.
 */
export async function getParticipants(
  args:
    | { suckerGroupId: string; chainId?: number; projectId?: undefined }
    | { suckerGroupId?: undefined; chainId: number; projectId: number },
  limit = 1000,
): Promise<{ items: BsParticipant[]; totalCount: number }> {
  const max = Math.max(1, Math.min(1000, limit))
  const pageSize = 250
  const items: BsParticipant[] = []
  let totalCount = 0
  let offset = 0

  const [params, where, scope] = args.suckerGroupId
    ? [
        '$suckerGroupId: String!',
        'suckerGroupId: $suckerGroupId',
        { suckerGroupId: args.suckerGroupId },
      ]
    : [
        '$chainId: Int!, $projectId: Int!',
        'chainId: $chainId, projectId: $projectId',
        { chainId: args.chainId, projectId: args.projectId },
      ]
  const query = `query(${params}, $limit: Int!, $offset: Int!) {
    participants(
      where: { ${where}, version: 6, balance_gt: "0" }
      orderBy: "balance"
      orderDirection: "desc"
      limit: $limit
      offset: $offset
    ) { items { address balance chainId volumeUsd } totalCount }
  }`

  while (items.length < max) {
    const pageLimit = Math.min(pageSize, max - items.length)
    const data = await bendystraw<{
      participants: { items: BsParticipant[]; totalCount: number }
    }>(
      query,
      { ...scope, limit: pageLimit, offset },
      { revalidate: 60, testnet: testnetHint(args.chainId) },
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
 * The shared per-chain scaffold for shop-row queries: paginate each
 * deployment up to the per-chain cap, flag failed chains without losing the
 * successful ones, then merge and sort newest-first by `sortKey`.
 */
async function fetchShopRowsPerChain<Row, Item>(
  projects: ShopProjectRef[],
  fetchPage: (
    project: ShopProjectRef,
    limit: number,
    offset: number,
  ) => Promise<{ items: Row[]; totalCount: number } | undefined>,
  mapRow: (row: Row, project: ShopProjectRef) => Item[],
  sortKey: (item: Item) => number,
): Promise<BsShopRows<Item>> {
  const perChain = await Promise.all(
    projects.map(async project => {
      const items: Item[] = []
      let totalCount = 0
      let offset = 0
      let failed = false

      try {
        while (items.length < SHOP_ROWS_MAX_PER_CHAIN) {
          const limit = Math.min(
            SHOP_ROWS_PAGE_SIZE,
            SHOP_ROWS_MAX_PER_CHAIN - items.length,
          )
          const data = await fetchPage(project, limit, offset)
          const page = data?.items ?? []
          totalCount = data?.totalCount ?? totalCount
          items.push(...page.flatMap(row => mapRow(row, project)))
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
    .sort((a, b) => sortKey(b) - sortKey(a))
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
 * Store-item purchases across linked deployments. Project IDs are paired to
 * their own chains: linked projects are not assumed to share an ID.
 */
export async function getShopPurchases(
  projects: ShopProjectRef[],
): Promise<BsShopRows<BsShopPurchase>> {
  return fetchShopRowsPerChain<BsShopPurchase, BsShopPurchase>(
    projects,
    async (project, limit, offset) => {
      const data = await bendystraw<{
        mintNftEvents: { items: BsShopPurchase[]; totalCount: number }
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
      return data.mintNftEvents
    },
    (row, project) => {
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
    },
    item => item.timestamp,
  )
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
  return fetchShopRowsPerChain<BsOwnedShopItemRow, BsOwnedShopItem>(
    projects,
    async (project, limit, offset) => {
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
      return data.nfts
    },
    (row, project) => {
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
    },
    item => item.createdAt,
  )
}

export async function getSuckerGroupProjects(
  suckerGroupId: string,
  chainId?: number,
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
    {
      revalidate: 60,
      testnet:
        chainId === undefined
          ? undefined
          : JB_CHAINS[chainId as JBChainId]?.chain.testnet,
    },
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

/**
 * The single accounting-token kind a verified deployment set agrees on, or
 * null when the chains account in different tokens (or the kind is unknown).
 * Kind means symbol + decimals: canonical stablecoin deployments differ by
 * address per chain but denominate amounts identically, so addresses do not
 * disqualify a group.
 */
export function suckerGroupAccountingToken(
  deployments: readonly BsProject[],
): { symbol: string; decimals: number } | null {
  const [first] = deployments
  if (!first?.tokenSymbol || first.decimals == null) return null
  return deployments.every(
    row =>
      row.tokenSymbol === first.tokenSymbol &&
      row.decimals === first.decimals,
  )
    ? { symbol: first.tokenSymbol, decimals: first.decimals }
    : null
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
  sqrtPriceX96: string | null
  projectTokenIsCurrency0: boolean | null
}

export type BsBuybackPoolEvent = {
  timestamp: number
  poolId: string
  chainId: number
  initialSqrtPriceX96: string | null
  projectTokenIsCurrency0: boolean | null
}

export type BsRevnetPriceHistory = {
  moments: BsPriceMoment[]
  swaps: BsSwapEvent[]
  pools: BsBuybackPoolEvent[]
}

/**
 * Paginate one `{ items, totalCount }` bendystraw list to completion, up to
 * `max` rows in `pageSize` pages. The query must accept `$limit`/`$offset`
 * and expose the list under `field`.
 */
export async function getPagedItems<T>(
  query: string,
  field: string,
  variables: Record<string, unknown>,
  {
    pageSize = 1_000,
    max = 3_000,
    testnet,
  }: { pageSize?: number; max?: number; testnet?: boolean } = {},
): Promise<{ items: T[]; totalCount: number }> {
  const items: T[] = []
  let totalCount = 0

  while (items.length < max) {
    const pageLimit = Math.min(pageSize, max - items.length)
    const data = await bendystraw<
      Record<string, { items: T[]; totalCount: number }>
    >(
      query,
      { ...variables, limit: pageLimit, offset: items.length },
      { revalidate: 30, testnet },
    )
    const page = data[field]?.items ?? []
    totalCount = data[field]?.totalCount ?? totalCount
    items.push(...page)
    if (page.length === 0 || items.length >= totalCount || page.length < pageLimit) {
      break
    }
  }

  return { items, totalCount: totalCount || items.length }
}

/**
 * Real indexed cash-out inputs, pool registration prices, and exact post-swap
 * spots for a revnet. Consumers apply the project's decimals and filter to the
 * currently resolved pool; no values are projected beyond the last event.
 */
export async function getRevnetPriceHistory(
  suckerGroupId: string,
  /** `chainId` is an endpoint-routing hint only (testnet groups live on the
   *  testnet indexer); it never filters the group. */
  { chainId }: { chainId?: number } = {},
): Promise<BsRevnetPriceHistory> {
  const testnet = testnetHint(chainId)
  const momentsPromise = getPagedItems<BsPriceMoment>(
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
    { testnet },
  ).then(page => page.items)

  const enhancedSwaps = () => getPagedItems<BsSwapEvent>(
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
          poolId chainId sqrtPriceX96 projectTokenIsCurrency0
        }
        totalCount
      }
    }`,
    'swapEvents',
    { suckerGroupId },
    { testnet },
  ).then(page => page.items)

  const pools = () => getPagedItems<BsBuybackPoolEvent>(
    `query($suckerGroupId: String!, $limit: Int!, $offset: Int!) {
      buybackPoolEvents(
        where: { suckerGroupId: $suckerGroupId, version: 6 }
        orderBy: "timestamp"
        orderDirection: "asc"
        limit: $limit
        offset: $offset
      ) {
        items {
          timestamp poolId chainId initialSqrtPriceX96
          projectTokenIsCurrency0
        }
        totalCount
      }
    }`,
    'buybackPoolEvents',
    { suckerGroupId },
    { testnet },
  ).then(page => page.items)

  const marketPromise = Promise.all([enhancedSwaps(), pools()])
    .then(([swaps, poolEvents]) => ({ swaps, pools: poolEvents }))
    .catch(async () => {
      // Preserve the existing average-price series if a frontend deployment
      // reaches production before Bendystraw's additive schema fields.
      const swaps = await getPagedItems<BsSwapEvent>(
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
        { testnet },
      ).then(page => page.items)
      return { swaps, pools: [] }
    })

  const [moments, market] = await Promise.all([momentsPromise, marketPromise])
  return { moments, ...market }
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
export type BsAccountActivityEvent = BsActivityEvent & {
  /** Protocol version the event was indexed under (4, 5, or 6). */
  version: number
  project: {
    name: string | null
    logoUri: string | null
    tokenSymbol: string | null
    decimals: number | null
  } | null
}

/**
 * activityEvents can only be filtered by `from` (the transaction sender):
 * beneficiary lives on the per-type event tables. Events where the account is
 * only the beneficiary — payments to them, mints, split receipts — are read
 * from those tables directly and re-wrapped into activity-shaped rows. Each
 * source lists the fields its activity sub-object carries.
 */
const BENEFICIARY_EVENT_SOURCES = [
  {
    list: 'payEvents',
    field: 'payEvent',
    selection: 'amount amountUsd beneficiary memo newlyIssuedTokenCount',
  },
  {
    list: 'cashOutTokensEvents',
    field: 'cashOutTokensEvent',
    selection: 'cashOutCount reclaimAmount reclaimAmountUsd beneficiary',
  },
  {
    list: 'mintTokensEvents',
    field: 'mintTokensEvent',
    selection: 'beneficiary beneficiaryTokenCount caller',
  },
  {
    list: 'autoIssueEvents',
    field: 'autoIssueEvent',
    selection: 'beneficiary count stageId',
  },
  {
    list: 'borrowLoanEvents',
    field: 'borrowLoanEvent',
    selection: 'borrowAmount collateral beneficiary token',
  },
  {
    list: 'mintNftEvents',
    field: 'mintNftEvent',
    selection: 'tierId tokenId beneficiary totalAmountPaid',
  },
  {
    list: 'bridgeClaimEvents',
    field: 'bridgeClaimEvent',
    selection:
      'peerChainId token beneficiary projectTokenCount terminalTokenAmount caller',
  },
  {
    list: 'sendPayoutToSplitEvents',
    field: 'sendPayoutToSplitEvent',
    selection: 'amount amountUsd beneficiary splitProjectId',
  },
  {
    list: 'sendReservedTokensToSplitEvents',
    field: 'sendReservedTokensToSplitEvent',
    selection: 'tokenCount beneficiary splitProjectId',
  },
] as const

/** Bendystraw rejects limits above 1000, so the merged beneficiary-union
 *  window cannot grow past this — offset pagination dead-ends here. The
 *  account view hides its load-more affordance at this cap. */
export const ACCOUNT_ACTIVITY_WINDOW_MAX = 1000

type BsBeneficiaryEventRow = {
  id: string
  chainId: number
  projectId: number
  timestamp: number
  txHash: string
  from: string
  version: number
  project: BsAccountActivityEvent['project']
} & Record<string, unknown>

/**
 * Everything an account did across V6 projects and chains, newest first.
 * One page per call — the account view's load-more grows the offset instead
 * of paginating to exhaustion.
 *
 * Two branches merge into a page: activityEvents the account sent, plus
 * beneficiary-side rows from the per-type event tables (which exclude
 * self-sent rows at the source, so the branches are disjoint). Every branch
 * is read from the head down to offset + limit and the merged, deduped
 * window is sliced — offset pagination spans the union exactly.
 */
export async function getAccountActivity(
  address: string,
  { limit = 25, offset = 0 }: { limit?: number; offset?: number } = {},
): Promise<{ items: BsAccountActivityEvent[]; totalCount: number }> {
  const windowLimit = Math.min(offset + limit, ACCOUNT_ACTIVITY_WINDOW_MAX)
  const beneficiaryQueries = BENEFICIARY_EVENT_SOURCES.map(
    source => `${source.list}(
        where: { AND: [{ beneficiary: $address }, { from_not: $address }, { version: 6 }] }
        orderBy: "timestamp"
        orderDirection: "desc"
        limit: $limit
      ) {
        totalCount
        items {
          id chainId projectId timestamp txHash from version
          project { name logoUri tokenSymbol decimals }
          ${source.selection}
        }
      }`,
  ).join('\n')
  const data = await bendystraw<
    {
      activityEvents: { items: BsAccountActivityEvent[]; totalCount: number }
    } & Record<
      string,
      { items: BsBeneficiaryEventRow[]; totalCount: number }
    >
  >(
    `query($address: String!, $limit: Int!) {
      activityEvents(
        where: { from: $address, version: 6 }
        orderBy: "timestamp"
        orderDirection: "desc"
        limit: $limit
      ) {
        totalCount
        items {
          version
          project { name logoUri tokenSymbol decimals }
          ${ACTIVITY_EVENT_FIELDS}
        }
      }
      ${beneficiaryQueries}
    }`,
    { address: address.toLowerCase(), limit: windowLimit },
    { revalidate: 15 },
  )

  let totalCount = data.activityEvents.totalCount
  const merged: BsAccountActivityEvent[] = [...data.activityEvents.items]
  for (const source of BENEFICIARY_EVENT_SOURCES) {
    const page = data[source.list]
    if (!page) continue
    totalCount += page.totalCount
    for (const row of page.items) {
      const {
        id,
        chainId,
        projectId,
        timestamp,
        txHash,
        from,
        version,
        project,
        ...eventFields
      } = row
      merged.push({
        id,
        chainId,
        projectId,
        timestamp,
        txHash,
        from,
        version,
        project,
        [source.field]: { ...eventFields, from },
      } as unknown as BsAccountActivityEvent)
    }
  }

  merged.sort(
    (a, b) => b.timestamp - a.timestamp || (a.id < b.id ? -1 : 1),
  )
  const seen = new Set<string>()
  const deduped = merged.filter(event => {
    if (seen.has(event.id)) return false
    seen.add(event.id)
    return true
  })
  return { items: deduped.slice(offset, offset + limit), totalCount }
}

/**
 * Every V6 project owned by any of the given addresses (an account plus the
 * Safes it signs for).
 */
export async function getProjectsOwnedBy(
  owners: string[],
): Promise<BsProject[]> {
  if (!owners.length) return []
  const page = await getPagedItems<BsProject>(
    `query($owners: [String!]!, $limit: Int!, $offset: Int!) {
      projects(
        where: { owner_in: $owners, version: 6 }
        orderBy: "volume"
        orderDirection: "desc"
        limit: $limit
        offset: $offset
      ) { items { ${PROJECT_FIELDS} } totalCount }
    }`,
    'projects',
    { owners: owners.map(owner => owner.toLowerCase()) },
    { pageSize: 200, max: 400 },
  )
  return page.items
}

export type BsOperatorGrant = {
  chainId: number
  projectId: number
  /** JBPermissionIds the operator holds. */
  permissions: number[]
  /** The account that granted the permissions. */
  account: string
  operator: string
  isRevnetOperator: boolean | null
  /** Protocol version of the granting project. */
  version: number
}

/** Every live permission grant held BY an operator, across all V6 projects. */
export async function getOperatorGrants(
  operator: string,
): Promise<BsOperatorGrant[]> {
  const page = await getPagedItems<BsOperatorGrant>(
    `query($operator: String!, $limit: Int!, $offset: Int!) {
      permissionHolders(
        where: { operator: $operator, version: 6 }
        limit: $limit
        offset: $offset
      ) {
        items {
          chainId projectId permissions account operator isRevnetOperator
          version
        }
        totalCount
      }
    }`,
    'permissionHolders',
    { operator: operator.toLowerCase() },
    { pageSize: 200, max: 400 },
  )
  return page.items.filter(row => (row.permissions?.length ?? 0) > 0)
}

/**
 * Display metadata for exact (chainId, projectId, version) deployments —
 * the operated-projects section resolves grant rows to names this way.
 * Refs are number-validated before being inlined into the filter.
 */
export async function getProjectsByRefs(
  refs: { chainId: number; projectId: number; version: number }[],
): Promise<BsProject[]> {
  const pairs = [
    ...new Set(
      refs
        .filter(
          ref =>
            Number.isSafeInteger(ref.chainId) &&
            ref.chainId > 0 &&
            Number.isSafeInteger(ref.projectId) &&
            ref.projectId > 0 &&
            Number.isSafeInteger(ref.version) &&
            ref.version > 0,
        )
        // Bendystraw does not AND sibling fields inside one OR branch, so
        // each ref becomes an explicit AND group.
        .map(
          ref =>
            `{ AND: [{ chainId: ${ref.chainId} }, { projectId: ${ref.projectId} }, { version: ${ref.version} }] }`,
        ),
    ),
    // Beyond this slice the filter string gets unwieldy; overflow refs
    // degrade gracefully to "Project N" rows without indexed display
    // metadata rather than failing the whole lookup.
  ].slice(0, 200)
  if (!pairs.length) return []
  const data = await bendystraw<{ projects: { items: BsProject[] } }>(
    `query($limit: Int!) {
      projects(
        where: { OR: [${pairs.join('\n')}] }
        limit: $limit
      ) { items { ${PROJECT_FIELDS} } }
    }`,
    { limit: pairs.length },
    { revalidate: 60 },
  )
  return data.projects.items
}

export type BsAccountTokenHolding = {
  chainId: number
  projectId: number
  /** 18-decimal fixed-point token balance (credits + claimed ERC-20). */
  balance: string
  /** The unclaimed-credit share of `balance`. */
  creditBalance: string
  /** The claimed ERC-20 share of `balance`. */
  erc20Balance: string
}

/**
 * Positive V6 project-token balances held by an account, across chains,
 * largest first. `totalCount` is the indexer's full count — when it exceeds
 * `items.length` the fetch hit its cap and callers should say so.
 */
export async function getAccountTokenHoldings(
  account: string,
): Promise<{ items: BsAccountTokenHolding[]; totalCount: number }> {
  return getPagedItems<BsAccountTokenHolding>(
    `query($address: String!, $limit: Int!, $offset: Int!) {
      participants(
        where: { address: $address, balance_gt: "0", version: 6 }
        orderBy: "balance"
        orderDirection: "desc"
        limit: $limit
        offset: $offset
      ) {
        items { chainId projectId balance creditBalance erc20Balance }
        totalCount
      }
    }`,
    'participants',
    { address: account.toLowerCase() },
    { pageSize: 200, max: 400 },
  )
}

export type BsAccountNft = {
  chainId: number
  projectId: number
  tokenId: string
  tierId: number
  createdAt: number
  hook: { address: string } | null
  /** Indexed tier display metadata; either field may be missing. */
  tier: {
    resolvedUri: string | null
    metadata: Record<string, unknown> | null
  } | null
}

/**
 * Every indexed V6 721 shop item an account currently owns, across chains,
 * newest first. `totalCount` is the indexer's full count — when it exceeds
 * `items.length` the fetch hit its cap and callers should say so.
 */
export async function getAccountNfts(
  account: string,
): Promise<{ items: BsAccountNft[]; totalCount: number }> {
  const page = await getPagedItems<BsAccountNft>(
    `query($owner: String!, $limit: Int!, $offset: Int!) {
      nfts(
        where: { owner: $owner, version: 6 }
        orderBy: "createdAt"
        orderDirection: "desc"
        limit: $limit
        offset: $offset
      ) {
        items {
          chainId projectId tokenId tierId createdAt
          hook { address }
          tier { resolvedUri metadata }
        }
        totalCount
      }
    }`,
    'nfts',
    { owner: account.toLowerCase() },
    { pageSize: 200, max: 600 },
  )
  return {
    items: page.items.map(row => ({
      ...row,
      tokenId: String(row.tokenId),
      tierId: Number(row.tierId),
      createdAt: Number(row.createdAt),
    })),
    totalCount: page.totalCount,
  }
}

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
