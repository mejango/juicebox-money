/**
 * Bendystraw queries for revnet loans and auto-issuances (website/ parity:
 * BENDYSTRAW_LOANS_QUERY, BENDYSTRAW_STORE_AUTO_ISSUANCE_QUERY,
 * BENDYSTRAW_AUTO_ISSUE_EVENTS_QUERY). Typed by hand, V6-only. These read
 * INDEXED history; every write flow re-reads the authoritative on-chain state
 * before sending.
 */

import { bendystraw } from '@/lib/bendystraw'

/** One open/closed loan row from the indexer. Amounts are fixed-point strings
 *  in the loan's source-token decimals; percents are out of 1000. */
export type BsLoan = {
  id: string
  borrowAmount: string
  collateral: string
  beneficiary: string
  owner: string
  createdAt: number
  chainId: number
  prepaidFeePercent: number
  prepaidDuration: number
  sourceFeeAmount: string
  token: string
}

const LOANS_QUERY = `
  query($projectId: Int!, $chainId: Int!, $limit: Int!, $offset: Int!) {
    loans(
      where: { projectId: $projectId, version: 6, chainId: $chainId }
      orderBy: "createdAt"
      orderDirection: "desc"
      limit: $limit
      offset: $offset
    ) {
      items {
        id borrowAmount collateral beneficiary owner createdAt chainId
        prepaidFeePercent prepaidDuration sourceFeeAmount token
      }
      totalCount
    }
  }
`

/**
 * A deployment's loans, newest first. The chain and its local project ID are
 * always passed together; linked deployments are never queried with one
 * project's ID. Paginated so a busy revnet's full loan book comes back.
 */
export async function getLoans(
  projectId: number,
  chainId: number,
  limit = 500,
): Promise<{ items: BsLoan[]; totalCount: number }> {
  const max = Math.max(1, Math.min(1000, limit))
  const pageSize = 250
  const items: BsLoan[] = []
  let totalCount = 0
  let offset = 0

  while (items.length < max) {
    const pageLimit = Math.min(pageSize, max - items.length)
    const data = await bendystraw<{
      loans: { items: BsLoan[]; totalCount: number }
    }>(
      LOANS_QUERY,
      { projectId, chainId, limit: pageLimit, offset },
      { revalidate: 30 },
    )
    const page = data.loans.items ?? []
    totalCount = data.loans.totalCount ?? totalCount
    items.push(...page)
    if (page.length === 0 || items.length >= totalCount) break
    offset += page.length
  }

  return { items, totalCount: totalCount || items.length }
}

/** An auto-issuance event: `stored` events register a stage's pending mint;
 *  `issued` events record it being distributed. `count` is 18-dec fixed point. */
export type BsAutoIssuanceEvent = {
  timestamp: number
  txHash: string
  caller: string
  beneficiary: string
  stageId: string
  count: string
}

const STORE_AUTO_ISSUANCE_QUERY = `
  query($projectId: Int!, $chainId: Int!, $limit: Int!, $offset: Int!) {
    storeAutoIssuanceAmountEvents(
      where: { projectId: $projectId, chainId: $chainId, version: 6 }
      orderBy: "timestamp"
      orderDirection: "desc"
      limit: $limit
      offset: $offset
    ) {
      items { timestamp txHash caller beneficiary stageId count }
      totalCount
    }
  }
`

const AUTO_ISSUE_EVENTS_QUERY = `
  query($projectId: Int!, $chainId: Int!, $limit: Int!, $offset: Int!) {
    autoIssueEvents(
      where: { projectId: $projectId, chainId: $chainId, version: 6 }
      orderBy: "timestamp"
      orderDirection: "desc"
      limit: $limit
      offset: $offset
    ) {
      items { timestamp txHash caller beneficiary stageId count }
      totalCount
    }
  }
`

async function fetchAutoIssuePages(
  query: string,
  path: 'storeAutoIssuanceAmountEvents' | 'autoIssueEvents',
  projectId: number,
  chainId: number,
): Promise<BsAutoIssuanceEvent[]> {
  const pageSize = 250
  const max = 1000
  const items: BsAutoIssuanceEvent[] = []
  let totalCount = 0
  let offset = 0
  while (items.length < max) {
    const data = await bendystraw<
      Record<string, { items: BsAutoIssuanceEvent[]; totalCount: number }>
    >(query, { projectId, chainId, limit: pageSize, offset }, { revalidate: 30 })
    const result = data[path]
    const page = result?.items ?? []
    totalCount = result?.totalCount ?? totalCount
    items.push(...page)
    if (page.length === 0 || items.length >= totalCount) break
    offset += page.length
  }
  return items
}

/**
 * A revnet's auto-issuance candidates on one chain: `stored` are the pending
 * amounts (the candidate list), `issued` records which have already been
 * distributed. Callers dedupe by (stageId, beneficiary) and confirm the still
 * distributable amount on-chain with getAmountToAutoIssue before showing a
 * Distribute button.
 */
export async function getAutoIssuances(
  projectId: number,
  chainId: number,
): Promise<{ stored: BsAutoIssuanceEvent[]; issued: BsAutoIssuanceEvent[] }> {
  const stored = await fetchAutoIssuePages(
    STORE_AUTO_ISSUANCE_QUERY,
    'storeAutoIssuanceAmountEvents',
    projectId,
    chainId,
  )
  // Best-effort enrichment: if the issued lookup fails, the on-chain amount
  // read is still the authoritative gate, so don't fail the whole section.
  const issued = await fetchAutoIssuePages(
    AUTO_ISSUE_EVENTS_QUERY,
    'autoIssueEvents',
    projectId,
    chainId,
  ).catch(() => [])
  return { stored, issued }
}
