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
