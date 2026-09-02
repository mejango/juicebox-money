import { decodeAbiParameters, type Address, type Hex } from 'viem'
import type { MarketResult, UserLpPosition } from '@/components/project/MarketSection'
import {
  closeActions,
  editOperations,
  encodeUnlock,
  mergeErc20,
  MODIFY_LIQUIDITY_PARAMS,
  takePairParams,
  type EditLiquidityKind,
  type EditOperations,
} from '@/lib/edit-liquidity'
import { bandPrices } from '@/lib/edit-liquidity'
import { buildMint, type Mint } from '@/lib/lp-mint'
import { getAmountsForLiquidity, sqrtAtTick } from '@/lib/uniswap-v4'
import { encodeAbiParameters } from 'viem'

type Pool = Extract<MarketResult, { status: 'pool' }>

// A revnet's market lives between the cash-out floor and the issuance ceiling.
// Making it means two single-sided positions: project tokens sold from spot up
// to the ceiling, pair tokens buying from spot down to the floor. Each side has
// its own liquidity, so the two amounts are independent — unlike one position,
// whose single liquidity number couples them.

/** The corridor on the display axis (pair per token). */
export interface MarketCorridor {
  floor: number
  ceiling: number
}

export interface MarketMint {
  unlockData: Hex
  /** Project tokens placed from spot up to the ceiling; null when spot is at or above it or nothing was given. */
  tokenSide: Mint | null
  /** Pair tokens placed from the floor up to spot; null when spot is at or below it or nothing was given. */
  pairSide: Mint | null
  value: bigint
  erc20: { currency: Address; max: bigint }[]
  /** Both sides' exact requirement and maxima, in currency order, for the review. */
  need: { amount0: bigint; amount1: bigint }
  amount0Max: bigint
  amount1Max: bigint
}

function requireCorridor(pool: Pool, corridor: MarketCorridor): number {
  const price = pool.price
  if (!price || !(price > 0)) throw new Error('The pool has no price yet.')
  if (!(corridor.floor > 0) || !(corridor.ceiling > corridor.floor)) {
    throw new Error('This project has no usable floor and ceiling to make a market between.')
  }
  return price
}

/** The token side's band: spot to the ceiling, or null when spot sits at or above it. */
function tokenSideRange(price: number, corridor: MarketCorridor) {
  return price < corridor.ceiling ? { pa: price, pb: corridor.ceiling } : null
}

/** The pair side's band: the floor to spot, or null when spot sits at or below it. */
function pairSideRange(price: number, corridor: MarketCorridor) {
  return price > corridor.floor ? { pa: corridor.floor, pb: price } : null
}

function mintParamsOf(mint: Mint): Hex {
  const [, parts] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], mint.unlockData)
  return parts[0]
}

/**
 * Mint the market in ONE transaction: MINT (token side) + MINT (pair side) +
 * CLOSE×2 [+ SWEEP]. Each side is a standard single-sided add, so the
 * price-side tick nudge keeps spot just outside both bands and the maxima
 * carry the usual 1% headroom. A side whose amount is zero, or whose half of
 * the corridor spot has left, is simply omitted. Pure: no wallet, no I/O.
 */
export function buildMarketMint({
  pool,
  tokenAmount,
  pairAmount,
  corridor,
  account,
}: {
  pool: Pool
  tokenAmount: bigint
  pairAmount: bigint
  corridor: MarketCorridor
  account: Address
}): MarketMint {
  const price = requireCorridor(pool, corridor)
  const tokenRange = tokenSideRange(price, corridor)
  const pairRange = pairSideRange(price, corridor)
  const tokenSide =
    tokenAmount > 0n && tokenRange
      ? buildMint({ pool, pairAmount: 0n, tokenAmount, pa: tokenRange.pa, pb: tokenRange.pb, account })
      : null
  const pairSide =
    pairAmount > 0n && pairRange
      ? buildMint({ pool, pairAmount, tokenAmount: 0n, pa: pairRange.pa, pb: pairRange.pb, account })
      : null
  if (!tokenSide && !pairSide) {
    throw new Error(
      tokenAmount <= 0n && pairAmount <= 0n
        ? 'Enter an amount for at least one side.'
        : `Spot is outside the ${tokenAmount > 0n ? 'token' : 'pair'} side of the corridor, so that side has nowhere to go.`,
    )
  }
  const sides = [tokenSide, pairSide].filter((side): side is Mint => side !== null)
  const value = sides.reduce((sum, side) => sum + side.value, 0n)
  const close = closeActions(pool, account, value)
  const sum = (pick: (side: Mint) => bigint) => sides.reduce((total, side) => total + pick(side), 0n)
  return {
    unlockData: encodeUnlock(`${'02'.repeat(sides.length)}${close.actions}`, [
      ...sides.map(mintParamsOf),
      ...close.parameters,
    ]),
    tokenSide,
    pairSide,
    value,
    erc20: mergeErc20(sides.map(side => side.erc20)),
    need: { amount0: sum(side => side.need.amount0), amount1: sum(side => side.need.amount1) },
    amount0Max: sum(side => side.amount0Max),
    amount1Max: sum(side => side.amount1Max),
  }
}

/** Two adjacent single-sided positions that together make the market, or one position on its own. */
export type PositionGroup =
  | { kind: 'market'; tokenSide: UserLpPosition; pairSide: UserLpPosition }
  | { kind: 'single'; position: UserLpPosition }

/**
 * Pair up positions whose bands meet: the mint-time spot tick sits between
 * them (its own slot may be skipped, hence a gap of up to one spacing). The
 * side with the higher display prices is the token side. Anything else lists
 * on its own.
 */
export function groupMarketPositions(pool: Pool, positions: readonly UserLpPosition[]): PositionGroup[] {
  const spacing = Number(pool.key.tickSpacing)
  const sorted = [...positions].sort((a, b) => a.tickLower - b.tickLower)
  const used = new Set<bigint>()
  const groups: PositionGroup[] = []
  for (const lower of sorted) {
    if (used.has(lower.tokenId)) continue
    const upper = sorted.find(
      candidate =>
        !used.has(candidate.tokenId) &&
        candidate.tokenId !== lower.tokenId &&
        candidate.tickLower >= lower.tickUpper &&
        candidate.tickLower - lower.tickUpper <= spacing,
    )
    if (!upper) {
      used.add(lower.tokenId)
      groups.push({ kind: 'single', position: lower })
      continue
    }
    used.add(lower.tokenId)
    used.add(upper.tokenId)
    const lowerBand = bandPrices(pool, lower.tickLower, lower.tickUpper)
    const upperBand = bandPrices(pool, upper.tickLower, upper.tickUpper)
    const lowerIsToken = lowerBand.min >= upperBand.max
    groups.push({
      kind: 'market',
      tokenSide: lowerIsToken ? lower : upper,
      pairSide: lowerIsToken ? upper : lower,
    })
  }
  return groups
}

/** A market's two sides; either may be missing (never minted, or removed). */
export interface MarketSides {
  tokenSide: UserLpPosition | null
  pairSide: UserLpPosition | null
}

export type MarketSideEditKind = EditLiquidityKind | 'mint' | 'keep'

export interface MarketSideEdit {
  kind: MarketSideEditKind
  tokenId: bigint | null
  liquidityBefore: bigint
  /** What this side holds after the edit, in its own currency. */
  holding: bigint
  /** Wallet flow in this side's currency: positive pulled, negative returned. */
  flow: bigint
  /** The most the wallet can be asked for on this side. */
  funding: bigint
  /** The 95% floor on what a burn or decrease returns. */
  minimum: bigint
  tickLower: number
  tickUpper: number
  liquidity: bigint
  liquidityDelta: bigint
  amount0Max: bigint
  amount1Max: bigint
}

export interface MarketEditPlan {
  unlockData: Hex
  token: MarketSideEdit | null
  pair: MarketSideEdit | null
  value: bigint
  erc20: { currency: Address; max: bigint }[]
  tokenFlow: bigint
  pairFlow: bigint
  tokenFunding: bigint
  pairFunding: bigint
  tokenMinimum: bigint
  pairMinimum: bigint
  tokenHolding: bigint
  pairHolding: bigint
  /** Whether both sides were re-banded to the corridor given. */
  refit: boolean
}

function sideEdit(
  kind: MarketSideEditKind,
  tokenId: bigint | null,
  ops: EditOperations,
  own: 'token' | 'pair',
): MarketSideEdit {
  return {
    kind,
    tokenId,
    liquidityBefore: ops.liquidityBefore,
    holding: own === 'token' ? ops.tokenHolding : ops.pairHolding,
    flow: own === 'token' ? ops.tokenFlow : ops.pairFlow,
    funding: own === 'token' ? ops.tokenFunding : ops.pairFunding,
    minimum: own === 'token' ? ops.tokenMinimum : ops.pairMinimum,
    tickLower: ops.tickLower,
    tickUpper: ops.tickUpper,
    liquidity: ops.liquidity,
    liquidityDelta: ops.liquidityDelta,
    amount0Max: ops.amount0Max,
    amount1Max: ops.amount1Max,
  }
}

/** A fresh single-sided mint as operations, so a missing side can join a market edit. */
function mintOperations(mint: Mint, pool: Pool): EditOperations {
  const holding = getAmountsForLiquidity(
    pool.sqrtP,
    sqrtAtTick(mint.tickLower),
    sqrtAtTick(mint.tickUpper),
    mint.liquidity,
  )
  const pairHolding = pool.pairIsC0 ? holding.amount0 : holding.amount1
  const tokenHolding = pool.pairIsC0 ? holding.amount1 : holding.amount0
  const pairMax = pool.pairIsC0 ? mint.amount0Max : mint.amount1Max
  const tokenMax = pool.pairIsC0 ? mint.amount1Max : mint.amount0Max
  return {
    kind: 'move',
    actions: '02',
    parameters: [mintParamsOf(mint)],
    tickLower: mint.tickLower,
    tickUpper: mint.tickUpper,
    liquidityBefore: 0n,
    liquidity: mint.liquidity,
    liquidityDelta: 0n,
    pairHolding,
    tokenHolding,
    pairFlow: pairHolding,
    tokenFlow: tokenHolding,
    pairFunding: pairMax > 1n ? pairMax : 0n,
    tokenFunding: tokenMax > 1n ? tokenMax : 0n,
    value: mint.value,
    erc20: mint.erc20,
    pairMinimum: 0n,
    tokenMinimum: 0n,
    mint,
    amount0Max: mint.amount0Max,
    amount1Max: mint.amount1Max,
  }
}

/**
 * Edit a market in ONE transaction. Each side is its own position, so each
 * side's target maps to its own operation — increase or decrease in place,
 * burn when set to zero, mint when the side did not exist — and the whole
 * set settles under one pair of closes. With `refit`, both existing sides are
 * burned and re-minted at the corridor given (the stage moved the floor or
 * ceiling), funded by their own burn credits plus whatever the targets add.
 */
export function buildMarketEdit({
  pool,
  sides,
  targets,
  corridor,
  refit,
  account,
}: {
  pool: Pool
  sides: MarketSides
  targets: { tokenAmount: bigint; pairAmount: bigint }
  corridor: MarketCorridor
  refit: boolean
  account: Address
}): MarketEditPlan {
  const price = requireCorridor(pool, corridor)
  const tokenRange = tokenSideRange(price, corridor)
  const pairRange = pairSideRange(price, corridor)

  const plan = (
    own: 'token' | 'pair',
    position: UserLpPosition | null,
    target: bigint,
    range: { pa: number; pb: number } | null,
  ): { edit: MarketSideEdit; ops: EditOperations | null } | null => {
    const amounts =
      own === 'token' ? { pairAmount: 0n, tokenAmount: target } : { pairAmount: target, tokenAmount: 0n }
    if (position) {
      if (target <= 0n) {
        const ops = editOperations({ pool, position, target: amounts, range: null, account })
        return { edit: sideEdit('remove', position.tokenId, ops, own), ops }
      }
      if (refit) {
        if (!range) {
          throw new Error(
            `Spot has left the ${own} side of the corridor, so that side cannot be re-fit; set it to 0 to remove it.`,
          )
        }
        const ops = editOperations({ pool, position, target: amounts, range, account })
        return { edit: sideEdit('move', position.tokenId, ops, own), ops }
      }
      try {
        const ops = editOperations({ pool, position, target: amounts, range: null, account })
        return { edit: sideEdit(ops.kind, position.tokenId, ops, own), ops }
      } catch (cause) {
        if (cause instanceof Error && /as it is/.test(cause.message)) {
          const held = own === 'token' ? position.tokenAmount : position.pairAmount
          return {
            edit: {
              kind: 'keep',
              tokenId: position.tokenId,
              liquidityBefore: position.liquidity,
              holding: held,
              flow: 0n,
              funding: 0n,
              minimum: 0n,
              tickLower: position.tickLower,
              tickUpper: position.tickUpper,
              liquidity: position.liquidity,
              liquidityDelta: 0n,
              amount0Max: 0n,
              amount1Max: 0n,
            },
            ops: null,
          }
        }
        throw cause
      }
    }
    if (target <= 0n) return null
    if (!range) {
      throw new Error(`Spot is outside the ${own} side of the corridor, so that side has nowhere to go.`)
    }
    const ops = mintOperations(buildMint({ pool, ...amounts, pa: range.pa, pb: range.pb, account }), pool)
    return { edit: sideEdit('mint', null, ops, own), ops }
  }

  const token = plan('token', sides.tokenSide, targets.tokenAmount, tokenRange)
  const pair = plan('pair', sides.pairSide, targets.pairAmount, pairRange)
  const operations = [token?.ops, pair?.ops].filter((ops): ops is EditOperations => !!ops)
  if (!operations.length) throw new Error('This leaves the market as it is.')

  const value = operations.reduce((sum, ops) => sum + ops.value, 0n)
  const close = closeActions(pool, account, value)
  const sum = (pick: (ops: EditOperations) => bigint) =>
    operations.reduce((total, ops) => total + pick(ops), 0n)
  return {
    unlockData: encodeUnlock(`${operations.map(ops => ops.actions).join('')}${close.actions}`, [
      ...operations.flatMap(ops => ops.parameters),
      ...close.parameters,
    ]),
    token: token?.edit ?? null,
    pair: pair?.edit ?? null,
    value,
    erc20: mergeErc20(operations.map(ops => ops.erc20)),
    tokenFlow: sum(ops => ops.tokenFlow),
    pairFlow: sum(ops => ops.pairFlow),
    tokenFunding: sum(ops => ops.tokenFunding),
    pairFunding: sum(ops => ops.pairFunding),
    tokenMinimum: sum(ops => ops.tokenMinimum),
    pairMinimum: sum(ops => ops.pairMinimum),
    tokenHolding: token?.edit.holding ?? 0n,
    pairHolding: pair?.edit.holding ?? 0n,
    refit,
  }
}

/**
 * Whether a reviewed market edit still fits: every existing side's position is
 * unchanged, and for each mint, move or increase the live price has not pushed
 * the principal it pulls past the reviewed maxima.
 */
export function marketEditStillFits(
  plan: MarketEditPlan,
  live: { sqrtP: bigint; liquidityOf: (tokenId: bigint) => bigint | undefined },
): string | null {
  for (const side of [plan.token, plan.pair]) {
    if (!side || side.tokenId === null) continue
    if (live.liquidityOf(side.tokenId) !== side.liquidityBefore) {
      return 'A position in this market changed. Review it again before sending.'
    }
  }
  for (const side of [plan.token, plan.pair]) {
    if (!side || (side.kind !== 'mint' && side.kind !== 'move' && side.kind !== 'increase')) continue
    const required = getAmountsForLiquidity(
      live.sqrtP,
      sqrtAtTick(side.tickLower),
      sqrtAtTick(side.tickUpper),
      side.kind === 'increase' ? side.liquidityDelta : side.liquidity,
    )
    if (required.amount0 > side.amount0Max || required.amount1 > side.amount1Max) {
      return 'The pool price moved beyond the reviewed range. Review fresh amounts.'
    }
  }
  return null
}

/**
 * Claim the fees of several positions (a market's two sides) in one unlock:
 * a zero-liquidity decrease per position, then one take of both currencies.
 */
export function buildCollectMarketFeesUnlockData(
  pool: Pool,
  tokenIds: readonly bigint[],
  recipient: Address,
): Hex {
  if (!tokenIds.length) throw new Error('No positions to claim from.')
  return encodeUnlock(`${'01'.repeat(tokenIds.length)}11`, [
    ...tokenIds.map(tokenId =>
      encodeAbiParameters(MODIFY_LIQUIDITY_PARAMS, [tokenId, 0n, 0n, 0n, '0x']),
    ),
    takePairParams(pool, recipient),
  ])
}
