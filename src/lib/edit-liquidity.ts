import type { Address, Hex } from 'viem'
import type { MarketResult, UserLpPosition } from '@/components/project/MarketSection'
import { formatTokenAmount } from '@/lib/format'
import { buildMint, type Mint } from '@/lib/lp-mint'
import {
  buildDecreaseLiquidityUnlockData,
  buildIncreaseLiquidityUnlockData,
  buildMoveLiquidityUnlockData,
  buildRemoveLiquidityUnlockData,
  retainedFloor,
} from '@/lib/transaction-builders'
import { getAmountsForLiquidity, getLiquidityForAmounts, sqrtAtTick } from '@/lib/uniswap-v4'

type Pool = Extract<MarketResult, { status: 'pool' }>

export type EditLiquidityKind = 'increase' | 'decrease' | 'move' | 'remove'

export interface EditLiquidityPlan {
  kind: EditLiquidityKind
  tokenId: bigint
  unlockData: Hex
  /** The band the position covers after the edit — its current one unless moved. */
  tickLower: number
  tickUpper: number
  /** The position's liquidity before the edit, so a stale review is caught before sending. */
  liquidityBefore: bigint
  /** The position's liquidity after the edit; 0 once removed. */
  liquidity: bigint
  /** The liquidity added (increase) or freed (decrease); 0 for a move or removal. */
  liquidityDelta: bigint
  /** What the position holds after the edit, at the reviewed price. */
  pairHolding: bigint
  tokenHolding: bigint
  /**
   * The expected wallet flow per side at the reviewed price: positive is
   * pulled from the wallet, negative returns to it. Unclaimed fees come back
   * on top and are not counted here.
   */
  pairFlow: bigint
  tokenFlow: bigint
  /** The most the wallet can be asked for per side — the expected pull plus 1% price headroom; 0 when nothing is pulled. */
  pairFunding: bigint
  tokenFunding: bigint
  /** msg.value: the native side's funding, swept back if unused. */
  value: bigint
  /** ERC-20 sides the wallet funds; each needs a Permit2 allowance of `max`. */
  erc20: { currency: Address; max: bigint }[]
  /** Floors enforced onchain: 95% of what the burn (move, removal) or the freed portion (decrease) returns; 0 for an increase. */
  pairMinimum: bigint
  tokenMinimum: bigint
  /** The mint half of a move, for the live-price recheck before sending. */
  mint: Mint | null
  /** The maxima in currency order an increase or move is held to; 0 otherwise. */
  amount0Max: bigint
  amount1Max: bigint
}

/**
 * Edit a position in ONE transaction: set what it should hold and, optionally,
 * the band it covers. Target amounts are ceilings — the band and the current
 * price fix the ratio, so the position ends up holding at most the target on
 * each side. Which V4 actions run depends on what changed:
 *
 * - Same band, more liquidity → INCREASE_LIQUIDITY + CLOSE×2 [+ SWEEP]: the
 *   wallet funds the difference (1% price headroom in the maxima); unclaimed
 *   fees offset what it pays.
 * - Same band, less liquidity → DECREASE_LIQUIDITY + TAKE_PAIR: the freed
 *   share and unclaimed fees return to the wallet, behind 95% floors.
 * - New band → BURN_POSITION + MINT_POSITION + CLOSE×2 [+ SWEEP]: the burn's
 *   credit funds the mint inside the unlock; only the difference touches the
 *   wallet, in either direction. The part of each target the old position
 *   already covers is shaved 1% so ~1% of price drift between review and
 *   execution still fits without wallet funding, matching the plain move.
 * - Nothing on either side → the full-exit removal.
 *
 * Every path reverts as a whole if the live price outruns the reviewed
 * maxima/floors, leaving the position untouched. Pure: no wallet, no I/O.
 */
export function buildEditLiquidityPlan({
  pool,
  position,
  target,
  range,
  account,
}: {
  pool: Pool
  position: UserLpPosition
  /** What the position should hold: pair in the pair's decimals, token 18-decimal. */
  target: { pairAmount: bigint; tokenAmount: bigint }
  /** null keeps the position's own band, exactly; a range re-mints it (pair-per-token). */
  range: { pa: number; pb: number } | null
  account: Address
}): EditLiquidityPlan {
  if (target.pairAmount < 0n || target.tokenAmount < 0n) throw new Error('Enter a valid amount.')
  const { key, sqrtP, pair, pairIsC0 } = pool
  const byCurrency = (pairAmount: bigint, tokenAmount: bigint) =>
    pairIsC0
      ? { amount0: pairAmount, amount1: tokenAmount }
      : { amount0: tokenAmount, amount1: pairAmount }
  const byPair = (amounts: { amount0: bigint; amount1: bigint }) =>
    pairIsC0
      ? { pair: amounts.amount0, token: amounts.amount1 }
      : { pair: amounts.amount1, token: amounts.amount0 }
  const nativeIsC0 = pairIsC0 && pair.isNative
  const nativeIsC1 = !pairIsC0 && pair.isNative
  const nativeCurrency = pair.isNative ? (pairIsC0 ? key.currency0 : key.currency1) : null
  const base = {
    tokenId: position.tokenId,
    liquidityBefore: position.liquidity,
    pairFunding: 0n,
    tokenFunding: 0n,
    value: 0n,
    erc20: [] as { currency: Address; max: bigint }[],
    pairMinimum: 0n,
    tokenMinimum: 0n,
    mint: null,
    amount0Max: 0n,
    amount1Max: 0n,
  }

  const removal = (): EditLiquidityPlan => {
    const pairMinimum = retainedFloor(position.pairAmount)
    const tokenMinimum = retainedFloor(position.tokenAmount)
    return {
      ...base,
      kind: 'remove',
      unlockData: buildRemoveLiquidityUnlockData({
        tokenId: position.tokenId,
        currency0: key.currency0,
        currency1: key.currency1,
        recipient: account,
        amount0Min: pairIsC0 ? pairMinimum : tokenMinimum,
        amount1Min: pairIsC0 ? tokenMinimum : pairMinimum,
      }),
      tickLower: position.tickLower,
      tickUpper: position.tickUpper,
      liquidity: 0n,
      liquidityDelta: 0n,
      pairHolding: 0n,
      tokenHolding: 0n,
      pairFlow: -position.pairAmount,
      tokenFlow: -position.tokenAmount,
      pairMinimum,
      tokenMinimum,
    }
  }
  if (target.pairAmount <= 0n && target.tokenAmount <= 0n) return removal()

  if (range === null) {
    const sqrtA = sqrtAtTick(position.tickLower)
    const sqrtB = sqrtAtTick(position.tickUpper)
    const wanted = byCurrency(target.pairAmount, target.tokenAmount)
    const targetLiquidity = getLiquidityForAmounts(
      sqrtP,
      sqrtA,
      sqrtB,
      wanted.amount0,
      wanted.amount1,
    )
    if (targetLiquidity <= 0n) {
      // In range, both sides are needed: a zero on one side is not a removal
      // of the other, it is a band that cannot hold what was asked.
      throw new Error(
        target.pairAmount <= 0n || target.tokenAmount <= 0n
          ? `At the current price this band holds both ${pair.symbol} and the project token. Set both, or move the band to one side of the price to hold one of them only.`
          : 'Amounts are too small for this band.',
      )
    }
    // Holdings are derived from liquidity with rounding, so an untouched
    // target can round-trip to a liquidity a hair off the position's; that
    // is not an edit.
    const drift =
      targetLiquidity > position.liquidity
        ? targetLiquidity - position.liquidity
        : position.liquidity - targetLiquidity
    if (drift * 1_000_000n <= position.liquidity) {
      throw new Error('This leaves the position as it is.')
    }
    const holding = byPair(getAmountsForLiquidity(sqrtP, sqrtA, sqrtB, targetLiquidity))
    if (targetLiquidity > position.liquidity) {
      const delta = targetLiquidity - position.liquidity
      const required = getAmountsForLiquidity(sqrtP, sqrtA, sqrtB, delta)
      const amount0Max = required.amount0 + required.amount0 / 100n + 1n
      const amount1Max = required.amount1 + required.amount1 / 100n + 1n
      const value = nativeIsC0 ? amount0Max : nativeIsC1 ? amount1Max : 0n
      const erc20: { currency: Address; max: bigint }[] = []
      if (!nativeIsC0 && amount0Max > 1n) erc20.push({ currency: key.currency0, max: amount0Max })
      if (!nativeIsC1 && amount1Max > 1n) erc20.push({ currency: key.currency1, max: amount1Max })
      const pull = byPair(required)
      const funding = byPair({ amount0: amount0Max, amount1: amount1Max })
      return {
        ...base,
        kind: 'increase',
        unlockData: buildIncreaseLiquidityUnlockData({
          tokenId: position.tokenId,
          liquidity: delta,
          currency0: key.currency0,
          currency1: key.currency1,
          amount0Max,
          amount1Max,
          sweep:
            value > 0n && nativeCurrency
              ? { currency: nativeCurrency, recipient: account }
              : undefined,
        }),
        tickLower: position.tickLower,
        tickUpper: position.tickUpper,
        liquidity: targetLiquidity,
        liquidityDelta: delta,
        pairHolding: holding.pair,
        tokenHolding: holding.token,
        pairFlow: pull.pair,
        tokenFlow: pull.token,
        pairFunding: funding.pair,
        tokenFunding: funding.token,
        value,
        erc20,
        amount0Max,
        amount1Max,
      }
    }
    const delta = position.liquidity - targetLiquidity
    const freed = getAmountsForLiquidity(sqrtP, sqrtA, sqrtB, delta)
    const amount0Min = retainedFloor(freed.amount0)
    const amount1Min = retainedFloor(freed.amount1)
    const returned = byPair(freed)
    const minimum = byPair({ amount0: amount0Min, amount1: amount1Min })
    return {
      ...base,
      kind: 'decrease',
      unlockData: buildDecreaseLiquidityUnlockData({
        tokenId: position.tokenId,
        liquidity: delta,
        currency0: key.currency0,
        currency1: key.currency1,
        recipient: account,
        amount0Min,
        amount1Min,
      }),
      tickLower: position.tickLower,
      tickUpper: position.tickUpper,
      liquidity: targetLiquidity,
      liquidityDelta: delta,
      pairHolding: holding.pair,
      tokenHolding: holding.token,
      pairFlow: -returned.pair,
      tokenFlow: -returned.token,
      pairMinimum: minimum.pair,
      tokenMinimum: minimum.token,
    }
  }

  // A new band: burn and re-mint. The share of each target the old position
  // already covers is shaved 1% for price drift; anything beyond it is new
  // wallet capital and carries the mint's own 1% headroom instead.
  const budget = (wanted: bigint, held: bigint) => {
    const covered = wanted < held ? wanted : held
    return wanted - covered / 100n
  }
  const mint = buildMint({
    pool,
    pairAmount: budget(target.pairAmount, position.pairAmount),
    tokenAmount: budget(target.tokenAmount, position.tokenAmount),
    pa: range.pa,
    pb: range.pb,
    account,
  })
  const holding = byPair(mint.need)
  const atLeastZero = (amount: bigint) => (amount > 0n ? amount : 0n)
  const mintMax = byPair({ amount0: mint.amount0Max, amount1: mint.amount1Max })
  const pairFunding = atLeastZero(mintMax.pair - position.pairAmount)
  const tokenFunding = atLeastZero(mintMax.token - position.tokenAmount)
  const funding0 = pairIsC0 ? pairFunding : tokenFunding
  const funding1 = pairIsC0 ? tokenFunding : pairFunding
  const value = nativeIsC0 ? funding0 : nativeIsC1 ? funding1 : 0n
  const erc20: { currency: Address; max: bigint }[] = []
  if (!nativeIsC0 && funding0 > 0n) erc20.push({ currency: key.currency0, max: funding0 })
  if (!nativeIsC1 && funding1 > 0n) erc20.push({ currency: key.currency1, max: funding1 })
  const pairMinimum = retainedFloor(position.pairAmount)
  const tokenMinimum = retainedFloor(position.tokenAmount)
  return {
    ...base,
    kind: 'move',
    unlockData: buildMoveLiquidityUnlockData({
      tokenId: position.tokenId,
      currency0: key.currency0,
      currency1: key.currency1,
      amount0Min: pairIsC0 ? pairMinimum : tokenMinimum,
      amount1Min: pairIsC0 ? tokenMinimum : pairMinimum,
      mintUnlockData: mint.unlockData,
      sweep:
        value > 0n && nativeCurrency ? { currency: nativeCurrency, recipient: account } : undefined,
    }),
    tickLower: mint.tickLower,
    tickUpper: mint.tickUpper,
    liquidity: mint.liquidity,
    liquidityDelta: 0n,
    pairHolding: holding.pair,
    tokenHolding: holding.token,
    pairFlow: holding.pair - position.pairAmount,
    tokenFlow: holding.token - position.tokenAmount,
    pairFunding,
    tokenFunding,
    value,
    erc20,
    pairMinimum,
    tokenMinimum,
    mint,
    amount0Max: mint.amount0Max,
    amount1Max: mint.amount1Max,
  }
}

/**
 * Whether a reviewed plan still fits the pool: the position is unchanged and,
 * for an increase or move, the live price has not pushed the principal it
 * pulls past the reviewed maxima. Floors are enforced by the contract itself.
 */
export function editLiquidityStillFits(
  plan: EditLiquidityPlan,
  live: { sqrtP: bigint; liquidity: bigint },
): string | null {
  if (live.liquidity !== plan.liquidityBefore) {
    return 'This position changed. Review it again before sending.'
  }
  if (plan.kind !== 'move' && plan.kind !== 'increase') return null
  const required = getAmountsForLiquidity(
    live.sqrtP,
    sqrtAtTick(plan.tickLower),
    sqrtAtTick(plan.tickUpper),
    plan.kind === 'move' ? plan.liquidity : plan.liquidityDelta,
  )
  if (required.amount0 > plan.amount0Max || required.amount1 > plan.amount1Max) {
    return 'The pool price moved beyond the reviewed range. Review fresh amounts.'
  }
  return null
}

/** A position's band on the pair-per-token axis, min < max regardless of
 *  which currency the pool sorts first. */
export function bandPrices(pool: Pool, tickLower: number, tickUpper: number) {
  const display = (tick: number) => {
    const raw = Math.pow(1.0001, tick)
    return pool.pairIsC0
      ? Math.pow(10, 18 - pool.pair.decimals) / raw
      : raw * Math.pow(10, 18 - pool.pair.decimals)
  }
  const a = display(tickLower)
  const b = display(tickUpper)
  return { min: Math.min(a, b), max: Math.max(a, b) }
}

/**
 * Plain words for a reviewed position edit: what moves between the wallet and
 * the position, what the position holds afterwards, and what the wallet
 * authorizes. `band` is the resulting band on the display axis, already
 * formatted, for a move.
 */
export function describeEditLiquidityPlan(plan: {
  kind: EditLiquidityKind
  tokenId: bigint
  tickLower: number
  tickUpper: number
  pairHolding: bigint
  tokenHolding: bigint
  pairFlow: bigint
  tokenFlow: bigint
  pairFunding: bigint
  tokenFunding: bigint
  pairMinimum: bigint
  tokenMinimum: bigint
  tokenSymbol: string
  pairSymbol: string
  pairDecimals: number
  pairIsNative: boolean
  band?: string
}): { lead: string; detail: string; tech: string } {
  const token = (amount: bigint) => `${formatTokenAmount(amount, 18)} ${plan.tokenSymbol}`
  const pair = (amount: bigint) =>
    `${formatTokenAmount(amount, plan.pairDecimals)} ${plan.pairSymbol}`
  const both = (tokenAmount: bigint, pairAmount: bigint) =>
    `${token(tokenAmount)} + ${pair(pairAmount)}`
  const id = `#${plan.tokenId.toString()}`
  const holds = `about ${both(plan.tokenHolding, plan.pairHolding)}`
  const authorizing =
    plan.tokenFunding > 0n || plan.pairFunding > 0n
      ? `Your wallet authorizes up to ${[
          plan.tokenFunding > 0n ? token(plan.tokenFunding) : null,
          plan.pairFunding > 0n ? pair(plan.pairFunding) : null,
        ]
          .filter(Boolean)
          .join(' and ')} — 1% price headroom${
          plan.pairIsNative && plan.pairFunding > 0n
            ? `; unused ${plan.pairSymbol} is refunded`
            : ''
        }.`
      : null
  const floors = `At least ${both(plan.tokenMinimum, plan.pairMinimum)} is enforced onchain (95% floors).`
  const fees = 'Unclaimed fees return to your wallet in the same transaction.'

  switch (plan.kind) {
    case 'increase':
      return {
        lead: `Adds about ${both(plan.tokenFlow, plan.pairFlow)} from your wallet; position ${id} then holds ${holds}.`,
        detail: `${authorizing ?? ''} Unclaimed fees offset what your wallet pays.`.trim(),
        tech: `Uniswap V4 increase | ticks ${plan.tickLower} to ${plan.tickUpper}.`,
      }
    case 'decrease':
      return {
        lead: `Frees about ${both(-plan.tokenFlow, -plan.pairFlow)} to your wallet; position ${id} keeps ${holds}.`,
        detail: `${floors} ${fees}`,
        tech: `Uniswap V4 decrease | ticks ${plan.tickLower} to ${plan.tickUpper}.`,
      }
    case 'move': {
      const flows = [
        plan.tokenFlow > 0n
          ? `pulls about ${token(plan.tokenFlow)}`
          : plan.tokenFlow < 0n
            ? `gets back about ${token(-plan.tokenFlow)}`
            : null,
        plan.pairFlow > 0n
          ? `pulls about ${pair(plan.pairFlow)}`
          : plan.pairFlow < 0n
            ? `gets back about ${pair(-plan.pairFlow)}`
            : null,
      ].filter(Boolean)
      return {
        lead:
          `Burns position ${id} and mints a new one${plan.band ? ` in the ${plan.band} band` : ''} holding ${holds}.` +
          (flows.length ? ` Your wallet ${flows.join(' and ')}.` : ''),
        detail: `${authorizing ? `${authorizing} ` : ''}The burn funds the mint inside one transaction; ${floors.charAt(0).toLowerCase()}${floors.slice(1)} ${fees}`,
        tech: `Uniswap V4 burn + mint | ticks ${plan.tickLower} to ${plan.tickUpper}.`,
      }
    }
    case 'remove':
      return {
        lead: `Burns position ${id} and returns everything it holds — about ${both(-plan.tokenFlow, -plan.pairFlow)} — to your wallet.`,
        detail: `${floors} ${fees}`,
        tech: 'Uniswap V4 burn + take.',
      }
  }
}
