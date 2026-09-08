import type { Address, Hex } from 'viem'
import type { MarketResult, UserLpPosition } from '@/components/project/MarketSection'
import { formatTokenAmount } from '@/lib/format'
import { buildMint, type Mint } from '@/lib/lp-mint'
import { decodeAbiParameters, encodeAbiParameters } from 'viem'
import { retainedFloor } from '@/lib/transaction-builders'
import { getAmountsForLiquidity, getLiquidityForAmounts, sqrtAtTick } from '@/lib/uniswap-v4'

type Pool = Extract<MarketResult, { status: 'pool' }>

export type EditLiquidityKind = 'increase' | 'decrease' | 'move' | 'remove'

const ACTION_INCREASE_LIQUIDITY = '00'
const ACTION_DECREASE_LIQUIDITY = '01'
const ACTION_MINT_POSITION = '02'
const ACTION_BURN_POSITION = '03'
const ACTION_TAKE_PAIR = '11'
const ACTION_CLOSE_CURRENCY = '12'
const ACTION_SWEEP = '14'

export const MODIFY_LIQUIDITY_PARAMS = [
  { type: 'uint256' },
  { type: 'uint256' },
  { type: 'uint128' },
  { type: 'uint128' },
  { type: 'bytes' },
] as const

export function encodeUnlock(actions: string, parameters: Hex[]): Hex {
  return encodeAbiParameters(
    [{ type: 'bytes' }, { type: 'bytes[]' }],
    [`0x${actions}` as Hex, parameters],
  )
}

/** The closing actions every wallet-funded plan ends with: settle both currencies, refund unused native value. */
export function closeActions(pool: Pool, recipient: Address, value: bigint) {
  const parameters: Hex[] = [
    encodeAbiParameters([{ type: 'address' }], [pool.key.currency0]),
    encodeAbiParameters([{ type: 'address' }], [pool.key.currency1]),
  ]
  let actions = `${ACTION_CLOSE_CURRENCY}${ACTION_CLOSE_CURRENCY}`
  if (value > 0n) {
    const nativeCurrency = pool.pairIsC0 ? pool.key.currency0 : pool.key.currency1
    parameters.push(
      encodeAbiParameters([{ type: 'address' }, { type: 'address' }], [nativeCurrency, recipient]),
    )
    actions += ACTION_SWEEP
  }
  return { actions, parameters }
}

export function takePairParams(pool: Pool, recipient: Address): Hex {
  return encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }, { type: 'address' }],
    [pool.key.currency0, pool.key.currency1, recipient],
  )
}

/** Merge per-currency wallet funding from several operations into one allowance list. */
export function mergeErc20(
  lists: Array<Array<{ currency: Address; max: bigint }>>,
): { currency: Address; max: bigint }[] {
  const byCurrency = new Map<string, { currency: Address; max: bigint }>()
  for (const list of lists) {
    for (const side of list) {
      const key = side.currency.toLowerCase()
      const current = byCurrency.get(key)
      byCurrency.set(key, { currency: side.currency, max: (current?.max ?? 0n) + side.max })
    }
  }
  return [...byCurrency.values()]
}

/**
 * One position's edit as bare V4 actions, before settlement. The single-position
 * flow settles it alone; a market edit strings several sides' operations
 * together under one pair of closes.
 */
export interface EditOperations {
  kind: EditLiquidityKind
  /** Action bytes (hex pairs, no 0x) and their parameters, settlement excluded. */
  actions: string
  parameters: Hex[]
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

export interface EditLiquidityPlan extends EditOperations {
  tokenId: bigint
  unlockData: Hex
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
export function buildEditLiquidityPlan(input: {
  pool: Pool
  position: UserLpPosition
  /** What the position should hold: pair in the pair's decimals, token 18-decimal. */
  target: { pairAmount: bigint; tokenAmount: bigint }
  /** null keeps the position's own band, exactly; a range re-mints it (pair-per-token). */
  range: { pa: number; pb: number } | null
  account: Address
}): EditLiquidityPlan {
  const ops = editOperations(input)
  const { pool, account } = input
  const unlockData =
    ops.kind === 'decrease' || ops.kind === 'remove'
      ? encodeUnlock(`${ops.actions}${ACTION_TAKE_PAIR}`, [
          ...ops.parameters,
          takePairParams(pool, account),
        ])
      : (() => {
          const close = closeActions(pool, account, ops.value)
          return encodeUnlock(`${ops.actions}${close.actions}`, [
            ...ops.parameters,
            ...close.parameters,
          ])
        })()
  return { ...ops, tokenId: input.position.tokenId, unlockData }
}

export function editOperations({
  pool,
  position,
  target,
  range,
  account,
}: {
  pool: Pool
  position: UserLpPosition
  target: { pairAmount: bigint; tokenAmount: bigint }
  range: { pa: number; pb: number } | null
  account: Address
}): EditOperations {
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

  const burnParams = (pairMinimum: bigint, tokenMinimum: bigint) =>
    encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'bytes' }],
      [
        position.tokenId,
        pairIsC0 ? pairMinimum : tokenMinimum,
        pairIsC0 ? tokenMinimum : pairMinimum,
        '0x',
      ],
    )
  const removal = (): EditOperations => {
    const pairMinimum = retainedFloor(position.pairAmount)
    const tokenMinimum = retainedFloor(position.tokenAmount)
    return {
      ...base,
      kind: 'remove',
      actions: ACTION_BURN_POSITION,
      parameters: [burnParams(pairMinimum, tokenMinimum)],
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
        actions: ACTION_INCREASE_LIQUIDITY,
        parameters: [
          encodeAbiParameters(MODIFY_LIQUIDITY_PARAMS, [
            position.tokenId,
            delta,
            amount0Max,
            amount1Max,
            '0x',
          ]),
        ],
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
      actions: ACTION_DECREASE_LIQUIDITY,
      parameters: [
        encodeAbiParameters(MODIFY_LIQUIDITY_PARAMS, [
          position.tokenId,
          delta,
          amount0Min,
          amount1Min,
          '0x',
        ]),
      ],
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
  // A single-sided mint carries a 1-wei maximum on its empty side; that dust
  // is not wallet funding and must not raise an allowance step.
  const beyondDust = (amount: bigint) => (amount > 1n ? amount : 0n)
  const mintMax = byPair({ amount0: mint.amount0Max, amount1: mint.amount1Max })
  const pairFunding = beyondDust(mintMax.pair - position.pairAmount)
  const tokenFunding = beyondDust(mintMax.token - position.tokenAmount)
  const funding0 = pairIsC0 ? pairFunding : tokenFunding
  const funding1 = pairIsC0 ? tokenFunding : pairFunding
  const value = nativeIsC0 ? funding0 : nativeIsC1 ? funding1 : 0n
  const erc20: { currency: Address; max: bigint }[] = []
  if (!nativeIsC0 && funding0 > 0n) erc20.push({ currency: key.currency0, max: funding0 })
  if (!nativeIsC1 && funding1 > 0n) erc20.push({ currency: key.currency1, max: funding1 })
  const pairMinimum = retainedFloor(position.pairAmount)
  const tokenMinimum = retainedFloor(position.tokenAmount)
  // The mint's parameters are already encoded inside the add plan; lift them
  // out rather than re-encoding the tuple here.
  const [, mintParts] = decodeAbiParameters(
    [{ type: 'bytes' }, { type: 'bytes[]' }],
    mint.unlockData,
  )
  return {
    ...base,
    kind: 'move',
    actions: `${ACTION_BURN_POSITION}${ACTION_MINT_POSITION}`,
    parameters: [burnParams(pairMinimum, tokenMinimum), mintParts[0]],
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
