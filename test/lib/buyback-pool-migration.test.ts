import { liquidityMovePlan, retiredPoolHooks, type V4PoolKey } from '@/lib/buyback-pool-migration'
import { decodeAbiParameters, keccak256, zeroAddress, type Address } from 'viem'
import { describe, expect, it } from 'vitest'

// Same vectors in revnet-money's test/buyback-pool-migration.test.ts: both clients must
// hand a moving LP identical unlock data.
const CURRENT: Address = '0xB436Cedbee8F191A3860719b4B0f474434F315c8'
const PREVIOUS = '0xf70b71605f1c0a8ff7580557645bb7e29fe495c8'
const V1 = '0x5c989a282a05e967f2d291467cc6d6c4500cd5c8'
const TO: V4PoolKey = {
  currency0: zeroAddress,
  currency1: '0xF6627cF19317C33B457f77452876e6e297c4942F',
  fee: 10_000,
  tickSpacing: 200,
  hooks: CURRENT,
}
const MOVE = {
  tokenId: 7n,
  liquidity: 10n ** 18n,
  tickLower: -600,
  tickUpper: 600,
  to: TO,
  fromSqrtPriceX96: 2n ** 96n,
  toSqrtPriceX96: 2n ** 96n,
  owner: '0x0000000000000000000000000000000000000001' as Address,
}

describe('retiredPoolHooks', () => {
  it("offers nothing until the project's pool is on the current hook", () => {
    expect(retiredPoolHooks(PREVIOUS as Address, CURRENT, { v1: V1, previous: PREVIOUS })).toEqual(
      [],
    )
    expect(retiredPoolHooks(CURRENT, null, { previous: PREVIOUS })).toEqual([])
  })

  it('lists every retired hook once the pool moved', () => {
    expect(
      retiredPoolHooks(CURRENT, CURRENT, { v1: V1, previous: PREVIOUS, missing: null }),
    ).toEqual([
      '0x5c989A282A05e967F2D291467cC6d6C4500cd5C8',
      '0xf70B71605f1C0A8Ff7580557645BB7e29fE495c8',
    ])
  })
})

describe('liquidityMovePlan', () => {
  it('burns, mints the same band on the new key and closes both currencies', () => {
    const plan = liquidityMovePlan(MOVE)
    const [actions, params] = decodeAbiParameters(
      [{ type: 'bytes' }, { type: 'bytes[]' }],
      plan.unlockData,
    )
    expect(actions).toBe('0x03021212')
    expect(params).toHaveLength(4)
    expect(plan.amount0Minimum).toBe(plan.amount1Minimum)
    expect(plan.liquidity).toBeLessThan(MOVE.liquidity)
    expect(plan.liquidity).toBeGreaterThan((MOVE.liquidity * 97n) / 100n)
  })

  it('pins the unlock data both clients produce', () => {
    const plan = liquidityMovePlan(MOVE)
    expect([plan.amount0Minimum, plan.amount1Minimum, plan.liquidity]).toEqual([
      PINNED.amount0Minimum,
      PINNED.amount1Minimum,
      PINNED.liquidity,
    ])
    expect(keccak256(plan.unlockData)).toBe(PINNED.hash)
  })

  it('refuses a pool that is not open, an empty position and a band off the spacing', () => {
    expect(() => liquidityMovePlan({ ...MOVE, toSqrtPriceX96: 0n })).toThrow(
      'The new pool is not open yet.',
    )
    expect(() => liquidityMovePlan({ ...MOVE, liquidity: 0n })).toThrow('no liquidity')
    expect(() => liquidityMovePlan({ ...MOVE, tickLower: -500 })).toThrow('tick spacing')
  })
})

const PINNED = {
  amount0Minimum: 29257480770345798n,
  amount1Minimum: 29257480770345798n,
  liquidity: 979999999999999990n,
  hash: '0xb10d1143fa036df336c3bc611cb3ed121cc929202ef1488c65dd95fa9cbd435e',
}
