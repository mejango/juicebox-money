import Link from 'next/link'
import { ChainIcon } from '@/components/ChainIcon'
import { ProjectLogo } from '@/components/ProjectLogo'
import { accountProjectHref } from '@/components/account/AccountProjectCard'
import {
  dedupeVersionedRows,
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
import { chainName } from '@/lib/urn'

/** Identity for collapsing per-version duplicate participant rows. */
export function tokenHoldingIdentity(
  row: Pick<BsAccountTokenHolding, 'chainId' | 'projectId'>,
): string {
  return `${row.chainId}:${row.projectId}`
}

/**
 * Identity for collapsing per-version duplicate NFT rows. The hook contract
 * disambiguates projects whose 721 tokenIds collide on the same chain, and
 * stays stable across the per-version projectId aliases bendystraw keeps.
 */
export function nftHoldingIdentity(
  row: Pick<BsAccountNft, 'chainId' | 'projectId' | 'tokenId' | 'hook'>,
): string {
  const hook = row.hook?.address?.toLowerCase() ?? `p${row.projectId}`
  return `${row.chainId}:${hook}:${row.tokenId}`
}

type TokenHoldingRow = {
  chainId: number
  projectId: number
  version: number
  balance: bigint
  project: BsProject | null
}

export type TokenHoldingGroup = {
  /** The largest-balance deployment fronts the group's name, logo, and link. */
  front: TokenHoldingRow
  rows: TokenHoldingRow[]
  total: bigint
  symbol: string | null
}

function projectLookup(projects: BsProject[]): Map<string, BsProject> {
  return new Map(
    projects.map(project => [
      `${project.chainId}:${project.projectId}:${project.version}`,
      project,
    ]),
  )
}

/**
 * Per-project token balances, linked deployments merged across chains via
 * their shared sucker group, largest total first. Accepts raw (per-version
 * duplicated) participant rows.
 */
export function groupTokenHoldings(
  holdings: BsAccountTokenHolding[],
  projects: BsProject[],
): TokenHoldingGroup[] {
  const byRef = projectLookup(projects)
  const deduped = dedupeVersionedRows(holdings, tokenHoldingIdentity)
  const groups = new Map<string, TokenHoldingRow[]>()
  for (const raw of deduped) {
    const project =
      byRef.get(`${raw.chainId}:${raw.projectId}:${raw.version}`) ?? null
    const key = project?.suckerGroupId
      ? `group:${project.suckerGroupId}`
      : `solo:${raw.chainId}:${raw.projectId}:${raw.version}`
    let rows = groups.get(key)
    if (!rows) groups.set(key, (rows = []))
    rows.push({
      chainId: raw.chainId,
      projectId: raw.projectId,
      version: raw.version,
      balance: BigInt(raw.balance),
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
        symbol:
          sorted.find(row => row.project?.tokenSymbol)?.project
            ?.tokenSymbol ?? null,
      }
    })
    .sort((a, b) => (a.total < b.total ? 1 : -1))
}

export type NftTierHolding = {
  tierId: number
  count: number
  name: string
  image: string | null
}

export type NftHoldingGroup = {
  chainId: number
  projectId: number
  version: number
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

/**
 * Per-project shop-item holdings tallied by tier, most items first. Accepts
 * raw (per-version duplicated) NFT rows.
 */
export function groupNftHoldings(
  nfts: BsAccountNft[],
  projects: BsProject[],
): NftHoldingGroup[] {
  const byRef = projectLookup(projects)
  const deduped = dedupeVersionedRows(nfts, nftHoldingIdentity)
  const groups = new Map<string, { rows: BsAccountNft[] }>()
  for (const row of deduped) {
    const key = `${row.chainId}:${row.projectId}:${row.version}`
    let group = groups.get(key)
    if (!group) groups.set(key, (group = { rows: [] }))
    group.rows.push(row)
  }
  return [...groups.values()]
    .map(({ rows }) => {
      const { chainId, projectId, version } = rows[0]
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
        version,
        project: byRef.get(`${chainId}:${projectId}:${version}`) ?? null,
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
  version,
}: {
  project: BsProject | null
  chainId: number
  projectId: number
  version: number
}) {
  const name = project?.name ?? `Project ${projectId}`
  const { href, external } = accountProjectHref({ chainId, projectId, version })
  const className =
    'min-w-0 break-words font-agrandir font-medium text-ink hover:text-bluebs-600'
  return external ? (
    <a href={href} className={className}>
      {name}
    </a>
  ) : (
    <Link href={href} className={className}>
      {name}
    </Link>
  )
}

/** Token balances section of the Holdings tab. */
export function AccountTokenHoldings({
  groups,
}: {
  groups: TokenHoldingGroup[]
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
          key={`${group.front.chainId}:${group.front.projectId}:${group.front.version}`}
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
                  version={group.front.version}
                />
                <div className="mt-1 flex items-center gap-1.5">
                  {group.rows.map(row => (
                    <ChainIcon
                      key={`${row.chainId}:${row.projectId}`}
                      chainId={row.chainId}
                      size={16}
                    />
                  ))}
                  <span className="chip bg-smoke-100 text-smoke-700">
                    V{group.front.version}
                  </span>
                </div>
              </div>
            </div>
            <p className="shrink-0 text-sm font-medium text-ink">
              {formatTokenAmount(group.total)}{' '}
              <span className="text-smoke-600">
                {group.symbol ?? 'tokens'}
              </span>
            </p>
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
    </div>
  )
}

/** Shop-item section of the Holdings tab. */
export function AccountShopHoldings({
  groups,
}: {
  groups: NftHoldingGroup[]
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
          key={`${group.chainId}:${group.projectId}:${group.version}`}
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
                  version={group.version}
                />
                <div className="mt-1 flex items-center gap-1.5">
                  <ChainIcon chainId={group.chainId} size={16} />
                  <span className="chip bg-smoke-100 text-smoke-700">
                    V{group.version}
                  </span>
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
    </div>
  )
}
