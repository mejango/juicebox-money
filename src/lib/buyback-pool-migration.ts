import {
  UNISWAP_V4_POOL_MANAGER_ADDRESSES,
  uniswapV4AmountsForLiquidity,
  uniswapV4LiquidityForAmounts,
  uniswapV4PoolId,
  uniswapV4PoolStateSlot,
  uniswapV4PositionTicks,
  uniswapV4SqrtPriceX96AtTick,
  uniswapV4SqrtPriceX96FromSlot0,
} from '@bananapus/nana-sdk-core/v6'
import {
  encodeAbiParameters,
  getAddress,
  isAddressEqual,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem'

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

const KEY_COMPONENTS = [
  { name: 'currency0', type: 'address' },
  { name: 'currency1', type: 'address' },
  { name: 'fee', type: 'uint24' },
  { name: 'tickSpacing', type: 'int24' },
  { name: 'hooks', type: 'address' },
] as const

const ORACLE_ABI = [
  {
    type: 'function',
    name: 'observationCoverageOf',
    stateMutability: 'view',
    inputs: [{ name: 'key', type: 'tuple', components: KEY_COMPONENTS }],
    outputs: [{ type: 'uint32' }],
  },
  {
    type: 'function',
    name: 'observe',
    stateMutability: 'view',
    inputs: [
      { name: 'key', type: 'tuple', components: KEY_COMPONENTS },
      { name: 'secondsAgos', type: 'uint32[]' },
    ],
    outputs: [{ type: 'int56[]' }, { type: 'uint160[]' }],
  },
] as const

function reverted(cause: unknown): boolean {
  for (let error = cause as { name?: string; cause?: unknown } | undefined; error;) {
    if (error.name === 'ContractFunctionRevertedError') return true
    error = error.cause as typeof error
  }
  return false
}

/**
 * The pool's price over `window` seconds, read from its V4 oracle hook the way the buyback hook
 * quotes: the longest retained window when coverage is partial, the arithmetic mean tick rounded
 * down. Spot only when the hook holds no observations; 0 for an uninitialized pool; any other
 * failure throws.
 */
export async function poolTwapSqrtPriceX96(
  client: Pick<PublicClient, 'readContract'>,
  chainId: number,
  key: V4PoolKey,
  window: number,
): Promise<{ sqrtPriceX96: bigint; twap: boolean }> {
  const spot = await poolSqrtPriceX96(client, chainId, key)
  // An uninitialized pool has no history either.
  if (spot === 0n) return { sqrtPriceX96: 0n, twap: false }
  const fallback = { sqrtPriceX96: spot, twap: false }
  let period = window
  try {
    const oldest = await client.readContract({
      address: key.hooks,
      abi: ORACLE_ABI,
      functionName: 'observationCoverageOf',
      args: [key],
    })
    if (oldest === 0) return fallback
    if (oldest < period) period = oldest
  } catch (cause) {
    // Hooks without coverage reporting are observed directly, as the buyback hook does.
    if (!reverted(cause)) throw cause
  }
  if (period <= 0) return fallback
  let tickCumulatives: readonly bigint[]
  try {
    [tickCumulatives] = await client.readContract({
      address: key.hooks,
      abi: ORACLE_ABI,
      functionName: 'observe',
      args: [key, [period, 0]],
    })
  } catch (cause) {
    if (!reverted(cause)) throw cause
    return fallback
  }
  const delta = tickCumulatives[1]! - tickCumulatives[0]!
  let tick = delta / BigInt(period)
  if (delta < 0n && delta % BigInt(period) !== 0n) tick -= 1n
  return { sqrtPriceX96: uniswapV4SqrtPriceX96AtTick(Number(tick)), twap: true }
}

export type PoolMove =
  { kind: 'setPoolFor' } | { kind: 'initializePoolFor'; sqrtPriceX96: bigint } | { kind: 'none' }

/**
 * An existing new pool is registered as it is (initializing it would revert on any other
 * price); otherwise it opens at the old pool's reference price. An old pool with no price has
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

const POSITION_MANAGER_ABI = parseAbi([
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function getPoolAndPositionInfo(uint256 tokenId) view returns ((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, uint256 info)',
  'function getPositionLiquidity(uint256 tokenId) view returns (uint128)',
])

export type MovablePosition = {
  tokenId: bigint
  liquidity: bigint
  tickLower: number
  tickUpper: number
}

/**
 * The position as the PositionManager holds it right now, never an index row: owned by `owner`,
 * in the `from` pool, with liquidity. A move is only ever built from this read.
 */
export async function readMovablePosition(
  client: Pick<PublicClient, 'readContract'>,
  positionManager: Address,
  tokenId: bigint,
  from: V4PoolKey,
  owner: Address,
): Promise<MovablePosition> {
  const [holder, [key, info], liquidity] = await Promise.all([
    client.readContract({
      address: positionManager,
      abi: POSITION_MANAGER_ABI,
      functionName: 'ownerOf',
      args: [tokenId],
    }),
    client.readContract({
      address: positionManager,
      abi: POSITION_MANAGER_ABI,
      functionName: 'getPoolAndPositionInfo',
      args: [tokenId],
    }),
    client.readContract({
      address: positionManager,
      abi: POSITION_MANAGER_ABI,
      functionName: 'getPositionLiquidity',
      args: [tokenId],
    }),
  ])
  if (!isAddressEqual(holder, owner))
    throw new Error('This position is no longer owned by your wallet.')
  if (uniswapV4PoolId(migratedPoolKey(key, key.hooks)) !== uniswapV4PoolId(from)) {
    throw new Error('This position is not in the old pool.')
  }
  if (liquidity <= 0n) throw new Error('This position holds no liquidity.')
  const { lower, upper } = uniswapV4PositionTicks(info)
  return { tokenId, liquidity, tickLower: lower, tickUpper: upper }
}

/** The most the new pool's price may differ from the old pool's before a move is refused, in bps. */
export const MOVE_PRICE_TOLERANCE_BPS = 100n

/** Whether two sqrtPriceX96 values are prices within `bps` of each other. */
export function pricesAgree(a: bigint, b: bigint, bps = MOVE_PRICE_TOLERANCE_BPS): boolean {
  const priceA = a * a
  const priceB = b * b
  const gap = priceA > priceB ? priceA - priceB : priceB - priceA
  return gap * 10_000n <= priceB * bps
}

/** v4-periphery `Actions`: BURN_POSITION, MINT_POSITION, TAKE_PAIR. */
const MOVE_ACTIONS = '0x030211'

export type LiquidityMovePlan = {
  unlockData: Hex
  /** Burn floors: 99% of what the position holds at the old pool's reviewed price. */
  amount0Minimum: bigint
  amount1Minimum: bigint
  /** The new position's liquidity, sized from 98% of the removed amounts at the new pool's price. */
  liquidity: bigint
  /** Mint ceilings: what that liquidity needs at the reviewed new price plus 1%, within the burn floors. */
  amount0Maximum: bigint
  amount1Maximum: bigint
}

/**
 * One `modifyLiquidities` unlock that burns a position in the old pool and mints the same band
 * in the new one, funded only by the burn. The mint ceilings bind the new pool's reviewed price,
 * and TAKE_PAIR pays the remainder and the old position's fees to the owner while reverting on any
 * debt, so the wallet never pays in.
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
}: MovablePosition & {
  to: V4PoolKey
  fromSqrtPriceX96: bigint
  toSqrtPriceX96: bigint
  owner: Address
}): LiquidityMovePlan {
  if (liquidity <= 0n) throw new Error('This position holds no liquidity.')
  if (toSqrtPriceX96 <= 0n) throw new Error('The new pool is not open yet.')
  if (!pricesAgree(toSqrtPriceX96, fromSqrtPriceX96)) {
    throw new Error("The new pool's price is off; move later.")
  }
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
  const needed = uniswapV4AmountsForLiquidity(toSqrtPriceX96, sqrtA, sqrtB, moved)
  const ceiling = (amount: bigint, floor: bigint) => {
    const padded = amount + amount / 100n + 1n
    return padded < floor ? padded : floor
  }
  const amount0Maximum = ceiling(needed.amount0, amount0Minimum)
  const amount1Maximum = ceiling(needed.amount1, amount1Minimum)
  const burn = encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'bytes' }],
    [tokenId, amount0Minimum, amount1Minimum, '0x'],
  )
  const mint = encodeAbiParameters(
    [
      { type: 'tuple', components: KEY_COMPONENTS },
      { type: 'int24' },
      { type: 'int24' },
      { type: 'uint256' },
      { type: 'uint128' },
      { type: 'uint128' },
      { type: 'address' },
      { type: 'bytes' },
    ],
    [to, tickLower, tickUpper, moved, amount0Maximum, amount1Maximum, owner, '0x'],
  )
  const takePair = encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }, { type: 'address' }],
    [to.currency0, to.currency1, owner],
  )
  return {
    unlockData: encodeAbiParameters(
      [{ type: 'bytes' }, { type: 'bytes[]' }],
      [MOVE_ACTIONS, [burn, mint, takePair]],
    ),
    amount0Minimum,
    amount1Minimum,
    liquidity: moved,
    amount0Maximum,
    amount1Maximum,
  }
}
