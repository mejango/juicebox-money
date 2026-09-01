import type { Address } from 'viem'
import { encodeAbiParameters } from 'viem'
import type { MarketResult } from '@/components/project/MarketSection'
import {
  alignDown,
  alignUp,
  getAmountsForLiquidity,
  getLiquidityForAmounts,
  sqrtAtTick,
} from '@/lib/uniswap-v4'

/**
 * The pure half of the add-liquidity flow: sizing a Uniswap V4 MINT_POSITION
 * from a price range and deposit amounts, and encoding its unlockData. Kept
 * free of wallet and React imports so position edits and tests can build
 * mints without the flow around them.
 */

const UINT160_MAX = (1n << 160n) - 1n

type PoolContext = Extract<MarketResult, { status: 'pool' }>

/** The result of building the mint — the exact bytes and amounts that get sent. */
export type Mint = {
  unlockData: `0x${string}`
  /** msg.value: the native pair max (SWEEP refunds the excess), else 0. */
  value: bigint
  /** ERC-20 sides that need a Permit2 allowance (bounded to `max`). */
  erc20: { currency: Address; max: bigint }[]
  tickLower: number
  tickUpper: number
  liquidity: bigint
  need: { amount0: bigint; amount1: bigint }
  amount0Max: bigint
  amount1Max: bigint
}

/**
 * EXACT port of website prepareAddLiquidity (lines 21275-21356): derive the
 * ticks + liquidity from the range and deposit amounts at the live sqrt price,
 * compute the 1%-headroom maxes, and encode the modifyLiquidities unlockData
 * (MINT_POSITION 0x02, CLOSE_CURRENCY 0x12 for each currency, SWEEP 0x14 for the
 * native refund). Pure: no wallet, no I/O.
 */
export function buildMint({
  pool,
  pairAmount,
  tokenAmount,
  pa,
  pb,
  account,
}: {
  pool: PoolContext
  /** Pair-token deposit, in the pair token's own decimals. */
  pairAmount: bigint
  /** Project-token deposit, 18-decimal fixed point. */
  tokenAmount: bigint
  /** Range min, pair-per-token. */
  pa: number
  /** Range max, pair-per-token. */
  pb: number
  account: Address
}): Mint {
  const { key, sqrtP, pair, pairIsC0 } = pool
  const pairDec = pair.decimals

  // Map the pair/token deposits onto currency0/currency1 by pool ordering.
  const amount0 = pairIsC0 ? pairAmount : tokenAmount
  const amount1 = pairIsC0 ? tokenAmount : pairAmount

  const s = Number(key.tickSpacing)
  const maxUsable = Math.trunc(887272 / s) * s
  const minUsable = Math.trunc(-887272 / s) * s

  // UI range is pair-per-token (q). Pool price is raw currency1/currency0:
  //   pair=c0 → P_raw = 10^(18−pairDec)/q ; token=c0 → P_raw = q·10^(pairDec−18).
  const pRawFromQ = (q: number) =>
    pairIsC0 ? Math.pow(10, 18 - pairDec) / q : q * Math.pow(10, pairDec - 18)
  const tA = Math.log(pRawFromQ(pa)) / Math.log(1.0001)
  const tB = Math.log(pRawFromQ(pb)) / Math.log(1.0001)
  let tickLower = Math.max(minUsable, alignDown(Math.floor(Math.min(tA, tB)), s))
  let tickUpper = Math.min(maxUsable, alignUp(Math.ceil(Math.max(tA, tB)), s))
  if (tickUpper <= tickLower) tickUpper = Math.min(maxUsable, tickLower + s)

  // Single-sided deposits: keep the current price OUTSIDE the range so the
  // funded side is the only one the position needs (website lines 21303-21311).
  const curTick = Math.floor(
    (2 * Math.log(Number(sqrtP) / Math.pow(2, 96))) / Math.log(1.0001),
  )
  if (amount1 <= 0n && amount0 > 0n && curTick >= tickLower) {
    tickLower = Math.min(maxUsable, alignUp(curTick + 1, s))
  }
  if (amount0 <= 0n && amount1 > 0n && curTick < tickUpper) {
    tickUpper = Math.max(minUsable, alignDown(curTick, s))
  }
  if (tickUpper <= tickLower) tickUpper = Math.min(maxUsable, tickLower + s)

  const sqrtA = sqrtAtTick(tickLower)
  const sqrtB = sqrtAtTick(tickUpper)
  const liquidity = getLiquidityForAmounts(sqrtP, sqrtA, sqrtB, amount0, amount1)
  if (liquidity <= 0n) throw new Error('Amounts too small for this range')
  const need = getAmountsForLiquidity(sqrtP, sqrtA, sqrtB, liquidity)
  // 1% headroom over the exact requirement (SWEEP refunds unused native;
  // Permit2/CLOSE pull the exact ERC-20).
  const amount0Max = need.amount0 + need.amount0 / 100n + 1n
  const amount1Max = need.amount1 + need.amount1 / 100n + 1n

  const c0Native = pairIsC0 && pair.isNative
  const c1Native = !pairIsC0 && pair.isNative
  const value = c0Native ? amount0Max : c1Native ? amount1Max : 0n
  const erc20: { currency: Address; max: bigint }[] = []
  if (!c0Native && amount0Max > 1n) {
    erc20.push({ currency: key.currency0, max: amount0Max })
  }
  if (!c1Native && amount1Max > 1n) {
    erc20.push({ currency: key.currency1, max: amount1Max })
  }
  for (const side of erc20) {
    if (side.max > UINT160_MAX) {
      throw new Error('Amount is too large for Permit2.')
    }
  }

  const mintParams = encodeAbiParameters(
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
      // uint24 fee and int24 tickSpacing/ticks are <=48-bit, so viem's encoder
      // takes plain numbers here (not bigint).
      [key.currency0, key.currency1, Number(key.fee), Number(key.tickSpacing), key.hooks],
      tickLower,
      tickUpper,
      liquidity,
      amount0Max,
      amount1Max,
      account,
      '0x',
    ],
  )
  const closeC0 = encodeAbiParameters([{ type: 'address' }], [key.currency0])
  const closeC1 = encodeAbiParameters([{ type: 'address' }], [key.currency1])
  const parts: `0x${string}`[] = [mintParams, closeC0, closeC1]
  let actions: `0x${string}` = '0x021212' // MINT_POSITION, CLOSE(c0), CLOSE(c1)
  if (pair.isNative) {
    // Refund unused native (sent as msg.value) to the user. ERC-20 sides need
    // no sweep — CLOSE pulls the exact amount via Permit2.
    const nativeCur = c0Native ? key.currency0 : key.currency1
    parts.push(
      encodeAbiParameters(
        [{ type: 'address' }, { type: 'address' }],
        [nativeCur, account],
      ),
    )
    actions = '0x02121214' // … + SWEEP(native)
  }
  const unlockData = encodeAbiParameters(
    [{ type: 'bytes' }, { type: 'bytes[]' }],
    [actions, parts],
  )

  return {
    unlockData,
    value,
    erc20,
    tickLower,
    tickUpper,
    liquidity,
    need,
    amount0Max,
    amount1Max,
  }
}

