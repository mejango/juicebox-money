import {
  liquidityMovePlan,
  pricesAgree,
  readMovablePosition,
  retiredPoolHooks,
  type V4PoolKey,
} from '@/lib/buyback-pool-migration'
import { decodeAbiParameters, getAddress, keccak256, zeroAddress, type Address } from 'viem'
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
  it('wallet-action:move-uniswap-v4-liquidity-to-the-new-pool burns, mints the same band on the new key and takes the pair to the owner', () => {
    const plan = liquidityMovePlan(MOVE)
    const [actions, params] = decodeAbiParameters(
      [{ type: 'bytes' }, { type: 'bytes[]' }],
      plan.unlockData,
    )
    // v4-periphery Actions: BURN_POSITION 0x03, MINT_POSITION 0x02, TAKE_PAIR 0x11.
    expect(actions).toBe('0x030211')
    expect(params).toHaveLength(3)
    expect(
      decodeAbiParameters(
        [{ type: 'address' }, { type: 'address' }, { type: 'address' }],
        params[2]!,
      ),
    ).toEqual([TO.currency0, TO.currency1, MOVE.owner])
    expect(plan.liquidity).toBeLessThan(MOVE.liquidity)
    expect(plan.liquidity).toBeGreaterThan((MOVE.liquidity * 97n) / 100n)
  })

  it('caps the mint at what its liquidity needs at the reviewed price plus 1%, within the burn', () => {
    const plan = liquidityMovePlan(MOVE)
    expect(plan.amount0Maximum).toBeLessThanOrEqual(plan.amount0Minimum)
    expect(plan.amount1Maximum).toBeLessThanOrEqual(plan.amount1Minimum)
    // 98% of the burn at the same price needs ~98%; 1% headroom keeps it under the 99% floor.
    expect(plan.amount0Maximum).toBeGreaterThan((plan.amount0Minimum * 98n) / 100n)
  })

  it('pins the unlock data both clients produce', () => {
    const plan = liquidityMovePlan(MOVE)
    expect([
      plan.amount0Minimum,
      plan.amount1Minimum,
      plan.liquidity,
      plan.amount0Maximum,
      plan.amount1Maximum,
    ]).toEqual([
      PINNED.amount0Minimum,
      PINNED.amount1Minimum,
      PINNED.liquidity,
      PINNED.amount0Maximum,
      PINNED.amount1Maximum,
    ])
    expect(keccak256(plan.unlockData)).toBe(PINNED.hash)
  })

  it('refuses a new pool priced more than 1% from the old one', () => {
    const off = (2n ** 96n * 1006n) / 1000n; // price +1.2%
    expect(() => liquidityMovePlan({ ...MOVE, toSqrtPriceX96: off })).toThrow(
      "The new pool's price is off; move later.",
    )
    expect(pricesAgree((2n ** 96n * 1004n) / 1000n, 2n ** 96n)).toBe(true); // +0.8%
  })

  it('refuses a pool that is not open, an empty position and a band off the spacing', () => {
    expect(() => liquidityMovePlan({ ...MOVE, toSqrtPriceX96: 0n })).toThrow(
      'The new pool is not open yet.',
    )
    expect(() => liquidityMovePlan({ ...MOVE, liquidity: 0n })).toThrow('no liquidity')
    expect(() => liquidityMovePlan({ ...MOVE, tickLower: -500 })).toThrow('tick spacing')
  })
})

describe('readMovablePosition', () => {
  const FROM: V4PoolKey = { ...TO, hooks: getAddress(PREVIOUS) }
  // info packs tickUpper at bits 32..55 and tickLower at bits 8..31.
  const info = (lower: number, upper: number) =>
    (BigInt.asUintN(24, BigInt(upper)) << 32n) | (BigInt.asUintN(24, BigInt(lower)) << 8n)
  const chain = ({
    owner = MOVE.owner,
    key = FROM,
    liquidity = MOVE.liquidity,
  }: {
    owner?: Address
    key?: V4PoolKey
    liquidity?: bigint
  }) => ({
    readContract: async ({ functionName }: { functionName: string }) =>
      functionName === 'ownerOf'
        ? owner
        : functionName === 'getPoolAndPositionInfo'
          ? [key, info(-600, 600)]
          : liquidity,
  })
  const read = (state: Parameters<typeof chain>[0]) =>
    readMovablePosition(chain(state) as never, zeroAddress, 7n, FROM, MOVE.owner)

  it('returns the live position', async () => {
    await expect(read({})).resolves.toEqual({
      tokenId: 7n,
      liquidity: MOVE.liquidity,
      tickLower: -600,
      tickUpper: 600,
    })
  })

  it('refuses another owner, another pool and an emptied position', async () => {
    await expect(read({ owner: CURRENT })).rejects.toThrow('no longer owned')
    await expect(read({ key: TO })).rejects.toThrow('not in the old pool')
    await expect(read({ liquidity: 0n })).rejects.toThrow('no liquidity')
  })
})

const PINNED = {
  amount0Minimum: 29257480770345798n,
  amount1Minimum: 29257480770345798n,
  liquidity: 979999999999999990n,
  amount0Maximum: 29251570168169970n,
  amount1Maximum: 29251570168169970n,
  hash: '0xb91d1a74ddbbfcaf059e0d8fc79b01a1126ae0d79b39d78e3991df587edf8dad',
}
