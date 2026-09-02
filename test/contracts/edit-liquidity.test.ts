import {
  uniswapV4AmountsForLiquidity,
  uniswapV4LiquidityForAmounts,
  uniswapV4SqrtPriceX96AtTick,
} from '@bananapus/nana-sdk-core/v6'
import { decodeAbiParameters, zeroAddress } from 'viem'
import { describe, expect, it } from 'vitest'
import type { MarketResult, UserLpPosition } from '@/components/project/MarketSection'
import {
  bandPrices,
  buildEditLiquidityPlan,
  describeEditLiquidityPlan,
  editLiquidityStillFits,
} from '@/lib/edit-liquidity'
import {
  buildDecreaseLiquidityUnlockData,
  buildIncreaseLiquidityUnlockData,
  buildRemoveLiquidityUnlockData,
} from '@/lib/transaction-builders'

const ALICE = '0x1111111111111111111111111111111111111111'
const TOKEN = '0x2222222222222222222222222222222222222222'
const HOOK = '0x3333333333333333333333333333333333333333'

// A live-looking pool at price 1 (sqrtP = 2^96) with native ETH as currency0,
// and a position in a symmetric ±600-tick band whose holdings are derived from
// its liquidity the way the position scan does.
const sqrtP = 2n ** 96n
const pool = {
  status: 'pool',
  hook: HOOK,
  pair: { addr: zeroAddress, tokenOrig: zeroAddress, decimals: 18, symbol: 'ETH', isNative: true },
  key: { currency0: zeroAddress, currency1: TOKEN, fee: 3_000, tickSpacing: 60, hooks: HOOK },
  sqrtP,
  poolId: `0x${'44'.repeat(32)}`,
  pairIsC0: true,
  price: 1,
  issuance: null,
} as Extract<MarketResult, { status: 'pool' }>
const sqrtA = uniswapV4SqrtPriceX96AtTick(-600)
const sqrtB = uniswapV4SqrtPriceX96AtTick(600)
const held = uniswapV4AmountsForLiquidity(sqrtP, sqrtA, sqrtB, 10n ** 18n)
const liquidity = uniswapV4LiquidityForAmounts(sqrtP, sqrtA, sqrtB, held.amount0, held.amount1)
const position: UserLpPosition = {
  tokenId: 42n,
  tickLower: -600,
  tickUpper: 600,
  liquidity,
  pairAmount: held.amount0,
  tokenAmount: held.amount1,
}
const modifyParams = [
  { type: 'uint256' },
  { type: 'uint256' },
  { type: 'uint128' },
  { type: 'uint128' },
  { type: 'bytes' },
] as const
const unlock = (data: `0x${string}`) =>
  decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], data)

describe('LP edit plan', () => {
  it('tops up the same band with INCREASE_LIQUIDITY funded by the wallet', () => {
    const plan = buildEditLiquidityPlan({
      pool,
      position,
      target: { pairAmount: held.amount0 * 2n, tokenAmount: held.amount1 * 2n },
      range: null,
      account: ALICE,
    })
    expect(plan.kind).toBe('increase')
    expect(plan.tokenId).toBe(42n)
    expect(plan.tickLower).toBe(-600)
    expect(plan.tickUpper).toBe(600)
    expect(plan.liquidity).toBe(liquidity + plan.liquidityDelta)
    expect(plan.liquidityDelta).toBeGreaterThan(0n)
    // Targets are ceilings: the position ends up holding at most what was typed.
    expect(plan.pairHolding).toBeLessThanOrEqual(held.amount0 * 2n)
    expect(plan.tokenHolding).toBeLessThanOrEqual(held.amount1 * 2n)
    // The wallet pays the difference plus 1% headroom; native ETH is the pair.
    expect(plan.pairFlow).toBeGreaterThan(0n)
    expect(plan.tokenFlow).toBeGreaterThan(0n)
    expect(plan.pairFunding).toBe(plan.pairFlow + plan.pairFlow / 100n + 1n)
    expect(plan.tokenFunding).toBe(plan.tokenFlow + plan.tokenFlow / 100n + 1n)
    expect(plan.value).toBe(plan.pairFunding)
    expect(plan.erc20).toEqual([{ currency: TOKEN, max: plan.tokenFunding }])
    expect(plan.pairMinimum).toBe(0n)
    expect(plan.mint).toBeNull()

    const [actions, params] = unlock(plan.unlockData)
    // INCREASE_LIQUIDITY, CLOSE_CURRENCY ×2, SWEEP (native refund).
    expect(actions).toBe('0x00121214')
    expect(params).toHaveLength(4)
    const [tokenId, added, amount0Max, amount1Max] = decodeAbiParameters(modifyParams, params[0])
    expect(tokenId).toBe(42n)
    expect(added).toBe(plan.liquidityDelta)
    expect(amount0Max).toBe(plan.pairFunding)
    expect(amount1Max).toBe(plan.tokenFunding)
    expect(decodeAbiParameters([{ type: 'address' }], params[1])).toEqual([zeroAddress])
    expect(decodeAbiParameters([{ type: 'address' }], params[2])).toEqual([TOKEN])
    expect(decodeAbiParameters([{ type: 'address' }, { type: 'address' }], params[3])).toEqual([
      zeroAddress,
      ALICE,
    ])
  })

  it('frees part of the same band with DECREASE_LIQUIDITY behind 95% floors', () => {
    const plan = buildEditLiquidityPlan({
      pool,
      position,
      target: { pairAmount: held.amount0 / 2n, tokenAmount: held.amount1 / 2n },
      range: null,
      account: ALICE,
    })
    expect(plan.kind).toBe('decrease')
    expect(plan.liquidity).toBe(liquidity - plan.liquidityDelta)
    expect(plan.pairHolding).toBeLessThanOrEqual(held.amount0 / 2n)
    expect(plan.tokenHolding).toBeLessThanOrEqual(held.amount1 / 2n)
    expect(plan.pairFlow).toBeLessThan(0n)
    expect(plan.tokenFlow).toBeLessThan(0n)
    expect(plan.pairFunding).toBe(0n)
    expect(plan.tokenFunding).toBe(0n)
    expect(plan.value).toBe(0n)
    expect(plan.erc20).toEqual([])
    expect(plan.pairMinimum).toBe((-plan.pairFlow * 9_500n) / 10_000n)
    expect(plan.tokenMinimum).toBe((-plan.tokenFlow * 9_500n) / 10_000n)

    const [actions, params] = unlock(plan.unlockData)
    // DECREASE_LIQUIDITY then TAKE_PAIR.
    expect(actions).toBe('0x0111')
    expect(params).toHaveLength(2)
    const [tokenId, freed, amount0Min, amount1Min] = decodeAbiParameters(modifyParams, params[0])
    expect(tokenId).toBe(42n)
    expect(freed).toBe(plan.liquidityDelta)
    expect(amount0Min).toBe(plan.pairMinimum)
    expect(amount1Min).toBe(plan.tokenMinimum)
    expect(
      decodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'address' }], params[1]),
    ).toEqual([zeroAddress, TOKEN, ALICE])
  })

  it('routes an all-zero target to the full-exit removal', () => {
    const plan = buildEditLiquidityPlan({
      pool,
      position,
      target: { pairAmount: 0n, tokenAmount: 0n },
      range: { pa: 0.5, pb: 2 },
      account: ALICE,
    })
    expect(plan.kind).toBe('remove')
    expect(plan.liquidity).toBe(0n)
    expect(plan.pairFlow).toBe(-held.amount0)
    expect(plan.tokenFlow).toBe(-held.amount1)
    expect(plan.unlockData).toBe(
      buildRemoveLiquidityUnlockData({
        tokenId: 42n,
        currency0: zeroAddress,
        currency1: TOKEN,
        recipient: ALICE,
        amount0Min: plan.pairMinimum,
        amount1Min: plan.tokenMinimum,
      }),
    )
  })

  it('refuses a one-sided or unchanged target on an in-range band', () => {
    expect(() =>
      buildEditLiquidityPlan({
        pool,
        position,
        target: { pairAmount: held.amount0, tokenAmount: 0n },
        range: null,
        account: ALICE,
      }),
    ).toThrow(/holds both/)
    expect(() =>
      buildEditLiquidityPlan({
        pool,
        position,
        target: { pairAmount: held.amount0, tokenAmount: held.amount1 },
        range: null,
        account: ALICE,
      }),
    ).toThrow(/as it is/)
    // Holdings round-trip through liquidity with rounding; the untouched form
    // of a position whose liquidity is the onchain value must still be a no-op.
    expect(() =>
      buildEditLiquidityPlan({
        pool,
        position: { ...position, liquidity: 10n ** 18n },
        target: { pairAmount: held.amount0, tokenAmount: held.amount1 },
        range: null,
        account: ALICE,
      }),
    ).toThrow(/as it is/)
  })

  it('re-mints into a new band with wallet capital on top of the burn credit', () => {
    const plan = buildEditLiquidityPlan({
      pool,
      position,
      target: { pairAmount: held.amount0 * 3n, tokenAmount: held.amount1 * 3n },
      range: { pa: 0.5, pb: 2 },
      account: ALICE,
    })
    expect(plan.kind).toBe('move')
    expect(plan.mint).not.toBeNull()
    expect(plan.tickLower).toBe(plan.mint!.tickLower)
    expect(plan.liquidity).toBe(plan.mint!.liquidity)
    expect(plan.pairFlow).toBeGreaterThan(0n)
    expect(plan.tokenFlow).toBeGreaterThan(0n)
    // The wallet funds only what the burn does not cover, with the mint's headroom.
    expect(plan.pairFunding).toBe(plan.mint!.amount0Max - held.amount0)
    expect(plan.tokenFunding).toBe(plan.mint!.amount1Max - held.amount1)
    expect(plan.value).toBe(plan.pairFunding)
    expect(plan.erc20).toEqual([{ currency: TOKEN, max: plan.tokenFunding }])
    expect(plan.pairMinimum).toBe((held.amount0 * 9_500n) / 10_000n)
    expect(plan.tokenMinimum).toBe((held.amount1 * 9_500n) / 10_000n)

    const [actions, params] = unlock(plan.unlockData)
    // BURN_POSITION, MINT_POSITION, CLOSE_CURRENCY ×2, SWEEP (native funding refund).
    expect(actions).toBe('0x0302121214')
    expect(params).toHaveLength(5)
    const [tokenId, amount0Min, amount1Min] = decodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'bytes' }],
      params[0],
    )
    expect(tokenId).toBe(42n)
    expect(amount0Min).toBe(plan.pairMinimum)
    expect(amount1Min).toBe(plan.tokenMinimum)
    const [, mintParts] = unlock(plan.mint!.unlockData)
    expect(params[1]).toBe(mintParts[0])
  })

  it('moves a band with no wallet funding when the targets are the current holdings', () => {
    const plan = buildEditLiquidityPlan({
      pool,
      position,
      target: { pairAmount: held.amount0, tokenAmount: held.amount1 },
      range: { pa: 0.5, pb: 2 },
      account: ALICE,
    })
    expect(plan.kind).toBe('move')
    expect(plan.pairFlow).toBeLessThanOrEqual(0n)
    expect(plan.tokenFlow).toBeLessThanOrEqual(0n)
    expect(plan.pairFunding).toBe(0n)
    expect(plan.tokenFunding).toBe(0n)
    expect(plan.value).toBe(0n)
    expect(plan.erc20).toEqual([])
    const [actions, params] = unlock(plan.unlockData)
    expect(actions).toBe('0x03021212')
    expect(params).toHaveLength(4)
  })

  it('rechecks a reviewed plan against the live position and price', () => {
    const increase = buildEditLiquidityPlan({
      pool,
      position,
      target: { pairAmount: held.amount0 * 2n, tokenAmount: held.amount1 * 2n },
      range: null,
      account: ALICE,
    })
    expect(editLiquidityStillFits(increase, { sqrtP, liquidity })).toBeNull()
    expect(editLiquidityStillFits(increase, { sqrtP, liquidity: liquidity - 1n })).toMatch(
      /position changed/,
    )
    // A 3% price move pushes the token side past its 1% maximum.
    expect(
      editLiquidityStillFits(increase, { sqrtP: uniswapV4SqrtPriceX96AtTick(-300), liquidity }),
    ).toMatch(/price moved/)
    const decrease = buildEditLiquidityPlan({
      pool,
      position,
      target: { pairAmount: held.amount0 / 2n, tokenAmount: held.amount1 / 2n },
      range: null,
      account: ALICE,
    })
    // Floors are the contract's job; only the position identity is rechecked.
    expect(
      editLiquidityStillFits(decrease, { sqrtP: uniswapV4SqrtPriceX96AtTick(-300), liquidity }),
    ).toBeNull()
  })

  it('maps ticks back to display prices with min below max', () => {
    const band = bandPrices(pool, -60, 60)
    expect(band.min).toBeLessThan(band.max)
    expect(band.min).toBeCloseTo(1.0001 ** -60, 6)
    expect(band.max).toBeCloseTo(1.0001 ** 60, 6)
  })

  it('words each kind of edit from the wallet point of view', () => {
    const words = (kind: 'increase' | 'decrease' | 'move' | 'remove', flows: [bigint, bigint]) =>
      describeEditLiquidityPlan({
        kind,
        tokenId: 42n,
        tickLower: -600,
        tickUpper: 600,
        pairHolding: 10n ** 18n,
        tokenHolding: 2n * 10n ** 18n,
        tokenFlow: flows[0],
        pairFlow: flows[1],
        tokenFunding: flows[0] > 0n ? flows[0] + 1n : 0n,
        pairFunding: flows[1] > 0n ? flows[1] + 1n : 0n,
        tokenMinimum: 95n,
        pairMinimum: 95n,
        tokenSymbol: 'ART',
        pairSymbol: 'ETH',
        pairDecimals: 18,
        pairIsNative: true,
        band: '0.5 – 2 ETH/ART',
      })
    expect(words('increase', [10n ** 18n, 10n ** 18n]).lead).toMatch(
      /^Adds about 1 ART \+ 1 ETH from your wallet/,
    )
    expect(words('increase', [10n ** 18n, 10n ** 18n]).detail).toMatch(
      /authorizes up to .* — 1% price headroom; unused ETH is refunded/,
    )
    expect(words('decrease', [-(10n ** 18n), -(10n ** 18n)]).lead).toMatch(
      /^Frees about 1 ART \+ 1 ETH to your wallet/,
    )
    const move = words('move', [10n ** 18n, -(10n ** 18n)])
    expect(move.lead).toMatch(/in the 0.5 – 2 ETH\/ART band/)
    expect(move.lead).toMatch(/pulls about 1 ART and gets back about 1 ETH/)
    expect(words('remove', [-(10n ** 18n), -(10n ** 18n)]).lead).toMatch(/^Burns position #42/)
  })
})

describe('LP edit encoders', () => {
  it('pins the increase payload, with the sweep only when native value is sent', () => {
    const [actions, params] = unlock(
      buildIncreaseLiquidityUnlockData({
        tokenId: 7n,
        liquidity: 500n,
        currency0: zeroAddress,
        currency1: TOKEN,
        amount0Max: 11n,
        amount1Max: 22n,
      }),
    )
    expect(actions).toBe('0x001212')
    expect(params).toHaveLength(3)
    expect(decodeAbiParameters(modifyParams, params[0])).toEqual([7n, 500n, 11n, 22n, '0x'])
    const [withSweep, sweepParams] = unlock(
      buildIncreaseLiquidityUnlockData({
        tokenId: 7n,
        liquidity: 500n,
        currency0: zeroAddress,
        currency1: TOKEN,
        amount0Max: 11n,
        amount1Max: 22n,
        sweep: { currency: zeroAddress, recipient: ALICE },
      }),
    )
    expect(withSweep).toBe('0x00121214')
    expect(
      decodeAbiParameters([{ type: 'address' }, { type: 'address' }], sweepParams[3]),
    ).toEqual([zeroAddress, ALICE])
  })

  it('pins the decrease payload and its per-currency floors', () => {
    const [actions, params] = unlock(
      buildDecreaseLiquidityUnlockData({
        tokenId: 7n,
        liquidity: 500n,
        currency0: zeroAddress,
        currency1: TOKEN,
        recipient: ALICE,
        amount0Min: 100n,
        amount1Min: 200n,
      }),
    )
    expect(actions).toBe('0x0111')
    expect(decodeAbiParameters(modifyParams, params[0])).toEqual([7n, 500n, 100n, 200n, '0x'])
    expect(
      decodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'address' }], params[1]),
    ).toEqual([zeroAddress, TOKEN, ALICE])
  })

  it('renders an increase plan as a readable step in the review dialog', async () => {
    const { describeV4UnlockData } = await import('@/components/TransactionReviewProvider')
    const steps = describeV4UnlockData(
      buildIncreaseLiquidityUnlockData({
        tokenId: 7n,
        liquidity: 500n,
        currency0: zeroAddress,
        currency1: TOKEN,
        amount0Max: 11n,
        amount1Max: 22n,
        sweep: { currency: zeroAddress, recipient: ALICE },
      }),
    )! as Array<Record<string, unknown>>
    expect(steps).toHaveLength(4)
    expect(steps[0]).toMatchObject({
      action: 'INCREASE_LIQUIDITY',
      position: '#7',
      liquidity: 500n,
      maximumIn: { currency0: 11n, currency1: 22n },
    })
    expect(steps[3]).toMatchObject({ action: 'SWEEP', currency: zeroAddress, recipient: ALICE })
  })
})
