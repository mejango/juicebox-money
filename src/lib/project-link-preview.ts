import { cache } from 'react'
import {
  getSuckerGroupProjects,
  projectGroupPaymentsCount,
  resolveProjectDeployments,
  type BsProject,
} from '@/lib/bendystraw'
import { formatTokenAmount, ipfsUrl } from '@/lib/format'
import { getProjectPageData } from '@/lib/project-fallback'

type ProjectLinkPreviewMetadata = {
  name?: string
  projectTagline?: string
  description?: string
  logoUri?: string
}

type ProjectLinkPreview = {
  name: string
  tagline: string | null
  logoUri: string | null
  balance: string
  paymentsCount: number
}

async function fetchProjectLinkPreviewMetadata(
  metadataUri: string | null,
): Promise<ProjectLinkPreviewMetadata | null> {
  const url = ipfsUrl(metadataUri)
  if (!url) return null
  try {
    const response = await fetch(url, {
      next: { revalidate: 300 },
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) return null
    const value = (await response.json()) as unknown
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as ProjectLinkPreviewMetadata)
      : null
  } catch {
    return null
  }
}

type BalanceBucket = {
  symbol: string
  decimals: number
  amount: bigint
}

export function projectPreviewSlogan(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const text = value
      ?.replace(/<br\s*\/?>/giu, ' ')
      .replace(/<[^>]+>/gu, ' ')
      .replace(/&amp;/gu, '&')
      .replace(/&quot;/gu, '"')
      .replace(/&#39;|&apos;/gu, "'")
      .replace(/&nbsp;/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim()
    if (text) return text.slice(0, 240)
  }
  return null
}

/**
 * Format indexed balances without adding unlike accounting tokens together.
 * One sucker group can legitimately hold ETH and USDC, so each token kind is
 * kept as its own visible bucket.
 */
export function formatProjectPreviewBalance(
  deployments: readonly Pick<BsProject, 'balance' | 'decimals' | 'tokenSymbol'>[],
): string {
  const buckets = new Map<string, BalanceBucket>()
  for (const deployment of deployments) {
    const symbol = deployment.tokenSymbol?.trim()
    const decimals = deployment.decimals
    if (!symbol || decimals == null || !Number.isSafeInteger(decimals) || decimals < 0) continue
    try {
      const key = `${symbol.toUpperCase()}:${decimals}`
      const current = buckets.get(key)
      buckets.set(key, {
        symbol,
        decimals,
        amount: (current?.amount ?? 0n) + BigInt(deployment.balance || '0'),
      })
    } catch {
      // Omit a malformed indexed balance rather than inventing a zero.
    }
  }

  const formatted = [...buckets.values()]
    .sort((left, right) => left.symbol.localeCompare(right.symbol))
    .map(
      bucket =>
        `${formatTokenAmount(bucket.amount, bucket.decimals, 4)} ${bucket.symbol}`,
    )
  if (!formatted.length) return 'Unavailable'
  if (formatted.length <= 2) return formatted.join(' + ')
  return `${formatted.slice(0, 2).join(' + ')} + ${formatted.length - 2} more`
}

export const getProjectLinkPreview = cache(
  async (chainId: number, projectId: number): Promise<ProjectLinkPreview | null> => {
    const result = await getProjectPageData(chainId, projectId)
    if (!result) return null

    const project = result.project
    const [metadata, siblings] = await Promise.all([
      fetchProjectLinkPreviewMetadata(project.metadataUri),
      !result.degraded && project.suckerGroupId
        ? getSuckerGroupProjects(project.suckerGroupId, chainId).catch(() => [])
        : Promise.resolve([]),
    ])
    const deployments = resolveProjectDeployments(project, siblings)
    const name = metadata?.name?.trim() || project.name || `Project ${project.projectId}`

    return {
      name,
      tagline: projectPreviewSlogan(
        metadata?.projectTagline,
        metadata?.description,
        project.projectTagline,
      ),
      logoUri: metadata?.logoUri?.trim() || project.logoUri,
      balance: formatProjectPreviewBalance(deployments),
      paymentsCount: projectGroupPaymentsCount(deployments),
    }
  },
)
