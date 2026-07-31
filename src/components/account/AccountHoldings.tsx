import Link from 'next/link'
import { ChainIcon } from '@/components/ChainIcon'
import { ProjectLogo } from '@/components/ProjectLogo'
import {
  type BsAccountNft,
  type BsAccountTokenHolding,
  type BsProject,
} from '@/lib/bendystraw'
import { formatTokenAmount } from '@/lib/format'
import {
  parseTierMetadataJson,
  pickTierMetadata,
  tierMediaImageUrl,
} from '@/lib/tier-metadata'
import { chainName, toUrn } from '@/lib/urn'

type TokenHoldingRow = {
  chainId: number
  projectId: number
  balance: bigint
  /** The unclaimed-credit share of `balance`. */
  credits: bigint
  /** The claimed ERC-20 share of `balance`. */
  claimed: bigint
  project: BsProject | null
}

export type TokenHoldingGroup = {
  /** The largest-balance deployment fronts the group's name, logo, and link. */
  front: TokenHoldingRow
  rows: TokenHoldingRow[]
  total: bigint
  credits: bigint
  claimed: bigint
  symbol: string | null
}

function projectLookup(projects: BsProject[]): Map<string, BsProject> {
  return new Map(
    projects.map(project => [
      `${project.chainId}:${project.projectId}`,
      project,
    ]),
  )
}

/**
 * Per-project token balances, linked deployments merged across chains via
 * their shared sucker group, largest total first. V6-only rows.
 */
export function groupTokenHoldings(
  holdings: BsAccountTokenHolding[],
  projects: BsProject[],
): TokenHoldingGroup[] {
  const byRef = projectLookup(projects)
  const groups = new Map<string, TokenHoldingRow[]>()
  for (const raw of holdings) {
    const project = byRef.get(`${raw.chainId}:${raw.projectId}`) ?? null
    const key = project?.suckerGroupId
      ? `group:${project.suckerGroupId}`
      : `solo:${raw.chainId}:${raw.projectId}`
    let rows = groups.get(key)
    if (!rows) groups.set(key, (rows = []))
    rows.push({
      chainId: raw.chainId,
      projectId: raw.projectId,
      balance: BigInt(raw.balance),
      credits: BigInt(raw.creditBalance ?? '0'),
      claimed: BigInt(raw.erc20Balance ?? '0'),
      project,
    })
  }
  return [...groups.values()]
    .map(rows => {
      const sorted = [...rows].sort((a, b) => (a.balance < b.balance ? 1 : -1))
      const front = sorted[0]
      return {
        front,
        rows: sorted,
        total: sorted.reduce((sum, row) => sum + row.balance, 0n),
        credits: sorted.reduce((sum, row) => sum + row.credits, 0n),
        claimed: sorted.reduce((sum, row) => sum + row.claimed, 0n),
        symbol:
          sorted.find(row => row.project?.tokenSymbol)?.project
            ?.tokenSymbol ?? null,
      }
    })
    .sort((a, b) => (a.total < b.total ? 1 : -1))
}

type NftTierHolding = {
  tierId: number
  count: number
  name: string
  image: string | null
}

export type NftHoldingGroup = {
  chainId: number
  projectId: number
  project: BsProject | null
  tiers: NftTierHolding[]
  count: number
}

/** Best-effort tier display metadata from what bendystraw indexed. */
function tierMedia(row: BsAccountNft): { name?: string; image?: string } {
  const json =
    row.tier?.metadata && typeof row.tier.metadata === 'object'
      ? row.tier.metadata
      : row.tier?.resolvedUri
        ? parseTierMetadataJson(row.tier.resolvedUri)
        : null
  if (!json) return {}
  const meta = pickTierMetadata(json as Record<string, unknown>)
  return { name: meta.name, image: tierMediaImageUrl(meta.image) }
}

/** Per-project shop-item holdings tallied by tier, most items first. */
export function groupNftHoldings(
  nfts: BsAccountNft[],
  projects: BsProject[],
): NftHoldingGroup[] {
  const byRef = projectLookup(projects)
  const groups = new Map<string, { rows: BsAccountNft[] }>()
  for (const row of nfts) {
    const key = `${row.chainId}:${row.projectId}`
    let group = groups.get(key)
    if (!group) groups.set(key, (group = { rows: [] }))
    group.rows.push(row)
  }
  return [...groups.values()]
    .map(({ rows }) => {
      const { chainId, projectId } = rows[0]
      const byTier = new Map<number, BsAccountNft[]>()
      for (const row of rows) {
        let tier = byTier.get(row.tierId)
        if (!tier) byTier.set(row.tierId, (tier = []))
        tier.push(row)
      }
      const tiers = [...byTier.entries()]
        .map(([tierId, tierRows]) => {
          const media = tierMedia(tierRows[0])
          return {
            tierId,
            count: tierRows.length,
            name: media.name ?? `Item #${tierId}`,
            image: media.image ?? null,
          }
        })
        .sort((a, b) => b.count - a.count || a.tierId - b.tierId)
      return {
        chainId,
        projectId,
        project: byRef.get(`${chainId}:${projectId}`) ?? null,
        tiers,
        count: rows.length,
      }
    })
    .sort((a, b) => b.count - a.count)
}

function ProjectTitle({
  project,
  chainId,
  projectId,
}: {
  project: BsProject | null
  chainId: number
  projectId: number
}) {
  const name = project?.name ?? `Project ${projectId}`
  return (
    <Link
      href={`/${toUrn(chainId, projectId)}`}
      className="min-w-0 break-words font-agrandir font-medium text-ink hover:text-bluebs-600"
    >
      {name}
    </Link>
  )
}

/** The "fetch hit its cap" note under a holdings section. */
function TruncationNote({
  fetchedCount,
  totalCount,
  noun,
  order,
}: {
  fetchedCount?: number
  totalCount?: number
  noun: string
  order: string
}) {
  if (
    fetchedCount === undefined ||
    totalCount === undefined ||
    totalCount <= fetchedCount
  ) {
    return null
  }
  return (
    <p className="text-xs text-smoke-500">
      Showing the {fetchedCount} {order} of {totalCount} {noun}.
    </p>
  )
}

/** Token balances section of the Holdings tab. */
export function AccountTokenHoldings({
  groups,
  fetchedCount,
  totalCount,
}: {
  groups: TokenHoldingGroup[]
  /** Raw participant rows fetched / indexed, for the truncation note. */
  fetchedCount?: number
  totalCount?: number
}) {
  if (groups.length === 0) {
    return (
      <p className="text-sm text-smoke-600">
        This account doesn&apos;t hold any project tokens.
      </p>
    )
  }
  return (
    <div className="space-y-4">
      {groups.map(group => (
        <div
          key={`${group.front.chainId}:${group.front.projectId}`}
          className="card p-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <ProjectLogo
                name={group.front.project?.name ?? null}
                logoUri={group.front.project?.logoUri ?? null}
                size={40}
              />
              <div className="min-w-0">
                <ProjectTitle
                  project={group.front.project}
                  chainId={group.front.chainId}
                  projectId={group.front.projectId}
                />
                <div className="mt-1 flex items-center gap-1.5">
                  {group.rows.map(row => (
                    <ChainIcon
                      key={`${row.chainId}:${row.projectId}`}
                      chainId={row.chainId}
                      size={16}
                      standalone
                    />
                  ))}
                </div>
              </div>
            </div>
            <div className="shrink-0 text-right">
              <p className="text-sm font-medium text-ink">
                {formatTokenAmount(group.total)}{' '}
                <span className="text-smoke-600">
                  {group.symbol ?? 'tokens'}
                </span>
              </p>
              {group.claimed > 0n && group.credits > 0n ? (
                <p className="mt-0.5 text-xs text-smoke-500">
                  {formatTokenAmount(group.claimed)} claimed ·{' '}
                  {formatTokenAmount(group.credits)} credits
                </p>
              ) : null}
            </div>
          </div>
          {group.rows.length > 1 ? (
            <div className="mt-3 divide-y divide-smoke-100">
              {group.rows.map(row => (
                <div
                  key={`${row.chainId}:${row.projectId}`}
                  className="flex items-center justify-between gap-3 py-2 text-sm"
                >
                  <span className="flex items-center gap-1.5 text-smoke-700">
                    <ChainIcon chainId={row.chainId} size={16} />
                    {chainName(row.chainId)}
                  </span>
                  <span className="text-smoke-700">
                    {formatTokenAmount(row.balance)}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ))}
      <TruncationNote
        fetchedCount={fetchedCount}
        totalCount={totalCount}
        noun="balances"
        order="largest"
      />
    </div>
  )
}

/** Shop-item section of the Holdings tab. */
export function AccountShopHoldings({
  groups,
  fetchedCount,
  totalCount,
}: {
  groups: NftHoldingGroup[]
  /** Raw NFT rows fetched / indexed, for the truncation note. */
  fetchedCount?: number
  totalCount?: number
}) {
  if (groups.length === 0) {
    return (
      <p className="text-sm text-smoke-600">
        This account doesn&apos;t hold any store items.
      </p>
    )
  }
  return (
    <div className="space-y-4">
      {groups.map(group => (
        <div
          key={`${group.chainId}:${group.projectId}`}
          className="card p-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <ProjectLogo
                name={group.project?.name ?? null}
                logoUri={group.project?.logoUri ?? null}
                size={40}
              />
              <div className="min-w-0">
                <ProjectTitle
                  project={group.project}
                  chainId={group.chainId}
                  projectId={group.projectId}
                />
                <div className="mt-1 flex items-center gap-1.5">
                  <ChainIcon chainId={group.chainId} size={16} standalone />
                </div>
              </div>
            </div>
            <p className="shrink-0 text-sm font-medium text-ink">
              {group.count} {group.count === 1 ? 'item' : 'items'}
            </p>
          </div>
          <div className="mt-3 divide-y divide-smoke-100">
            {group.tiers.map(tier => (
              <div
                key={tier.tierId}
                className="flex items-center justify-between gap-3 py-2 text-sm"
              >
                <span className="flex min-w-0 items-center gap-2.5">
                  {tier.image ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={tier.image}
                      alt=""
                      className="h-8 w-8 shrink-0 rounded bg-smoke-100 object-cover"
                    />
                  ) : (
                    <span className="h-8 w-8 shrink-0 rounded bg-smoke-100" />
                  )}
                  <span className="min-w-0 truncate font-medium text-ink">
                    {tier.name}
                  </span>
                </span>
                <span className="shrink-0 text-smoke-700">×{tier.count}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
      <TruncationNote
        fetchedCount={fetchedCount}
        totalCount={totalCount}
        noun="items"
        order="newest"
      />
    </div>
  )
}
