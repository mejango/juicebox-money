import { JB_CHAINS, JB_CHAIN_SLUGS, JBChainId } from '@bananapus/nana-sdk-core'

/**
 * Parse a `<chainSlug>:<projectId>` URN (e.g. `eth:1`). V6-only site: no
 * version segment — bare URNs ARE v6.
 */
export function parseUrn(
  urn: string,
): { chainId: JBChainId; projectId: number } | null {
  const [slug, id] = decodeURIComponent(urn).split(':')
  const chain = JB_CHAIN_SLUGS[slug?.trim()]
  const projectId = Number(id)
  if (!chain || !Number.isInteger(projectId) || projectId <= 0) return null
  return { chainId: chain.chain.id as JBChainId, projectId }
}

export function toUrn(chainId: number, projectId: number): string {
  const meta = JB_CHAINS[chainId as JBChainId]
  return `${meta?.slug ?? chainId}:${projectId}`
}

export function chainName(chainId: number): string {
  return JB_CHAINS[chainId as JBChainId]?.name ?? `Chain ${chainId}`
}
