import { cache } from 'react'
import {
  projectGroupPaymentsCount,
  resolveProjectDeployments,
  type BsProject,
} from '@/lib/bendystraw'
import { formatTokenAmount, formatUsd18 } from '@/lib/format'
import { knownTokenSymbol } from '@/lib/token-symbol'
import { getProjectPageData, getProjectSiblings, getProjectMetadata } from '@/lib/project-server-data'

type ProjectLinkPreview = {
  name: string
  tagline: string | null
  logoUri: string | null
  balance: string
  paymentsCount: number
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
 * Format indexed balances without adding unlike tokens together. A project
 * can hold ETH and USDC at once, so each token kind is kept as its own
 * visible bucket, read from the per-token rows. A held token with no known
 * symbol is shown in USD. A deployment with no rows falls back to its
 * accounting-token balance, or to its USD balance when it accepts several
 * tokens, whose raw balance adds unlike units.
 */
export function formatProjectPreviewBalance(
  deployments: readonly Pick<
    BsProject,
    | 'balance'
    | 'chainId'
    | 'decimals'
    | 'tokenSymbol'
    | 'token'
    | 'accountingTokenCount'
    | 'balanceUsd'
    | 'projectTokenBalances'
  >[],
): string {
  const buckets = new Map<string, BalanceBucket>()
  let usdOnly = 0n
  for (const deployment of deployments) {
    const rows = deployment.projectTokenBalances?.items
    if (!rows?.length && (deployment.accountingTokenCount ?? 1) > 1) {
      try {
        usdOnly += BigInt(deployment.balanceUsd || '0')
      } catch {
        // Omit a malformed indexed balance rather than inventing a zero.
      }
      continue
    }
    for (const row of rows?.length ? rows : [deployment]) {
      const symbol = (
        row.tokenSymbol ||
        (row.token ? knownTokenSymbol(row.token, { chainId: deployment.chainId }) : null)
      )?.trim()
      const decimals = row.decimals
      try {
        if (!symbol && row !== deployment) {
          usdOnly += BigInt(row.balanceUsd || '0')
          continue
        }
        if (!symbol || decimals == null || !Number.isSafeInteger(decimals) || decimals < 0) continue
        const key = `${symbol.toUpperCase()}:${decimals}`
        const current = buckets.get(key)
        buckets.set(key, {
          symbol,
          decimals,
          amount: (current?.amount ?? 0n) + BigInt(row.balance || '0'),
        })
      } catch {
        // Omit a malformed indexed balance rather than inventing a zero.
      }
    }
  }

  const sorted = [...buckets.values()].sort((left, right) =>
    left.symbol.localeCompare(right.symbol),
  )
  // A token the project accepts but does not hold adds only noise.
  const held = sorted.filter(bucket => bucket.amount > 0n)
  const formatted = (held.length || usdOnly > 0n ? held : sorted.slice(0, 1)).map(
    bucket =>
      `${formatTokenAmount(bucket.amount, bucket.decimals, 4)} ${bucket.symbol}`,
  )
  if (usdOnly > 0n) formatted.push(formatUsd18(usdOnly))
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
      getProjectMetadata(project.metadataUri),
      !result.degraded && project.suckerGroupId
        ? getProjectSiblings(chainId, projectId, project.suckerGroupId).catch(() => [])
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

/** Cache key for the share card: changes exactly when the numbers on it do. */
export function previewVersion(
  preview: Pick<ProjectLinkPreview, 'balance' | 'paymentsCount'> | null,
): string {
  if (!preview) return '0'
  return `${preview.paymentsCount}-${preview.balance.replace(/\D/gu, '')}`
}
