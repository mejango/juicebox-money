import { describe, expect, it } from 'vitest'
import { addLiquidityIntent, editMarketIntent, editPositionIntent, redeemItemsIntent, writeIntentKey } from '@/lib/write-intent'

const ACCOUNT = '0x1111111111111111111111111111111111111111'
const POSM = '0x2222222222222222222222222222222222222222'
const POOL_A = `0x${'aa'.repeat(32)}`
const POOL_B = `0x${'bb'.repeat(32)}`

describe('intent keys', () => {
  it('keep text case-sensitive and normalize only addresses and hex', () => {
    expect(writeIntentKey('pay', { memo: 'ABC' })).not.toBe(writeIntentKey('pay', { memo: 'abc' }))
    expect(writeIntentKey('pay', { to: ACCOUNT.toUpperCase().replace('0X', '0x') })).toBe(writeIntentKey('pay', { to: ACCOUNT }))
  })

  it('give different pools with the same ticks different adds, and the same add one key', () => {
    const add = (pool: string, pairAmount = 5n) => addLiquidityIntent({
      chainId: 10, positionManager: POSM, pool, account: ACCOUNT, market: false, pairAmount, tokenAmount: 7n, pa: 0.5, pb: 2,
    })
    expect(add(POOL_A)).not.toBe(add(POOL_B))
    expect(add(POOL_A, 6n)).not.toBe(add(POOL_A))
    expect(add(POOL_A)).toBe(add(POOL_A))
  })

  it('key an edit by its chosen targets and range', () => {
    const edit = (tokenAmount: bigint, range?: { pa: number; pb: number }) => editPositionIntent({
      chainId: 10, positionManager: POSM, pool: POOL_A, tokenId: 9n, account: ACCOUNT, tokenAmount, pairAmount: 1n, range,
    })
    expect(edit(5n)).not.toBe(edit(6n))
    expect(edit(5n)).not.toBe(edit(5n, { pa: 1, pb: 3 }))
    expect(edit(5n)).toBe(edit(5n))
    const market = (tokenAmount: bigint) => editMarketIntent({ chainId: 10, positionManager: POSM, pool: POOL_A, account: ACCOUNT, tokenAmount, pairAmount: 1n })
    expect(market(5n)).not.toBe(market(6n))
  })

  it('key a redemption by its project and collection too', () => {
    const redeem = (projectId: number, hook: string) => redeemItemsIntent({
      chainId: 10, projectId, hook, terminal: POSM, token: ACCOUNT, items: '1,2', holder: ACCOUNT,
    })
    expect(redeem(1, POSM)).not.toBe(redeem(2, POSM))
    expect(redeem(1, POSM)).not.toBe(redeem(1, ACCOUNT))
  })
})
