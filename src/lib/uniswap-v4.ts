/**
 * Pure Uniswap V4 math + address book for reading a project's buyback pool.
 * Every routine here is a line-by-line port of website/src/discover.js (the
 * hand-rolled LP reads) — the bigint Q64.96 math must stay EXACT, so it lives
 * apart from any React so it can be reasoned about (and unit-tested) on its own.
 *
 * Sources cited inline are line numbers in website/src/discover.js.
 */

import {
  encodeAbiParameters,
  keccak256,
  toEventSelector,
  type Address,
} from 'viem'

// Uniswap V4 PoolManager (singleton per chain), lowercased — source: website
// POOL_MANAGER_BY_CHAIN (~line 2726), itself from deploy-all-v6 Deploy.s.sol.
// Custodies every pool's tokens; read the buyback pool's slot0 via extsload.
export const POOL_MANAGER_BY_CHAIN: Record<number, Address> = {
  1: '0x000000000004444c5dc75cb358380d2e3de08a90',
  11155111: '0xe03a1074c86cfedd5c142c4f04f1a1536e203543',
  10: '0x9a13f98cb987694c9f086b1f5eb990eea8264ec3',
  11155420: '0x000000000004444c5dc75cb358380d2e3de08a90',
  8453: '0x498581ff718922c3f8e6a244956af099b2652b2b',
  84532: '0x05e73354cfdd6745c338b50bcfdfa3aa6fa03408',
  42161: '0x360e68faccca8ca495c1b759fd9eee466db9fb32',
  421614: '0xfb3e0c6f74eb1a21cc1da29aec80d2dfe6c9a317',
}

// Uniswap V4 PositionManager per chain, lowercased — source: website
// POSITION_MANAGER_BY_CHAIN (~line 2737). OP Sepolia (11155420) has none, so
// LP position enumeration is unavailable there (pool price still reads).
export const POSITION_MANAGER_BY_CHAIN: Record<number, Address> = {
  1: '0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e',
  11155111: '0x429ba70129df741b2ca2a85bc3a2a3328e5c09b4',
  10: '0x3c3ea4b57a46241e54610e5f022e5c45859a1017',
  8453: '0x7c5f5a4bbd8fd63184577525326123b519429bdc',
  84532: '0x4b2c77d209d3405f41a037ec6c77f7f5b8e2ca80',
  42161: '0xd88f38f930b7952f2db2432cb002e7abbf3dd869',
  421614: '0xac631556d3d4019c95769033b5e719dd77124bac',
}

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

const Q96 = 1n << 96n

export type PoolKey = {
  currency0: Address
  currency1: Address
  fee: number
  tickSpacing: number
  hooks: Address
}

// PoolKey tuple used for poolId derivation — website POOLKEY_TUPLE (~line 2805).
const POOLKEY_TUPLE = [
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
] as const

/** poolId = keccak256(abi.encode(poolKey)) — website ~line 3122 / 20741. */
export function computePoolId(key: PoolKey): `0x${string}` {
  return keccak256(
    encodeAbiParameters(POOLKEY_TUPLE, [
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
    ]),
  )
}

/** PoolManager `_pools[poolId]` state slot. POOLS_SLOT = 6 (website ~line 3123):
 *  slot = keccak256(abi.encode(poolId, 6)). slot0 lives at this base slot. */
export function poolStateSlot(poolId: `0x${string}`): `0x${string}` {
  return keccak256(
    encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [
      poolId,
      6n,
    ]),
  )
}

/** sqrtPriceX96 = low 160 bits of slot0 (website ~line 3125 / 20744). */
export function sqrtPriceX96FromSlot0(slot0: `0x${string}`): bigint {
  return BigInt(slot0) & ((1n << 160n) - 1n)
}

/**
 * Human pool price = PAIR token per project token, EXACT port of website
 * readAmmPrice (~lines 3127-3134):
 *   sp = sqrtP / 2^96 ; rawP = sp^2   (raw currency1 per currency0, base units)
 *   rawRatio = pairIsC0 ? 1/rawP : rawP
 *   human = rawRatio × 10^(18 − pairDecimals)   (project token is always 18-dec)
 * Returns null for an unpriced / non-finite pool.
 */
export function poolPriceFromSqrt(
  sqrtP: bigint,
  pairIsC0: boolean,
  pairDecimals: number,
): number | null {
  if (sqrtP <= 0n) return null
  const sp = Number(sqrtP) / Math.pow(2, 96)
  const rawP = sp * sp
  const rawRatio = pairIsC0 ? (rawP > 0 ? 1 / rawP : null) : rawP
  if (rawRatio == null) return null
  const human = rawRatio * Math.pow(10, 18 - pairDecimals)
  return Number.isFinite(human) && human > 0 ? human : null
}

/** sqrtPriceX96 at a tick — EXACT port of website lpSqrtAtTick (~line 20682),
 *  the same fixed-point ladder as Uniswap's TickMath.getSqrtRatioAtTick. */
export function sqrtAtTick(tick: number): bigint {
  tick = Math.trunc(tick)
  const absTick = tick < 0 ? -tick : tick
  if (absTick > 887272) throw new Error('tick out of range')
  let price =
    (absTick & 0x1) !== 0
      ? 0xfffcb933bd6fad37aa2d162d1a594001n
      : 1n << 128n
  if (absTick & 0x2) price = (price * 0xfff97272373d413259a46990580e213an) >> 128n
  if (absTick & 0x4) price = (price * 0xfff2e50f5f656932ef12357cf3c7fdccn) >> 128n
  if (absTick & 0x8) price = (price * 0xffe5caca7e10e4e61c3624eaa0941cd0n) >> 128n
  if (absTick & 0x10) price = (price * 0xffcb9843d60f6159c9db58835c926644n) >> 128n
  if (absTick & 0x20) price = (price * 0xff973b41fa98c081472e6896dfb254c0n) >> 128n
  if (absTick & 0x40) price = (price * 0xff2ea16466c96a3843ec78b326b52861n) >> 128n
  if (absTick & 0x80) price = (price * 0xfe5dee046a99a2a811c461f1969c3053n) >> 128n
  if (absTick & 0x100) price = (price * 0xfcbe86c7900a88aedcffc83b479aa3a4n) >> 128n
  if (absTick & 0x200) price = (price * 0xf987a7253ac413176f2b074cf7815e54n) >> 128n
  if (absTick & 0x400) price = (price * 0xf3392b0822b70005940c7a398e4b70f3n) >> 128n
  if (absTick & 0x800) price = (price * 0xe7159475a2c29b7443b29c7fa6e889d9n) >> 128n
  if (absTick & 0x1000) price = (price * 0xd097f3bdfd2022b8845ad8f792aa5825n) >> 128n
  if (absTick & 0x2000) price = (price * 0xa9f746462d870fdf8a65dc1f90e061e5n) >> 128n
  if (absTick & 0x4000) price = (price * 0x70d869a156d2a1b890bb3df62baf32f7n) >> 128n
  if (absTick & 0x8000) price = (price * 0x31be135f97d08fd981231505542fcfa6n) >> 128n
  if (absTick & 0x10000) price = (price * 0x9aa508b5b7a84e1c677de54f3e99bc9n) >> 128n
  if (absTick & 0x20000) price = (price * 0x5d6af8dedb81196699c329225ee604n) >> 128n
  if (absTick & 0x40000) price = (price * 0x2216e584f5fa1ea926041bedfe98n) >> 128n
  if (absTick & 0x80000) price = (price * 0x48a170391f7dc42444e8fa2n) >> 128n
  if (tick > 0) price = ((1n << 256n) - 1n) / price
  return (price + 0xffffffffn) >> 32n // Q128.128 -> sqrtPriceX96, round up
}

function sortPair(a: bigint, b: bigint): [bigint, bigint] {
  return a > b ? [b, a] : [a, b]
}

function amount0ForL(sa: bigint, sb: bigint, L: bigint): bigint {
  const [x, y] = sortPair(sa, sb)
  return (((L << 96n) * (y - x)) / y) / x
}

function amount1ForL(sa: bigint, sb: bigint, L: bigint): bigint {
  const [x, y] = sortPair(sa, sb)
  return (L * (y - x)) / Q96
}

/** currency0/currency1 amounts a position of liquidity L holds at the current
 *  sqrt price — EXACT port of website lpGetAmountsForLiquidity (~line 20720). */
export function getAmountsForLiquidity(
  sp: bigint,
  sa: bigint,
  sb: bigint,
  L: bigint,
): { amount0: bigint; amount1: bigint } {
  const [x, y] = sortPair(sa, sb)
  if (sp <= x) return { amount0: amount0ForL(x, y, L), amount1: 0n }
  if (sp < y)
    return { amount0: amount0ForL(sp, y, L), amount1: amount1ForL(x, sp, L) }
  return { amount0: 0n, amount1: amount1ForL(x, y, L) }
}

/** Sign-extend a 24-bit two's-complement tick (website lpSignExtend24 ~20782). */
export function signExtend24(v: bigint): number {
  return Number(v & 0x800000n ? v - 0x1000000n : v)
}

// PositionManager.positionInfo packs the ticks: tickUpper in bits [32,56),
// tickLower in bits [8,32) (website ~line 20979-20980).
export function tickUpperOf(info: bigint): number {
  return signExtend24((info >> 32n) & 0xffffffn)
}
export function tickLowerOf(info: bigint): number {
  return signExtend24((info >> 8n) & 0xffffffn)
}

// V4 PoolManager event topics — website LP_INITIALIZE_TOPIC / LP_MODIFY_LIQUIDITY_TOPIC
// (~lines 20785-20786). Both index the pool id in topic1.
export const INITIALIZE_TOPIC = toEventSelector(
  'Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)',
).toLowerCase()
export const MODIFY_LIQUIDITY_TOPIC = toEventSelector(
  'ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)',
).toLowerCase()

type RawLog = {
  topics?: (string | null)[]
  data?: string
  blockNumber?: string | bigint
}

/**
 * PositionManager NFT id (== the position salt) from a ModifyLiquidity log, or
 * null when the indexed sender isn't the configured PositionManager (positions
 * minted elsewhere reuse arbitrary salts). Port of website lpCollectPoolLogs's
 * ModifyLiquidity branch (~line 20824). Throws on a malformed log rather than
 * silently attributing bad data.
 */
export function modifyLiquidityTokenId(
  log: RawLog,
  posm: string,
): bigint | null {
  const sender = String(log.topics?.[2] ?? '')
    .slice(-40)
    .toLowerCase()
  if (sender !== posm.slice(2).toLowerCase()) return null
  const data = String(log.data ?? '')
  if (!/^0x[0-9a-fA-F]{256}$/.test(data)) {
    throw new Error('Malformed ModifyLiquidity log while reading LP positions')
  }
  // Fourth non-indexed word: the bytes32 salt == tokenId.
  const tokenId = BigInt('0x' + data.slice(194, 258))
  return tokenId > 0n ? tokenId : null
}
