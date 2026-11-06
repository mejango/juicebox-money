import {
  UNISWAP_V4_POOL_MANAGER_ADDRESSES,
  uniswapV4AmountsForLiquidity,
  uniswapV4LiquidityForAmounts,
  uniswapV4PoolId,
  uniswapV4PoolStateSlot,
  uniswapV4SqrtPriceX96AtTick,
  uniswapV4SqrtPriceX96FromSlot0,
} from '@bananapus/nana-sdk-core/v6'
import { encodeAbiParameters, getAddress, type Address, type Hex, type PublicClient } from 'viem'

/**
 * Rules for moving a project's buyback pool onto the current hook generation.
 * Mirrored in revnet-money's `buyback-pool-migration.ts`: Safe co-signers and LPs
 * on either client must get identical calldata.
 */

export type V4PoolKey = {
  currency0: Address
  currency1: Address
  fee: number
  tickSpacing: number
  hooks: Address
}

const EXTSLOAD_ABI = [
  {
    type: 'function',
    name: 'extsload',
    stateMutability: 'view',
    inputs: [{ name: 'slot', type: 'bytes32' }],
    outputs: [{ type: 'bytes32' }],
  },
] as const

/** The old pool's currencies, fee and spacing, attached to the current V4 hook. */
export function migratedPoolKey(old: V4PoolKey, poolHook: Address): V4PoolKey {
  return {
    currency0: getAddress(old.currency0),
    currency1: getAddress(old.currency1),
    fee: Number(old.fee),
    tickSpacing: Number(old.tickSpacing),
    hooks: getAddress(poolHook),
  }
}

/** The pool's live sqrtPriceX96, or 0 when the PoolManager has not initialized it. */
export async function poolSqrtPriceX96(
  client: Pick<PublicClient, 'readContract'>,
  chainId: number,
  key: V4PoolKey,
): Promise<bigint> {
  const poolManager = UNISWAP_V4_POOL_MANAGER_ADDRESSES[
    chainId as keyof typeof UNISWAP_V4_POOL_MANAGER_ADDRESSES
  ] as Address | undefined
  if (!poolManager) throw new Error(`No Uniswap V4 PoolManager on chain ${chainId}.`)
  const slot0 = await client.readContract({
    address: poolManager,
    abi: EXTSLOAD_ABI,
    functionName: 'extsload',
    args: [uniswapV4PoolStateSlot(uniswapV4PoolId(key))],
  })
  return uniswapV4SqrtPriceX96FromSlot0(slot0)
}

export type PoolMove =
  | { kind: 'setPoolFor' }
  | { kind: 'initializePoolFor'; sqrtPriceX96: bigint }
  | { kind: 'none' }

/**
 * An existing new pool is registered as it is (initializing it would revert on any other
 * price); otherwise it opens at the old pool's live price. An old pool with no price has
 * nothing to carry.
 */
export function poolMove(oldSqrtPriceX96: bigint, newSqrtPriceX96: bigint): PoolMove {
  if (newSqrtPriceX96 > 0n) return { kind: 'setPoolFor' }
  if (oldSqrtPriceX96 > 0n) return { kind: 'initializePoolFor', sqrtPriceX96: oldSqrtPriceX96 }
  return { kind: 'none' }
}

/**
 * The retired V4 hooks whose pools may still hold a wallet's liquidity. Empty until the project's
 * pool sits on the current V4 hook, so nothing is offered before there is a pool to move into.
 */
export function retiredPoolHooks(
  poolHooks: Address,
  currentHook: Address | null,
  history: Record<string, string | null> | undefined,
): Address[] {
  if (!currentHook || poolHooks.toLowerCase() !== currentHook.toLowerCase()) return []
  return Object.values(history ?? {})
    .filter((hook): hook is string => !!hook && hook.toLowerCase() !== currentHook.toLowerCase())
    .map((hook) => getAddress(hook))
}

/** v4-periphery `Actions`: BURN_POSITION, MINT_POSITION, CLOSE_CURRENCY. */
const MOVE_ACTIONS = '0x03021212'

export type LiquidityMovePlan = {
  unlockData: Hex
  /** Burn floors: 99% of what the position holds at the old pool's reviewed price. */
  amount0Minimum: bigint
  amount1Minimum: bigint
  /** The new position's liquidity, sized from 98% of the removed amounts at the new pool's price. */
  liquidity: bigint
}

/**
 * One `modifyLiquidities` unlock that burns a position in the old pool and mints the same band
 * in the new one, funded only by the burn: the mint's maxima are the burn's floors, so the
 * wallet never pays in. Both closes return the remainder and the old position's fees to the caller.
 */
export function liquidityMovePlan({
  tokenId,
  liquidity,
  tickLower,
  tickUpper,
  to,
  fromSqrtPriceX96,
  toSqrtPriceX96,
  owner,
}: {
  tokenId: bigint
  liquidity: bigint
  tickLower: number
  tickUpper: number
  to: V4PoolKey
  fromSqrtPriceX96: bigint
  toSqrtPriceX96: bigint
  owner: Address
}): LiquidityMovePlan {
  if (liquidity <= 0n) throw new Error('This position holds no liquidity.')
  if (toSqrtPriceX96 <= 0n) throw new Error('The new pool is not open yet.')
  if (tickLower % to.tickSpacing !== 0 || tickUpper % to.tickSpacing !== 0) {
    throw new Error("This band does not fit the new pool's tick spacing.")
  }
  const sqrtA = uniswapV4SqrtPriceX96AtTick(tickLower)
  const sqrtB = uniswapV4SqrtPriceX96AtTick(tickUpper)
  const removed = uniswapV4AmountsForLiquidity(fromSqrtPriceX96, sqrtA, sqrtB, liquidity)
  const amount0Minimum = removed.amount0 - removed.amount0 / 100n
  const amount1Minimum = removed.amount1 - removed.amount1 / 100n
  const moved = uniswapV4LiquidityForAmounts(
    toSqrtPriceX96,
    sqrtA,
    sqrtB,
    removed.amount0 - (removed.amount0 * 2n) / 100n,
    removed.amount1 - (removed.amount1 * 2n) / 100n,
  )
  if (moved <= 0n) throw new Error('This position is too small to move.')
  const burn = encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'bytes' }],
    [tokenId, amount0Minimum, amount1Minimum, '0x'],
  )
  const mint = encodeAbiParameters(
    [
      {
        type: 'tuple',
        components: [
          { type: 'address' },
          { type: 'address' },
          { type: 'uint24' },
          { type: 'int24' },
          { type: 'address' },
        ],
      },
      { type: 'int24' },
      { type: 'int24' },
      { type: 'uint256' },
      { type: 'uint128' },
      { type: 'uint128' },
      { type: 'address' },
      { type: 'bytes' },
    ],
    [
      [to.currency0, to.currency1, to.fee, to.tickSpacing, to.hooks],
      tickLower,
      tickUpper,
      moved,
      amount0Minimum,
      amount1Minimum,
      owner,
      '0x',
    ],
  )
  const close0 = encodeAbiParameters([{ type: 'address' }], [to.currency0])
  const close1 = encodeAbiParameters([{ type: 'address' }], [to.currency1])
  return {
    unlockData: encodeAbiParameters(
      [{ type: 'bytes' }, { type: 'bytes[]' }],
      [MOVE_ACTIONS, [burn, mint, close0, close1]],
    ),
    amount0Minimum,
    amount1Minimum,
    liquidity: moved,
  }
}
