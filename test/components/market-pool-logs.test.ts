import { describe, expect, it, vi } from 'vitest'
import type { PublicClient } from 'viem'
import { getPoolLogs } from '@/components/project/MarketSection'
import { INITIALIZE_TOPIC, MODIFY_LIQUIDITY_TOPIC } from '@/lib/uniswap-v4'

const PM = '0x1111111111111111111111111111111111111111'
const POOL = `0x${'ab'.repeat(32)}` as const

describe("the market's pool log scan", () => {
  it("reads the pool manager's Initialize and ModifyLiquidity logs for one pool over one block range, through the public client", async () => {
    const request = vi.fn(async () => [])
    const client = { request } as unknown as PublicClient
    await getPoolLogs(client, PM, POOL, 16n, 255n, false)
    await getPoolLogs(client, PM, POOL, 16n, 255n, true)
    expect(request.mock.calls).toEqual([
      [{ method: 'eth_getLogs', params: [{ address: PM, topics: [[INITIALIZE_TOPIC, MODIFY_LIQUIDITY_TOPIC], POOL], fromBlock: '0x10', toBlock: '0xff' }] }],
      [{ method: 'eth_getLogs', params: [{ address: PM, topics: [INITIALIZE_TOPIC, POOL], fromBlock: '0x10', toBlock: '0xff' }] }],
    ])
  })
})
