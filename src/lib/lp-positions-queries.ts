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
      where: { chainId: $chainId, poolId: $poolId, burned: false, version: 6 }
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

/** One ModifyLiquidity in a buyback pool, in the order it happened. Amounts are fixed-point strings. */
export type BsPoolLiquidityEvent = {
  timestamp: number
  tokenId: string
  tickLower: number
  tickUpper: number
  liquidityAfter: string
  /** The pool's price at that block; null when the indexer could not read it. */
  sqrtPriceX96: string | null
}

const POOL_LIQUIDITY_EVENTS_QUERY = `
  query($chainId: Int!, $poolId: String!, $limit: Int!, $offset: Int!) {
    buybackPoolLiquidityEvents(
      where: { chainId: $chainId, poolId: $poolId, version: 6 }
      orderBy: "timestamp"
      orderDirection: "asc"
      limit: $limit
      offset: $offset
    ) {
      items {
        timestamp
        tokenId
        tickLower
        tickUpper
        liquidityAfter
        sqrtPriceX96
      }
      totalCount
    }
  }
`

/**
 * Every liquidity change a pool has seen, oldest first. The position table only
 * holds LIVE liquidity, so this is the only way to know what the pool held at an
 * earlier point. Null when the query failed; empty when the pool never held any.
 */
export async function fetchIndexedPoolLiquidityEvents({
  chainId,
  poolId,
}: {
  chainId: number
  poolId: string
}): Promise<BsPoolLiquidityEvent[] | null> {
  try {
    const page = await getPagedItems<BsPoolLiquidityEvent>(
      POOL_LIQUIDITY_EVENTS_QUERY,
      'buybackPoolLiquidityEvents',
      { chainId, poolId },
      { pageSize: 250 },
    )
    return page.items
  } catch {
    return null
  }
}
