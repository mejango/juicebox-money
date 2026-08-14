/**
 * Minimal bendystraw client: plain fetch, no client library. Every query lives
 * here, typed by hand — auditable end to end. All queries are V6-only.
 */

import {
  RevnetCoreContracts,
  bendystrawCacheTtl,
  bendystrawProjectRefFilter as projectRefAnd,
  bendystrawProjectRefsFilters as projectRefsWheres,
  downsampleTimeSeries,
  matchesBendystrawProjectRef as matchesProjectRef,
  normalizeBendystrawEndpoint,
  requestBendystraw,
  resolveBendystrawNetwork,
  selectBendystrawEndpoint,
  jbContractAddress,
  type BendystrawCachePolicy,
  type BendystrawFilter,
  type BendystrawNetwork,
  type BendystrawProjectRef,
} from '@bananapus/nana-sdk-core'
import { compileBendystrawOperation } from '@/lib/bendystraw-operation'

type VersionedProjectRef = Required<BendystrawProjectRef>

export function normalizeBendystrawUrl(value: string): string {
  return normalizeBendystrawEndpoint(value.trim())
}

const MAINNET_URL = process.env.BROWSER_BUILD_FIXTURE_ORIGIN
  ? `${process.env.BROWSER_BUILD_FIXTURE_ORIGIN}/graphql`
  : normalizeBendystrawUrl(
      process.env.NEXT_PUBLIC_BENDYSTRAW_URL ??
        'https://bendystraw.up.railway.app',
    )
const TESTNET_URL = process.env.BROWSER_BUILD_FIXTURE_ORIGIN
  ? `${process.env.BROWSER_BUILD_FIXTURE_ORIGIN}/graphql`
  : normalizeBendystrawUrl(
      process.env.NEXT_PUBLIC_TESTNET_BENDYSTRAW_URL ??
        'https://testnet.bendystraw.xyz',
    )
const IS_DETERMINISTIC_BROWSER =
  process.env.NEXT_PUBLIC_DETERMINISTIC_BROWSER === 'true'

/**
 * Endpoint-routing hint for queries whose variables carry no chainId (e.g.
 * suckerGroup-keyed reads): mirrors the chainId-variable routing in
 * `bendystraw` below. Undefined (unknown chain or no hint) falls back to the
 * default endpoint selection.
 */
export function bendystrawNetworkHint(
  chainId?: number | null,
): BendystrawNetwork | undefined {
  return typeof chainId === 'number'
    ? resolveBendystrawNetwork({ chainId })
    : undefined
}

export async function bendystraw<T>(
  query: string,
  variables: Record<string, unknown>,
  opts: {
    chainId?: number
    network?: BendystrawNetwork
    policy?: BendystrawCachePolicy
  } = {},
): Promise<T> {
  const contract = compileBendystrawOperation(query)
  const network = resolveBendystrawNetwork({
    chainId: opts.chainId,
    defaultNetwork: 'mainnet',
    network: opts.network,
    variables,
  })
  if (typeof window !== 'undefined') {
    const { requestPersistedBendystraw } = await import(
      '@/lib/bendystraw-browser'
    )
    return requestPersistedBendystraw<T>({
      contract,
      network,
      query,
      variables,
    })
  }
  const cacheOptions = IS_DETERMINISTIC_BROWSER
    ? { cache: 'no-store' as const }
    : {
        next: {
          revalidate: bendystrawCacheTtl(opts.policy ?? 'stable') / 1_000,
        },
      }
  return requestBendystraw<T, Record<string, unknown>>(
    selectBendystrawEndpoint(
      { mainnet: MAINNET_URL, testnet: TESTNET_URL },
      {
        chainId: opts.chainId,
        network,
        variables,
      },
    ),
    query,
    variables,
    {
      fetch: (input, init) => fetch(input, { ...init, ...cacheOptions }),
      operationName: contract.operationName,
      validateData: (value): value is T => contract.validateData(value),
      validateVariables: contract.validateVariables,
    },
  )
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

const PROJECTS_BY_FILTER_QUERY = `query ProjectsByFilter($where: projectFilter!, $limit: Int!) {
  projects(
    where: $where
    orderBy: "volume"
    orderDirection: "desc"
    limit: $limit
  ) { items { ${PROJECT_FIELDS} } }
}`

const PARTICIPANTS_BY_FILTER_QUERY = `query ParticipantsByFilter(
  $where: participantFilter!
  $limit: Int!
  $offset: Int!
) {
  participants(
    where: $where
    orderBy: "balance"
    orderDirection: "desc"
    limit: $limit
    offset: $offset
  ) { items { address balance chainId volumeUsd suckerGroupId } totalCount }
}`

export async function getProject(
  chainId: number,
  projectId: number,
): Promise<BsProject | null> {
  const data = await bendystraw<{ project: BsProject | null }>(
    `query($chainId: Float!, $projectId: Float!) {
      project(chainId: $chainId, projectId: $projectId, version: 6) { ${PROJECT_FIELDS} }
    }`,
    { chainId, projectId },
    { policy: 'standard' },
  )
  return data.project
}

export async function searchProjects(
  text: string,
  limit = 24,
): Promise<BsSearchProject[]> {
  const searchText = text.trim().replace(/^\$/, '')
  const numericId = /^\d+$/.test(searchText) ? Number(searchText) : null
  const idFilter: BendystrawFilter | null =
    numericId !== null && Number.isSafeInteger(numericId) && numericId > 0
      ? { projectId: numericId }
      : null
  const searchBranches: BendystrawFilter[] = [
    { name_contains_nocase: searchText },
    ...(idFilter ? [idFilter] : []),
  ]
  const [projectData, tickerData] = await Promise.all([
    bendystraw<{ projects: { items: BsProject[] } }>(
      PROJECTS_BY_FILTER_QUERY,
      { where: { AND: [{ version: 6 }, { OR: searchBranches }] }, limit },
      { policy: 'standard' },
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
      { policy: 'standard' },
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
  const tickerRefs = Array.from(tickerByDeployment.keys()).map(pair => {
    const [chainId, projectId] = pair.split(':').map(Number)
    return { chainId, projectId, version: 6 }
  })
  const tickerWheres = projectRefsWheres(tickerRefs)
  const tickerProjects =
    tickerWheres.length > 0
      ? (
          await Promise.all(
            tickerWheres.map(where =>
              bendystraw<{ projects: { items: BsProject[] } }>(
                PROJECTS_BY_FILTER_QUERY,
                { where, limit },
                { policy: 'standard' },
              ),
            ),
          )
        ).flatMap(page =>
          page.projects.items.filter(project =>
            matchesProjectRef(
              {
                chainId: project.chainId,
                projectId: project.projectId,
                version: project.version,
              },
              tickerRefs,
            ),
          ),
        )
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
  rulesetQueuedEvent?: {
    cycleNumber: number
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
    direction: string
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
  rulesetQueuedEvent { cycleNumber caller from }
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

/** Returns `totalCount` alongside the page: the feed is capped, and the caller offers
 *  "Load more" only if it can tell how much it is holding back. Category filters apply to
 *  what has been LOADED, so a discarded total let a populated category render as empty. */
export async function getProjectActivity(
  suckerGroupId: string,
  limit = 20,
  chainId?: number,
  offset = 0,
): Promise<{ items: BsActivityEvent[]; totalCount: number }> {
  const page = await getPagedItems<BsActivityEvent>(
    `query($suckerGroupId: String!, $limit: Int!, $offset: Int!) {
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
        offset: $offset
      ) {
        items { ${ACTIVITY_EVENT_FIELDS} }
        totalCount
      }
    }`,
    'activityEvents',
    { suckerGroupId },
    {
      network: bendystrawNetworkHint(chainId),
      pageSize: limit,
      max: limit,
      startOffset: offset,
      policy: 'live',
    },
  )
  return page
}

export async function getProjectActivityByProject(
  chainId: number,
  projectId: number,
  limit = 20,
  offset = 0,
): Promise<{ items: BsActivityEvent[]; totalCount: number }> {
  const page = await getPagedItems<BsActivityEvent>(
    `query($chainId: Int!, $projectId: Int!, $limit: Int!, $offset: Int!) {
      activityEvents(
        where: {
          chainId: $chainId
          projectId: $projectId
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
        offset: $offset
      ) {
        items { ${ACTIVITY_EVENT_FIELDS} }
        totalCount
      }
    }`,
    'activityEvents',
    { chainId, projectId },
    {
      network: bendystrawNetworkHint(chainId),
      pageSize: limit,
      max: limit,
      startOffset: offset,
      policy: 'live',
    },
  )
  return page
}

export type BsFreshActivityEvent = BsActivityEvent & {
  project: {
    name: string | null
    logoUri: string | null
    tokenSymbol: string | null
    decimals: number | null
  } | null
}

/**
 * The homepage activity rail: latest project-oriented events across ALL V6
 * projects. The nested `project` field gives each event its local identity.
 */
export async function getRecentActivity(
  limit = 12,
  offset = 0,
): Promise<BsFreshActivityEvent[]> {
  const data = await bendystraw<{
    activityEvents: { items: BsFreshActivityEvent[] }
  }>(
    `query($limit: Int!, $offset: Int!) {
      activityEvents(
        where: {
          version: 6
          OR: [
            { payEvent_not: null }
            { cashOutTokensEvent_not: null }
            { swapEvent_not: null }
            { sendPayoutsEvent_not: null }
            { rulesetQueuedEvent_not: null }
            { projectCreateEvent_not: null }
            { addToBalanceEvent_not: null }
          ]
        }
        orderBy: "timestamp"
        orderDirection: "desc"
        limit: $limit
        offset: $offset
      ) {
        items {
          ${ACTIVITY_EVENT_FIELDS}
          project { name logoUri tokenSymbol decimals }
        }
      }
    }`,
    { limit, offset },
    { policy: 'live' },
  )
  return data.activityEvents.items
}

/**
 * Every indexed revnet-operator candidate, deduplicated and ordered with
 * nonempty permission rows first. Historical rows can retain the operator
 * flag after replacement; security-sensitive callers must live-check every
 * candidate rather than trusting the first indexed row.
 */
export const MAX_INDEXED_REVNET_OPERATOR_CANDIDATES = 50

export async function getRevnetOperatorCandidates(
  chainId: number,
  projectId: number,
): Promise<string[]> {
  {
    const account = (
      jbContractAddress['6'][RevnetCoreContracts.REVOwner] as Partial<
        Record<number, string>
      >
    )[chainId]
    if (!account) return []
    const page = await getPagedItems<{
      operator: string
      permissions: number[]
    }>(
      `query($chainId: Int!, $projectId: Int!, $account: String!, $limit: Int!, $offset: Int!) {
        permissionHolders(
          where: { chainId: $chainId, projectId: $projectId, account: $account, version: 6 }
          limit: $limit
          offset: $offset
        ) {
          items { operator permissions }
          totalCount
        }
      }`,
      'permissionHolders',
      { chainId, projectId, account },
      {
        pageSize: MAX_INDEXED_REVNET_OPERATOR_CANDIDATES,
        max: MAX_INDEXED_REVNET_OPERATOR_CANDIDATES,
      },
    )
    // An incomplete page is not an authoritative candidate set. Let callers
    // use their bounded JBPermissions-history fallback instead of live-
    // checking an attacker-sized collection of stale rotations.
    if (page.totalCount > MAX_INDEXED_REVNET_OPERATOR_CANDIDATES) return []
    const rows = page.items.slice(0, MAX_INDEXED_REVNET_OPERATOR_CANDIDATES)
    const live = rows.filter(r => r.permissions?.length > 0)
    const seen = new Set<string>()
    return [...live, ...rows].flatMap(row => {
      const operator = row.operator?.trim()
      if (!operator) return []
      const key = operator.toLowerCase()
      if (seen.has(key)) return []
      seen.add(key)
      return [operator]
    })
  }
}

/**
 * A revnet's display operator (website parity). Null means the indexer HAS an
 * answer and it is "no operator"; failures still throw. Trust decisions must
 * use `getRevnetOperatorCandidates` and verify them live.
 */
export async function getRevnetOperator(
  chainId: number,
  projectId: number,
): Promise<string | null> {
  return (await getRevnetOperatorCandidates(chainId, projectId))[0] ?? null
}

export type BsParticipant = {
  address: string
  balance: string
  chainId: number
  volumeUsd: string
  /**
   * The group this row was stamped with. When a sucker group is EXTENDED the indexer
   * re-points only a handful of tables and deletes the old group, so a row can still
   * carry a group id that no longer exists — which is why holders are read per chain.
   */
  suckerGroupId: string | null
}

export type BsProjectPayer = {
  chainId: number
  projectId: number
  version: number
  address: string
  defaultAddToBalance: boolean
  defaultBeneficiary: string
  owner: string
  paymentsCount: number
  addToBalanceCount: number
  totalFacilitated: string
  totalFacilitatedUsd: string
  lastUsedAt: number | null
  createdAt: number
}

const PROJECT_PAYERS_QUERY = `query ProjectPayers(
  $where: projectPayerFilter!
  $limit: Int!
  $offset: Int!
) {
  projectPayers(
    where: $where
    orderBy: "totalFacilitatedUsd"
    orderDirection: "desc"
    limit: $limit
    offset: $offset
  ) {
    totalCount
    items {
      chainId projectId version address defaultAddToBalance defaultBeneficiary
      owner paymentsCount addToBalanceCount totalFacilitated
      totalFacilitatedUsd lastUsedAt createdAt
    }
  }
}`

const PROJECT_TICKERS_QUERY = `query ProjectTickers(
  $where: deployErc20EventFilter!
  $limit: Int!
) {
  deployErc20Events(where: $where, limit: $limit) {
    items { chainId projectId symbol }
  }
}`

/**
 * The ERC-20 ticker each deployment issues, keyed `chainId:projectId`.
 *
 * A project row's `tokenSymbol` is the ACCOUNTING context's symbol — what the
 * project is paid IN (see bendystraw ponder.schema.ts, where token/tokenSymbol/
 * decimals/currency sit under an `accountingContext` heading). It must never
 * label a balance of the project's own token, or an ETH-funded project renders
 * its holders' balances as "ETH".
 */
export async function getProjectTickersByRefs(
  refs: VersionedProjectRef[],
): Promise<Map<string, string>> {
  const wheres = projectRefsWheres(refs)
  const tickers = new Map<string, string>()
  if (!wheres.length) return tickers
  const pages = await Promise.all(
    wheres.map(where =>
      bendystraw<{
        deployErc20Events: {
          items: { chainId: number; projectId: number; symbol: string }[]
        }
      }>(PROJECT_TICKERS_QUERY, { where, limit: 200 }, { policy: 'stable' }),
    ),
  )
  for (const page of pages) {
    for (const event of page.deployErc20Events.items) {
      if (!matchesProjectRef(
        { chainId: event.chainId, projectId: event.projectId, version: 6 },
        refs,
      )) continue
      if (event.symbol) tickers.set(`${event.chainId}:${event.projectId}`, event.symbol)
    }
  }
  return tickers
}

/** Indexed payer addresses for exact V6 deployments, defense-in-depth
 * filtered after every bounded Bendystraw query. */
export async function getProjectPayers(
  deployments: readonly [number, number][],
): Promise<BsProjectPayer[]> {
  const refs = deployments.map(([chainId, projectId]) => ({
    chainId,
    projectId,
    version: 6,
  }))
  const wheres = projectRefsWheres(refs)
  if (!wheres.length) return []
  const pages = await Promise.all(
    wheres.map(where =>
      getPagedItems<BsProjectPayer>(
        PROJECT_PAYERS_QUERY,
        'projectPayers',
        { where },
        {
          pageSize: 250,
          max: Number.POSITIVE_INFINITY,
          network: bendystrawNetworkHint(refs[0]?.chainId),
          policy: 'live',
        },
      ),
    ),
  )
  return pages
    .flatMap(page => page.items)
    .filter(row => matchesProjectRef(row, refs))
    .sort((a, b) => {
      try {
        const left = BigInt(String(a.totalFacilitatedUsd).split('.')[0])
        const right = BigInt(String(b.totalFacilitatedUsd).split('.')[0])
        return left === right ? 0 : left > right ? -1 : 1
      } catch {
        return 0
      }
    })
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

  const where: BendystrawFilter =
    args.suckerGroupId !== undefined
      ? { suckerGroupId: args.suckerGroupId, version: 6, balance_gt: '0' }
      : {
        AND: [
          projectRefAnd({
            chainId: args.chainId as number,
            projectId: args.projectId as number,
            version: 6,
          }),
          { balance_gt: '0' },
        ],
        }

  while (items.length < max) {
    const pageLimit = Math.min(pageSize, max - items.length)
    const data = await bendystraw<{
      participants: { items: BsParticipant[]; totalCount: number }
    }>(
      PARTICIPANTS_BY_FILTER_QUERY,
      { where, limit: pageLimit, offset },
      {
        network: bendystrawNetworkHint(args.chainId),
        policy: 'stable',
      },
    )

    const page = data.participants.items ?? []
    totalCount = data.participants.totalCount ?? totalCount
    items.push(...page)
    if (page.length === 0 || items.length >= totalCount) break
    offset += page.length
  }

  return { items, totalCount: totalCount || items.length }
}

/**
 * A project's holders read PER CHAIN and unioned, rather than by sucker group.
 *
 * The group-keyed read is lossy: extending a sucker group creates a NEW group id, and the
 * indexer re-points only a few tables before deleting the old group — `participant` is not
 * one of them, so every holder who has not transacted since the extension carries a group
 * id that no longer matches and silently disappears from a group-keyed query. Reading each
 * `(chainId, projectId)` deployment directly is not subject to that: those keys never move.
 *
 * `groupExtended` is true when a returned row still carries a superseded group id, which is
 * positive evidence that the OTHER group-keyed panels (price history, settlement queue) are
 * missing their pre-extension rows too. Those tables have no project-keyed equivalent the
 * client can query, so they can only be disclosed, not repaired here.
 */
export async function getParticipantsForRefs(
  refs: readonly { chainId: number; projectId: number }[],
  suckerGroupId: string | null,
  limit = 1000,
): Promise<{
  items: BsParticipant[]
  totalCount: number
  groupExtended: boolean
}> {
  const pages = await Promise.all(
    refs.map(ref =>
      getParticipants({ chainId: ref.chainId, projectId: ref.projectId }, limit),
    ),
  )
  const seen = new Set<string>()
  const items: BsParticipant[] = []
  let totalCount = 0
  for (const page of pages) {
    totalCount += page.totalCount
    for (const row of page.items) {
      const key = `${row.chainId}:${row.address.toLowerCase()}`
      if (seen.has(key)) continue
      seen.add(key)
      items.push(row)
    }
  }
  items.sort((a, b) => {
    const left = BigInt(a.balance)
    const right = BigInt(b.balance)
    return right > left ? 1 : right < left ? -1 : 0
  })
  return {
    items,
    totalCount,
    groupExtended:
      !!suckerGroupId &&
      items.some(row => !!row.suckerGroupId && row.suckerGroupId !== suckerGroupId),
  }
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
  /** Retained for API compatibility; complete pagination keeps this false. */
  capped: boolean
  /** Chains whose indexer request failed. Successful chains remain usable. */
  failedChains: number[]
}

const SHOP_ROWS_PAGE_SIZE = 200

/**
 * The shared per-chain scaffold for shop-row queries: paginate each
 * deployment to completion, flag failed chains without losing the
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
        while (offset < totalCount || offset === 0) {
          const data = await fetchPage(project, SHOP_ROWS_PAGE_SIZE, offset)
          const page = data?.items ?? []
          totalCount = data?.totalCount ?? totalCount
          items.push(...page.flatMap(row => mapRow(row, project)))
          offset += page.length
          if (page.length === 0 || offset >= totalCount) break
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
    capped: false,
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
        { policy: 'live' },
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
        { policy: 'live' },
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
  // A sucker group spans one row per chain per version, so 10 truncated real groups — and the
  // members that fell off vanished from project-page siblings, the wallet's cross-chain
  // balances and /api/search chain badges, with nothing to say they had.
  const data = await bendystraw<{
    suckerGroup: { projects: { items: BsProject[] } } | null
  }>(
    `query($id: String!) {
      suckerGroup(id: $id) {
        projects(limit: 100) { items { ${PROJECT_FIELDS} } }
      }
    }`,
    { id: suckerGroupId },
    {
      network: bendystrawNetworkHint(chainId),
      policy: 'stable',
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
 * Sum indexed payments over the same verified deployment set used for the
 * project page's cross-chain volume.
 */
export function projectGroupPaymentsCount(
  deployments: readonly Pick<BsProject, 'paymentsCount'>[],
): number {
  return deployments.reduce((total, row) => {
    const count = Number(row.paymentsCount)
    return total + (Number.isSafeInteger(count) && count > 0 ? count : 0)
  }, 0)
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
  volume: string
  tokenSupply: string
  /** 18-dec USD per one whole accounting token, as of THIS moment's block.
   *  Null for a moment the indexer could not value. */
  accountingTokenUsdRate?: string | null
}

export async function getSuckerGroupMoments(
  suckerGroupId: string,
): Promise<BsPriceMoment[]> {
  const page = await getPagedItems<BsPriceMoment>(
    MOMENTS_QUERY,
    'suckerGroupMoments',
    { suckerGroupId },
    { max: Number.POSITIVE_INFINITY, policy: 'stable' },
  )
  return page.items
}

type BsSwapEvent = {
  timestamp: number
  direction: string
  terminalTokenAmount: string
  projectTokenAmount: string
  poolId: string
  chainId: number
  sqrtPriceX96: string | null
  projectTokenIsCurrency0: boolean | null
  /** 18-dec USD per one whole accounting token, as of THIS swap's block. Null
   *  for a swap the indexer could not value, and absent on rows read by the
   *  pre-sqrtPriceX96 compatibility document below, which does not select it. */
  accountingTokenUsdRate?: string | null
}

type BsBuybackPoolEvent = {
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
  sourceCounts: {
    moments: number
    swaps: number
    pools: number
  }
  sampled: boolean
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
    max = Number.POSITIVE_INFINITY,
    startOffset = 0,
    network,
    policy = 'standard',
  }: {
    pageSize?: number
    max?: number
    /**
     * Row index the run starts at. `offset` inside `variables` is IGNORED — this function
     * owns paging — so a caller resuming after a first page must say so here. Without it
     * every "load more" re-fetched rows [0, limit) forever.
     */
    startOffset?: number
    network?: BendystrawNetwork
    policy?: BendystrawCachePolicy
  } = {},
): Promise<{ items: T[]; totalCount: number }> {
  const items: T[] = []
  let totalCount = 0

  while (items.length < max) {
    const pageLimit = Math.min(pageSize, max - items.length)
    const data = await bendystraw<
      Record<string, { items: T[]; totalCount: number }>
    >(
      query,
      { ...variables, limit: pageLimit, offset: startOffset + items.length },
      { network, policy },
    )
    const page = data[field]?.items ?? []
    totalCount = data[field]?.totalCount ?? totalCount
    items.push(...page)
    if (page.length === 0 || startOffset + items.length >= totalCount) {
      break
    }
  }

  return { items, totalCount: totalCount || startOffset + items.length }
}

/**
 * Real indexed cash-out inputs, pool registration prices, and exact post-swap
 * spots for a revnet. Consumers apply the project's decimals and filter to the
 * currently resolved pool; no values are projected beyond the last event.
 */
// Written out in full rather than built by interpolation: every document here is parsed and
// validated against the live schema by scripts/check-bendystraw-schema.mjs, and a document
// assembled at runtime cannot be.
const MOMENTS_QUERY = `query($suckerGroupId: String!, $limit: Int!, $offset: Int!) {
  suckerGroupMoments(
    where: { suckerGroupId: $suckerGroupId, version: 6 }
    orderBy: "timestamp"
    orderDirection: "asc"
    limit: $limit
    offset: $offset
  ) {
    items { timestamp balance volume tokenSupply accountingTokenUsdRate }
    totalCount
  }
}`

const SWAPS_QUERY = `query($suckerGroupId: String!, $limit: Int!, $offset: Int!) {
  swapEvents(
    where: { suckerGroupId: $suckerGroupId, version: 6 }
    orderBy: "timestamp"
    orderDirection: "asc"
    limit: $limit
    offset: $offset
  ) {
    items {
      timestamp direction terminalTokenAmount projectTokenAmount
      poolId chainId sqrtPriceX96 projectTokenIsCurrency0 accountingTokenUsdRate
    }
    totalCount
  }
}`

/**
 * Fields/lists that only a pre-upgrade indexer lacks. Anything else — a
 * timeout, a 5xx, a transport abort — is a real failure and must surface.
 */
const MARKET_SCHEMA_FIELDS = [
  'sqrtPriceX96',
  'projectTokenIsCurrency0',
  'buybackPoolEvents',
  'initialSqrtPriceX96',
]

function isMissingMarketSchemaError(reason: unknown): boolean {
  const message = reason instanceof Error ? reason.message : String(reason)
  return MARKET_SCHEMA_FIELDS.some(field => message.includes(field))
}

export async function getRevnetPriceHistory(
  suckerGroupId: string,
  /** `chainId` is an endpoint-routing hint only (testnet groups live on the
   *  testnet indexer); it never filters the group. */
  { chainId }: { chainId?: number } = {},
): Promise<BsRevnetPriceHistory> {
  const network = bendystrawNetworkHint(chainId)
  const momentsPromise = getPagedItems<BsPriceMoment>(
    MOMENTS_QUERY,
    'suckerGroupMoments',
    { suckerGroupId },
    { max: Number.POSITIVE_INFINITY, network, policy: 'live' },
  )

  const enhancedSwaps = () => getPagedItems<BsSwapEvent>(
    SWAPS_QUERY,
    'swapEvents',
    { suckerGroupId },
    { max: Number.POSITIVE_INFINITY, network, policy: 'live' },
  )

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
    { max: Number.POSITIVE_INFINITY, network, policy: 'live' },
  )

  const marketPromise = Promise.all([enhancedSwaps(), pools()])
    .then(([swaps, poolEvents]) => ({ swaps, pools: poolEvents }))
    .catch(async reason => {
      // Preserve the existing average-price series if a frontend deployment
      // reaches production before Bendystraw's additive schema fields — but
      // ONLY for that. Catching everything let a transient indexer failure
      // silently drop the pool-price line with no error state, so the chart
      // looked complete while missing a whole series.
      if (!isMissingMarketSchemaError(reason)) throw reason
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
        { max: Number.POSITIVE_INFINITY, network, policy: 'live' },
      )
      return {
        swaps,
        pools: { items: [], totalCount: 0 },
      }
    })

  const [momentsPage, market] = await Promise.all([
    momentsPromise,
    marketPromise,
  ])
  const moments = downsampleTimeSeries(
    momentsPage.items,
    3_000,
    row => row.timestamp,
    row =>
      BigInt(row.tokenSupply) === 0n
        ? 0
        : Number(row.balance) / Number(row.tokenSupply),
  )
  const swaps = downsampleTimeSeries(
    market.swaps.items,
    3_000,
    row => row.timestamp,
    row =>
      BigInt(row.projectTokenAmount) === 0n
        ? 0
        : Number(row.terminalTokenAmount) / Number(row.projectTokenAmount),
  )
  const poolEvents = downsampleTimeSeries(
    market.pools.items,
    3_000,
    row => row.timestamp,
    row => Number(row.initialSqrtPriceX96 ?? 0),
  )
  const sourceCounts = {
    moments: momentsPage.totalCount,
    swaps: market.swaps.totalCount,
    pools: market.pools.totalCount,
  }

  return {
    moments,
    swaps,
    pools: poolEvents,
    sourceCounts,
    sampled:
      moments.length < sourceCounts.moments ||
      swaps.length < sourceCounts.swaps ||
      poolEvents.length < sourceCounts.pools,
  }
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
async function getPermissionHolders(
  chainId: number,
  projectId: number,
): Promise<BsPermissionHolder[]> {
  const page = await getPagedItems<BsPermissionHolder>(
    `query($chainId: Int!, $projectId: Int!, $limit: Int!, $offset: Int!) {
        permissionHolders(
          where: { chainId: $chainId, projectId: $projectId, version: 6 }
          limit: $limit
          offset: $offset
        ) {
          items { chainId account operator permissions isRevnetOperator }
          totalCount
        }
      }`,
    'permissionHolders',
    { chainId, projectId },
    { pageSize: 200, max: Number.POSITIVE_INFINITY },
  )
  return page.items.filter(row => (row.permissions?.length ?? 0) > 0)
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

const BENEFICIARY_ACTIVITY_FIELDS = BENEFICIARY_EVENT_SOURCES.map(
  source => `
    ${source.list}(
      where: { AND: [{ beneficiary: $address }, { from_not: $address }, { version: 6 }] }
      orderBy: "timestamp"
      orderDirection: "desc"
      limit: $limit
      offset: $offset
    ) {
      totalCount
      items {
        id chainId projectId timestamp txHash from version
        project { name logoUri tokenSymbol decimals }
        ${source.selection}
      }
    }`,
).join('\n')

const ACCOUNT_ACTIVITY_QUERY = `query AccountActivity(
  $address: String!
  $limit: Int!
  $offset: Int!
) {
  activityEvents(
    where: { from: $address, version: 6 }
    orderBy: "timestamp"
    orderDirection: "desc"
    limit: $limit
    offset: $offset
  ) {
    totalCount
    items {
      version
      project { name logoUri tokenSymbol decimals }
      ${ACTIVITY_EVENT_FIELDS}
    }
  }
  ${BENEFICIARY_ACTIVITY_FIELDS}
}`

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
  const addressLower = address.toLowerCase()
  const targetCount = offset + limit
  const listNames = [
    'activityEvents',
    ...BENEFICIARY_EVENT_SOURCES.map(source => source.list),
  ]
  const pages = Object.fromEntries(
    listNames.map(name => [name, { items: [] as unknown[], totalCount: 0 }]),
  ) as Record<string, { items: unknown[]; totalCount: number }>

  let pageOffset = 0
  while (pageOffset < targetCount) {
    const pageLimit = Math.min(500, targetCount - pageOffset)
    const data = await bendystraw<
      Record<string, { items: unknown[]; totalCount: number }>
    >(
      ACCOUNT_ACTIVITY_QUERY,
      { address: addressLower, limit: pageLimit, offset: pageOffset },
      { policy: 'standard' },
    )
    for (const name of listNames) {
      const root = data[name]
      pages[name].items.push(...(root?.items ?? []))
      pages[name].totalCount = root?.totalCount ?? pages[name].items.length
    }
    pageOffset += pageLimit
    if (
      listNames.every(
        name => pages[name].items.length >= pages[name].totalCount,
      )
    ) {
      break
    }
  }

  let totalCount = pages.activityEvents.totalCount
  const merged = [
    ...(pages.activityEvents.items as BsAccountActivityEvent[]),
  ]
  for (let index = 0; index < BENEFICIARY_EVENT_SOURCES.length; index += 1) {
    const source = BENEFICIARY_EVENT_SOURCES[index]
    const page = pages[source.list]
    totalCount += page.totalCount
    for (const row of page.items as BsBeneficiaryEventRow[]) {
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
  // `totalCount` is the sum of per-branch counts, but the branches are deduped by id. Any row
  // counted twice would otherwise make "Load more (X of Y)" overstate Y and leave a page that
  // never arrives — subtract what the dedupe actually removed.
  const duplicatesInWindow = merged.length - deduped.length
  return {
    items: deduped.slice(offset, offset + limit),
    totalCount: totalCount - duplicatesInWindow,
  }
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
    { pageSize: 200, max: Number.POSITIVE_INFINITY },
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
    { pageSize: 200, max: Number.POSITIVE_INFINITY },
  )
  return page.items.filter(row => (row.permissions?.length ?? 0) > 0)
}

/**
 * Display metadata for exact (chainId, projectId, version) deployments —
 * the operated-projects section resolves grant rows to names this way.
 * Refs are number-validated before being inlined into the filter.
 */
export async function getProjectsByRefs(
  refs: VersionedProjectRef[],
): Promise<BsProject[]> {
  const wheres = projectRefsWheres(refs)
  if (!wheres.length) return []
  const pages = await Promise.all(
    wheres.map(where =>
      bendystraw<{ projects: { items: BsProject[] } }>(
        PROJECTS_BY_FILTER_QUERY,
        { where, limit: 200 },
        { policy: 'stable' },
      ),
    ),
  )
  return pages.flatMap(data =>
    data.projects.items.filter(project =>
      matchesProjectRef(
        {
          chainId: project.chainId,
          projectId: project.projectId,
          version: project.version,
        },
        refs,
      ),
    ),
  )
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
 * largest first, paginated to completion.
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
    { pageSize: 200, max: Number.POSITIVE_INFINITY },
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
 * newest first, paginated to completion.
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
    { pageSize: 200, max: Number.POSITIVE_INFINITY },
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
