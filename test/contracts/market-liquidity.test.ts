import {
  uniswapV4AmountsForLiquidity,
  uniswapV4LiquidityForAmounts,
  uniswapV4SqrtPriceX96AtTick,
} from '@bananapus/nana-sdk-core/v6'
import { decodeAbiParameters, zeroAddress } from 'viem'
import { describe, expect, it } from 'vitest'
import type { MarketResult, UserLpPosition } from '@/components/project/MarketSection'
import { buildEditLiquidityPlan } from '@/lib/edit-liquidity'
import {
  buildCollectMarketFeesUnlockData,
  buildMarketEdit,
  buildMarketMint,
  groupMarketPositions,
  marketEditStillFits,
} from '@/lib/market-liquidity'

const ALICE = '0x1111111111111111111111111111111111111111'
const TOKEN = '0x2222222222222222222222222222222222222222'
const HOOK = '0x3333333333333333333333333333333333333333'

// A market at price 1 (sqrtP = 2^96): the token side sits in the ticks BELOW
// spot (pairIsC0 flips the axis, so lower ticks are higher display prices) and
// the pair side in the ticks above it, with spot's own slot skipped between them.
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
  issuance: 2,
} as Extract<MarketResult, { status: 'pool' }>
const tokenHeld = uniswapV4AmountsForLiquidity(
  sqrtP,
  uniswapV4SqrtPriceX96AtTick(-600),
  uniswapV4SqrtPriceX96AtTick(0),
  10n ** 18n,
)
const pairHeld = uniswapV4AmountsForLiquidity(
  sqrtP,
  uniswapV4SqrtPriceX96AtTick(60),
  uniswapV4SqrtPriceX96AtTick(600),
  10n ** 18n,
)
const tokenSide: UserLpPosition = {
  tokenId: 7n,
  tickLower: -600,
  tickUpper: 0,
  liquidity: 10n ** 18n,
  pairAmount: tokenHeld.amount0,
  tokenAmount: tokenHeld.amount1,
}
const pairSide: UserLpPosition = {
  tokenId: 8n,
  tickLower: 60,
  tickUpper: 600,
  liquidity: 10n ** 18n,
  pairAmount: pairHeld.amount0,
  tokenAmount: pairHeld.amount1,
}
const corridor = { floor: 0.5, ceiling: 2 }
const unlock = (data: `0x${string}`) =>
  decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], data)
const mintParams = (mint: { unlockData: `0x${string}` }) => unlock(mint.unlockData)[1][0]

describe('market mint', () => {
  it('mints both sides of the corridor in one unlock with independent amounts', () => {
    const plan = buildMarketMint({
      pool,
      tokenAmount: 10n ** 18n,
      pairAmount: 5n * 10n ** 17n,
      corridor,
      account: ALICE,
    })
    expect(plan.tokenSide).not.toBeNull()
    expect(plan.pairSide).not.toBeNull()
    expect(plan.tokenSide!.tickUpper).toBeLessThanOrEqual(0)
    expect(plan.pairSide!.tickLower).toBeGreaterThan(0)
    // Each side uses ITS amount in full (single-sided), not a ratio of the two.
    expect(plan.tokenSide!.amount1Max).toBeGreaterThanOrEqual(10n ** 18n)
    expect(plan.pairSide!.amount0Max).toBeGreaterThanOrEqual(5n * 10n ** 17n)
    expect(plan.tokenSide!.amount0Max).toBeLessThanOrEqual(1n)
    expect(plan.pairSide!.amount1Max).toBeLessThanOrEqual(1n)
    expect(plan.value).toBe(plan.tokenSide!.value + plan.pairSide!.value)
    expect(plan.erc20).toEqual([{ currency: TOKEN, max: plan.tokenSide!.amount1Max }])
    const [actions, params] = unlock(plan.unlockData)
    expect(actions).toBe('0x0202121214')
    expect(params).toHaveLength(5)
    expect(params[0]).toBe(mintParams(plan.tokenSide!))
    expect(params[1]).toBe(mintParams(plan.pairSide!))
  })

  it('omits the side spot has left and refuses an empty market', () => {
    const aboveSpot = buildMarketMint({
      pool,
      tokenAmount: 10n ** 18n,
      pairAmount: 5n * 10n ** 17n,
      corridor: { floor: 2, ceiling: 4 },
      account: ALICE,
    })
    expect(aboveSpot.tokenSide).not.toBeNull()
    expect(aboveSpot.pairSide).toBeNull()
    expect(() =>
      buildMarketMint({ pool, tokenAmount: 0n, pairAmount: 0n, corridor, account: ALICE }),
    ).toThrow(/at least one side/)
    expect(() =>
      buildMarketMint({
        pool,
        tokenAmount: 0n,
        pairAmount: 10n ** 18n,
        corridor: { floor: 2, ceiling: 4 },
        account: ALICE,
      }),
    ).toThrow(/outside the pair side/)
  })
})

describe('market grouping and edits', () => {
  it('groups two bands that meet at spot into one market and leaves the rest alone', () => {
    const lone: UserLpPosition = { ...tokenSide, tokenId: 9n, tickLower: 1200, tickUpper: 1800 }
    expect(groupMarketPositions(pool, [pairSide, lone, tokenSide])).toEqual([
      { kind: 'market', tokenSide, pairSide },
      { kind: 'single', position: lone },
    ])
    const far: UserLpPosition = { ...pairSide, tokenId: 10n, tickLower: 120 }
    expect(groupMarketPositions(pool, [tokenSide, far]).map(g => g.kind)).toEqual(['single', 'single'])
  })

  it('edits each side in place under one settlement', () => {
    const plan = buildMarketEdit({
      pool,
      sides: { tokenSide, pairSide },
      targets: { tokenAmount: tokenSide.tokenAmount * 2n, pairAmount: pairSide.pairAmount / 2n },
      corridor,
      refit: false,
      account: ALICE,
    })
    expect(plan.token?.kind).toBe('increase')
    expect(plan.pair?.kind).toBe('decrease')
    expect(plan.tokenFlow).toBeGreaterThan(0n)
    expect(plan.pairFlow).toBeLessThan(0n)
    expect(plan.pairMinimum).toBe((-plan.pairFlow * 9_500n) / 10_000n)
    expect(plan.erc20).toEqual([{ currency: TOKEN, max: plan.tokenFunding }])
    const [actions, params] = unlock(plan.unlockData)
    expect(actions).toBe('0x0001121214')
    expect(params).toHaveLength(5)
  })

  it('re-fits both sides to a moved corridor by burning and re-minting each', () => {
    const plan = buildMarketEdit({
      pool,
      sides: { tokenSide, pairSide },
      targets: { tokenAmount: tokenSide.tokenAmount, pairAmount: pairSide.pairAmount },
      corridor: { floor: 0.25, ceiling: 4 },
      refit: true,
      account: ALICE,
    })
    expect(plan.refit).toBe(true)
    expect(plan.token?.kind).toBe('move')
    expect(plan.pair?.kind).toBe('move')
    expect(plan.tokenFunding).toBe(0n)
    expect(plan.tokenFlow).toBeLessThanOrEqual(0n)
    expect(plan.pairFlow).toBeLessThanOrEqual(0n)
    const [actions, params] = unlock(plan.unlockData)
    expect(actions.startsWith('0x03020302')).toBe(true)
    expect(params.length).toBeGreaterThanOrEqual(6)
  })

  it('removes one side, keeps an unchanged side, and mints a missing side', () => {
    const removeToken = buildMarketEdit({
      pool,
      sides: { tokenSide, pairSide },
      targets: { tokenAmount: 0n, pairAmount: pairSide.pairAmount },
      corridor,
      refit: false,
      account: ALICE,
    })
    expect(removeToken.token?.kind).toBe('remove')
    expect(removeToken.pair?.kind).toBe('keep')
    expect(unlock(removeToken.unlockData)[0]).toBe('0x031212')

    const mintToken = buildMarketEdit({
      pool,
      sides: { tokenSide: null, pairSide },
      targets: { tokenAmount: 10n ** 18n, pairAmount: pairSide.pairAmount },
      corridor,
      refit: false,
      account: ALICE,
    })
    expect(mintToken.token?.kind).toBe('mint')
    expect(mintToken.token?.tokenId).toBeNull()
    expect(mintToken.pair?.kind).toBe('keep')
    expect(unlock(mintToken.unlockData)[0]).toBe('0x02121214')

    expect(() =>
      buildMarketEdit({
        pool,
        sides: { tokenSide, pairSide },
        targets: { tokenAmount: tokenSide.tokenAmount, pairAmount: pairSide.pairAmount },
        corridor,
        refit: false,
        account: ALICE,
      }),
    ).toThrow(/as it is/)
  })

  it('rechecks a reviewed market edit against live positions and price', () => {
    const plan = buildMarketEdit({
      pool,
      sides: { tokenSide, pairSide },
      targets: { tokenAmount: tokenSide.tokenAmount * 2n, pairAmount: pairSide.pairAmount },
      corridor,
      refit: false,
      account: ALICE,
    })
    const liquidityOf = (id: bigint) => (id === 7n || id === 8n ? 10n ** 18n : undefined)
    expect(marketEditStillFits(plan, { sqrtP, liquidityOf })).toBeNull()
    expect(marketEditStillFits(plan, { sqrtP, liquidityOf: () => 1n })).toMatch(/changed/)
    expect(
      marketEditStillFits(plan, { sqrtP: uniswapV4SqrtPriceX96AtTick(-300), liquidityOf }),
    ).toMatch(/price moved/)
  })

  it("claims both sides' fees with one take", () => {
    const [actions, params] = unlock(buildCollectMarketFeesUnlockData(pool, [7n, 8n], ALICE))
    expect(actions).toBe('0x010111')
    expect(params).toHaveLength(3)
  })

  it('keeps the single-position plan bytes intact after the refactor', () => {
    // Round-trip sanity: a single position edit still settles on its own.
    const held = uniswapV4AmountsForLiquidity(
      sqrtP,
      uniswapV4SqrtPriceX96AtTick(-600),
      uniswapV4SqrtPriceX96AtTick(600),
      10n ** 18n,
    )
    const liquidity = uniswapV4LiquidityForAmounts(
      sqrtP,
      uniswapV4SqrtPriceX96AtTick(-600),
      uniswapV4SqrtPriceX96AtTick(600),
      held.amount0,
      held.amount1,
    )
    const position: UserLpPosition = {
      tokenId: 42n,
      tickLower: -600,
      tickUpper: 600,
      liquidity,
      pairAmount: held.amount0,
      tokenAmount: held.amount1,
    }
    const plan = buildEditLiquidityPlan({
      pool,
      position,
      target: { pairAmount: held.amount0 / 2n, tokenAmount: held.amount1 / 2n },
      range: null,
      account: ALICE,
    })
    expect(unlock(plan.unlockData)[0]).toBe('0x0111')
  })
})
