import { describe, expect, it } from 'vitest'
import { decodeAbiParameters, type Address } from 'viem'
import {
  buildRemoveLiquidityPlan,
  outputFloor,
} from '@/components/project/MarketSection'

const OWNER = '0x00000000000000000000000000000000000000a1' as Address
const TOKEN = '0x00000000000000000000000000000000000000b2' as Address

describe('remove-liquidity planning', () => {
  it('encodes the reviewed 95% floors into BURN_POSITION + TAKE_PAIR', () => {
    const plan = buildRemoveLiquidityPlan(
      {
        tokenId: 42n,
        owner: OWNER,
        tickLower: -60,
        tickUpper: 60,
        liquidity: 1_000n,
        pair: 2_000n,
        tok: 4_000n,
      },
      {
        status: 'pool',
        hook: TOKEN,
        pair: {
          addr: '0x0000000000000000000000000000000000000000',
          tokenOrig: '0x000000000000000000000000000000000000EEEe',
          decimals: 18,
          symbol: 'ETH',
          isNative: true,
        },
        key: {
          currency0: '0x0000000000000000000000000000000000000000',
          currency1: TOKEN,
          fee: 10_000,
          tickSpacing: 60,
          hooks: TOKEN,
        },
        sqrtP: 1n,
        poolId: `0x${'11'.repeat(32)}`,
        pairIsC0: true,
        price: 1,
        issuance: null,
      },
      OWNER,
    )

    expect(plan.pairMin).toBe(1_900n)
    expect(plan.tokenMin).toBe(3_800n)
    const [actions, params] = decodeAbiParameters(
      [{ type: 'bytes' }, { type: 'bytes[]' }],
      plan.unlockData,
    )
    expect(actions).toBe('0x0311')
    const [tokenId, amount0Min, amount1Min] = decodeAbiParameters(
      [
        { type: 'uint256' },
        { type: 'uint128' },
        { type: 'uint128' },
        { type: 'bytes' },
      ],
      params[0],
    )
    expect([tokenId, amount0Min, amount1Min]).toEqual([42n, 1_900n, 3_800n])
    const [currency0, currency1, recipient] = decodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }, { type: 'address' }],
      params[1],
    )
    expect([currency0, currency1, recipient].map(value => value.toLowerCase())).toEqual([
      '0x0000000000000000000000000000000000000000',
      TOKEN,
      OWNER,
    ].map(value => value.toLowerCase()))
  })

  it('keeps a positive one-unit floor for dust outputs', () => {
    expect(outputFloor(1n)).toBe(1n)
    expect(outputFloor(0n)).toBe(0n)
  })
})
