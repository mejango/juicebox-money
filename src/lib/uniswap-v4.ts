/**
 * Compatibility names for the app's Uniswap V4 integration. Canonical
 * deployments and math live in nana-sdk-core so every client shares the same
 * supported-chain surface and exact calculations.
 */
import {
  UNISWAP_V4_INITIALIZE_TOPIC,
  UNISWAP_V4_MODIFY_LIQUIDITY_TOPIC,
  UNISWAP_V4_POOL_MANAGER_ADDRESSES,
  UNISWAP_V4_POSITION_MANAGER_ADDRESSES,
  uniswapV4AlignTickDown,
  uniswapV4AlignTickUp,
  uniswapV4AmountsForLiquidity,
  uniswapV4CounterpartAmount,
  uniswapV4DefaultPriceRange,
  uniswapV4LiquidityForAmounts,
  uniswapV4PoolId,
  uniswapV4PoolStateSlot,
  uniswapV4PositionTicks,
  uniswapV4PositionTokenIdFromLog,
  uniswapV4PriceFromSqrtPriceX96,
  uniswapV4SqrtPriceX96AtTick,
  uniswapV4SqrtPriceX96FromSlot0,
  type UniswapV4PoolKey,
} from '@bananapus/nana-sdk-core/v6'
import { zeroAddress, type Address } from 'viem'

export const POOL_MANAGER_BY_CHAIN = UNISWAP_V4_POOL_MANAGER_ADDRESSES
export const POSITION_MANAGER_BY_CHAIN =
  UNISWAP_V4_POSITION_MANAGER_ADDRESSES
export const ZERO_ADDRESS = zeroAddress

export type PoolKey = UniswapV4PoolKey

export const computePoolId = uniswapV4PoolId
export const poolStateSlot = uniswapV4PoolStateSlot
export const sqrtPriceX96FromSlot0 = uniswapV4SqrtPriceX96FromSlot0
export const poolPriceFromSqrt = uniswapV4PriceFromSqrtPriceX96
export const sqrtAtTick = uniswapV4SqrtPriceX96AtTick
export const getAmountsForLiquidity = uniswapV4AmountsForLiquidity
export const getLiquidityForAmounts = uniswapV4LiquidityForAmounts
export const alignDown = uniswapV4AlignTickDown
export const alignUp = uniswapV4AlignTickUp
export const lpCounterpart = uniswapV4CounterpartAmount
export const lpDefaultRange = uniswapV4DefaultPriceRange
export const INITIALIZE_TOPIC = UNISWAP_V4_INITIALIZE_TOPIC
export const MODIFY_LIQUIDITY_TOPIC = UNISWAP_V4_MODIFY_LIQUIDITY_TOPIC

export interface SolvedRange {
  minPrice: number
  maxPrice: number
  /** Which end of the range stayed pinned to its reference price. */
  anchor: 'floor' | 'ceiling'
}

/**
 * Turns "I have X project tokens and Y pair tokens" into a concrete price
 * range, so depositors never have to reverse-engineer concentrated-liquidity
 * ratio math. Prices are pair tokens per project token, matching the form.
 *
 * Strategy: pin the floor at the cash-out price (the protocol's natural
 * backstop — below it, cashing out beats selling) and solve the ceiling that
 * consumes exactly the given amounts. When the token side is too heavy for ANY
 * ceiling to absorb, pin the ceiling at the issuance price (above it, paying
 * the project beats buying) and solve the floor instead. A zero on either side
 * degrades to the matching single-sided position, so every non-degenerate
 * input yields a valid range.
 */
export function solveRangeFromAmounts(inputs: {
  price: number
  tokenAmount: number
  pairAmount: number
  floorHint?: number | null
  ceilingHint?: number | null
}): SolvedRange | null {
  const { price, tokenAmount, pairAmount } = inputs
  if (!Number.isFinite(price) || price <= 0) return null
  if (!Number.isFinite(tokenAmount) || tokenAmount < 0) return null
  if (!Number.isFinite(pairAmount) || pairAmount < 0) return null
  if (tokenAmount === 0 && pairAmount === 0) return null

  const floorHint = inputs.floorHint ?? 0
  const ceilingHint = inputs.ceilingHint ?? 0
  const floor = floorHint > 0 && floorHint < price ? floorHint : price / 2
  const ceiling = ceilingHint > price ? ceilingHint : price * 2

  const sp = Math.sqrt(price)
  const sa = Math.sqrt(floor)

  if (pairAmount > 0) {
    // Floor pinned: L is fixed by the pair side, the ceiling absorbs the
    // token side. amountTok = L·(1/√p − 1/√pb) caps at L/√p as pb → ∞.
    const liquidity = pairAmount / (sp - sa)
    const inverseCeilingSqrt = 1 / sp - tokenAmount / liquidity
    if (inverseCeilingSqrt > 0) {
      const maxPrice = tokenAmount === 0 ? price : (1 / inverseCeilingSqrt) ** 2
      return { minPrice: floor, maxPrice, anchor: 'floor' }
    }
  }

  // Token side too heavy for the pinned floor (or no pair at all): pin the
  // ceiling and solve the floor. Always solvable — the solved floor lands
  // strictly between the pinned floor and spot.
  const sb = Math.sqrt(ceiling)
  const liquidity = tokenAmount / (1 / sp - 1 / sb)
  const floorSqrt = sp - pairAmount / liquidity
  const minPrice = pairAmount === 0 ? price : floorSqrt ** 2
  return { minPrice, maxPrice: ceiling, anchor: 'ceiling' }
}

/**
 * A v2-style "full range" span: nine orders of magnitude either side of spot —
 * beyond any price a market can realistically reach, so the deposit ratio
 * matches a classic v2 pool to within ~0.01% while staying inside usable tick
 * bounds at any pair decimals.
 */
export const FULL_RANGE_FACTOR = 1e9

export function fullRangeBounds(
  price: number,
): { minPrice: number; maxPrice: number } | null {
  if (!Number.isFinite(price) || price <= 0) return null
  return { minPrice: price / FULL_RANGE_FACTOR, maxPrice: price * FULL_RANGE_FACTOR }
}

/** Plain-language explanation of where the solved range landed and why. */
export function amountsModeNote(inputs: {
  tokenAmount: number
  pairAmount: number
  solved: SolvedRange | null
  floorHint?: number | null
  ceilingHint?: number | null
  tokenSymbol: string
  pairSymbol: string
}): string {
  const { tokenAmount, pairAmount, solved, tokenSymbol, pairSymbol } = inputs
  if (!solved) {
    return 'Enter what you want to deposit — the price range is set for you.'
  }
  if (tokenAmount === 0) {
    return `Only ${pairSymbol}: the position sits below the current price and buys ${tokenSymbol} as the price falls.`
  }
  if (pairAmount === 0) {
    return `Only ${tokenSymbol}: the position sits above the current price and sells into ${pairSymbol} as the price rises.`
  }
  if (solved.anchor === 'floor') {
    return inputs.floorHint && solved.minPrice === inputs.floorHint
      ? 'Floor anchored at the cash-out price — below it, cashing out beats selling.'
      : 'Floor set to half the current price (no cash-out floor available).'
  }
  return inputs.ceilingHint && solved.maxPrice === inputs.ceilingHint
    ? `Your ${tokenSymbol} side needs more room than the cash-out floor allows, so the ceiling is anchored at the issuance price instead.`
    : `Your ${tokenSymbol} side needs more room than the cash-out floor allows, so the ceiling is set to twice the current price.`
}

export function tickUpperOf(positionInfo: bigint): number {
  return uniswapV4PositionTicks(positionInfo).upper
}

export function tickLowerOf(positionInfo: bigint): number {
  return uniswapV4PositionTicks(positionInfo).lower
}

export function modifyLiquidityTokenId(
  log: { topics?: readonly (string | null)[]; data?: string },
  positionManager: Address,
): bigint | null {
  return uniswapV4PositionTokenIdFromLog(log, positionManager)
}
