import { encodeAbiParameters, keccak256, numberToHex, type Address, type Hex, type PublicClient } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { poolStateSlot } from '@/lib/uniswap-v4'

const mocks = vi.hoisted(() => ({ indexed: vi.fn() }))
vi.mock('@/lib/lp-positions-queries', () => ({ fetchIndexedLpPositions: mocks.indexed }))

import { readLpPositions, readPoolTickRanges, readUserLpPositions } from '@/components/project/MarketSection'

const PM = '0x000000000004444c5dc75cB358380D2e3dE08A90' as Address
const POOL_ID = `0x${'ab'.repeat(32)}` as Hex
const pool = {
  status: 'pool',
  poolId: POOL_ID,
  key: { tickSpacing: 60 },
  sqrtP: 1n << 96n,
  pairIsC0: true,
  pair: { decimals: 18, symbol: 'ETH' },
  price: 1,
} as unknown as Parameters<typeof readLpPositions>[2]

function clientFor(ranges: { tickLower: number; tickUpper: number; liquidity: bigint }[], spacing = 60) {
  const stateSlot = BigInt(poolStateSlot(POOL_ID))
  const slotOf = (key: number, offset: bigint) =>
    keccak256(encodeAbiParameters([{ type: 'int256' }, { type: 'uint256' }], [BigInt(key), stateSlot + offset]))
  const nets = new Map<number, bigint>()
  for (const { tickLower, tickUpper, liquidity } of ranges) {
    nets.set(tickLower, (nets.get(tickLower) ?? 0n) + liquidity)
    nets.set(tickUpper, (nets.get(tickUpper) ?? 0n) - liquidity)
  }
  const words = new Map<number, bigint>()
  const storage = new Map<Hex, Hex>()
  for (const [tick, net] of nets) {
    const compressed = Math.floor(tick / spacing)
    const word = compressed >> 8
    words.set(word, (words.get(word) ?? 0n) | (1n << BigInt(compressed & 0xff)))
    storage.set(slotOf(tick, 4n), numberToHex(BigInt.asUintN(128, net) << 128n, { size: 32 }))
  }
  for (const [word, bits] of words) storage.set(slotOf(word, 5n), numberToHex(bits, { size: 32 }))
  const readContract = vi.fn(async ({ args: [slots] }: { args: [Hex[]] }) =>
    slots.map(slot => storage.get(slot) ?? numberToHex(0n, { size: 32 })))
  // Center refuses an eth_getLogs span of 500 blocks or more.
  const request = vi.fn(async ({ params: [{ fromBlock, toBlock }] }: { params: [{ fromBlock: string; toBlock: string }] }) => {
    if (BigInt(toBlock) - BigInt(fromBlock) >= 500n) throw Object.assign(new Error('RPC request failed'), { code: -32005 })
    return []
  })
  return {
    getBlockNumber: async () => 100_000_000n,
    readContract,
    request,
  } as unknown as PublicClient & { readContract: typeof readContract; request: typeof request }
}

beforeEach(() => mocks.indexed.mockReset())

describe('pool liquidity on a pool the index has nothing for', () => {
  it('reads amounts and depth from live tick state, with no log scan', async () => {
    mocks.indexed.mockResolvedValue(null)
    const client = clientFor([
      { tickLower: -180_000, tickUpper: 60, liquidity: 5n * 10n ** 18n },
      { tickLower: -60, tickUpper: 180_000, liquidity: 7n * 10n ** 18n },
    ])
    const lp = await readLpPositions(client, 1, pool)
    expect(client.request).not.toHaveBeenCalled()
    if (lp.status !== 'positions') throw new Error(lp.status)
    expect(lp.positions.map(({ tickLower, tickUpper, liquidity }) => [tickLower, tickUpper, liquidity])).toEqual([
      [-180_000, -60, 5n * 10n ** 18n],
      [-60, 60, 12n * 10n ** 18n],
      [60, 180_000, 7n * 10n ** 18n],
    ])
    expect(lp.totalPair).toBeGreaterThan(0n)
    expect(lp.totalTok).toBeGreaterThan(0n)
    expect(lp.owners).toEqual([])
  })

  it('reads an uninitialized pool as empty', async () => {
    mocks.indexed.mockResolvedValue(null)
    expect(await readLpPositions(clientFor([]), 1, pool)).toEqual({ status: 'empty' })
  })

  it('keeps providers when the index has the positions', async () => {
    mocks.indexed.mockResolvedValue([
      { tokenId: '9', owner: `0x${'1'.repeat(40)}`, liquidity: String(10n ** 18n), tickLower: -60, tickUpper: 60 },
    ])
    const client = clientFor([])
    const lp = await readLpPositions(client, 1, pool)
    if (lp.status !== 'positions') throw new Error(lp.status)
    expect(lp.owners).toHaveLength(1)
    expect(client.readContract).not.toHaveBeenCalled()
  })

  it('stays under Center\'s request size on the narrowest tick spacing', async () => {
    const client = clientFor([{ tickLower: -1, tickUpper: 1, liquidity: 3n }], 1)
    const ranges = await readPoolTickRanges(client, PM, { poolId: POOL_ID, key: { tickSpacing: 1 } } as never)
    expect(ranges).toEqual([{ tickLower: -1, tickUpper: 1, liquidity: 3n }])
    const sizes = client.readContract.mock.calls.map(([call]) => call.args[0].length)
    expect(Math.max(...sizes)).toBeLessThanOrEqual(1_000)
  })

  it('rejects tick state that does not net to zero', async () => {
    const client = clientFor([{ tickLower: -60, tickUpper: 60, liquidity: 3n }])
    const read = client.readContract.getMockImplementation()!
    client.readContract.mockImplementation(async call => (await read(call)).map((value: Hex, index: number) =>
      index === 0 && BigInt(value) >> 128n ? numberToHex(1n << 128n, { size: 32 }) : value))
    await expect(readPoolTickRanges(client, PM, pool as never)).rejects.toThrow('does not net to zero')
  })

  it('scans a wallet\'s positions only in windows Center accepts', async () => {
    mocks.indexed.mockResolvedValue(null)
    const client = clientFor([{ tickLower: -60, tickUpper: 60, liquidity: 3n }])
    await expect(readUserLpPositions(client, 1, pool, `0x${'1'.repeat(40)}`)).rejects.toThrow('Could not verify')
    expect(client.request.mock.calls.length).toBeGreaterThan(0)
    await expect(client.request.mock.results[0].value).resolves.toEqual([])
  })

  it('skips the wallet scan on a pool with no ticks', async () => {
    mocks.indexed.mockResolvedValue(null)
    const client = clientFor([])
    expect(await readUserLpPositions(client, 1, pool, `0x${'1'.repeat(40)}`)).toEqual([])
    expect(client.request).not.toHaveBeenCalled()
  })
})
