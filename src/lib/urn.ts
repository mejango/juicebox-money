import type { JBChainId } from '@bananapus/nana-sdk-core'
import {
  displayChainId,
  displayChainName,
  displayChainSlug,
} from './chainDisplay'

/**
 * Parse a `<chainSlug>:<projectId>` URN (e.g. `eth:1`). V6-only site: no
 * version segment — bare URNs ARE v6.
 */
export function parseUrn(
  urn: string,
): { chainId: JBChainId; projectId: number } | null {
  const [slug, id] = decodeURIComponent(urn).split(':')
  const chainId = displayChainId(slug?.trim())
  const projectId = Number(id)
  if (chainId === null || !Number.isInteger(projectId) || projectId <= 0) {
    return null
  }
  return { chainId: chainId as JBChainId, projectId }
}

export function toUrn(chainId: number, projectId: number): string {
  return `${displayChainSlug(chainId) ?? chainId}:${projectId}`
}

export function chainName(chainId: number): string {
  return displayChainName(chainId)
}
