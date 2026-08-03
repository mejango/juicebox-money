/**
 * Indexed Uniswap V4 LP positions in a project's buyback pool.
 *
 * Walking `ModifyLiquidity` logs back to a pool's `Initialize` is the slow part
 * of every LP surface, and it can only ever report fees a position has NOT yet
 * claimed — the pool overwrites a position's checkpoint on every collect, so
 * `feesClaimed*` is the part no client can derive. Reads indexed history; every
 * write flow still re-reads authoritative on-chain state before sending.
 */

import { getPagedItems } from '@/lib/bendystraw'

/** One live LP position from the indexer. Amounts are fixed-point strings. */
export type BsLpPosition = {
  chainId: number
  tokenId: string
  owner: string
  tickLower: number
  tickUpper: number
  liquidity: string
  feesClaimed0: string
  feesClaimed1: string
}

const LP_POSITIONS_QUERY = `
  query($chainId: Int!, $poolId: String!, $limit: Int!, $offset: Int!) {
    buybackPoolPositions(
      where: { chainId: $chainId, poolId: $poolId, burned: false }
      orderBy: "tokenId"
      orderDirection: "asc"
      limit: $limit
      offset: $offset
    ) {
      items {
        chainId
        tokenId
        owner
        tickLower
        tickUpper
        liquidity
        feesClaimed0
        feesClaimed1
      }
      totalCount
    }
  }
`

/**
 * A pool's positions, or null when the index has nothing for it.
 *
 * Null covers both "not indexed yet" and "query failed", which are
 * indistinguishable from here and mean the same thing to a caller: fall back to
 * the on-chain scan rather than presenting an empty pool as fact.
 */
export async function fetchIndexedLpPositions({
  chainId,
  poolId,
}: {
  chainId: number
  poolId: string
}): Promise<BsLpPosition[] | null> {
  try {
    const page = await getPagedItems<BsLpPosition>(
      LP_POSITIONS_QUERY,
      'buybackPoolPositions',
      { chainId, poolId },
      { pageSize: 250 },
    )
    return page.items.length ? page.items : null
  } catch {
    return null
  }
}
