import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Address, Hex } from 'viem'

const SAFE = '0x1111111111111111111111111111111111111111' as Address
const TARGET = '0x2222222222222222222222222222222222222222' as Address
const PROPOSAL = `0x${'ab'.repeat(32)}` as Hex
const m = vi.hoisted(() => ({
  sendCalls: vi.fn(),
  client: {
    getChainId: async () => 10,
    getBlockNumber: async () => 100n,
    getTransactionCount: async () => 3,
    getTransaction: async () => { throw Object.assign(new Error('not found'), { name: 'TransactionNotFoundError' }) },
    getTransactionReceipt: async () => null,
    getBlock: async () => ({ number: 100n, hash: `0x${'aa'.repeat(32)}`, timestamp: 1n }),
    request: async () => null,
  },
}))
vi.mock('wagmi/actions', () => ({ sendCalls: m.sendCalls }))
vi.mock('@wagmi/core', () => ({ getAccount: () => ({ address: SAFE, chainId: 10 }) }))
vi.mock('@/providers/Providers', () => ({ wagmiConfig: {}, SUPPORTED_CHAINS: [] }))
vi.mock('@/lib/transaction-review', () => ({ requireTransactionReview: vi.fn(async () => undefined) }))
vi.mock('@/lib/wallet-core', () => ({ publicClient: () => m.client, connectedWallet: vi.fn(async () => ({ account: SAFE })) }))
vi.mock('@bananapus/nana-sdk-core/review', async original => ({
  ...await original<typeof import('@bananapus/nana-sdk-core/review')>(),
  simulateCallSequence: vi.fn(async () => undefined),
}))

import { proposeSafeBatch } from '@/lib/safe-batch-connector'
import { heldWritesSnapshot } from '@/lib/write-holds'

const batch = (deadline: number) => ({
  chainId: 10 as const, safe: SAFE, title: 'Add liquidity', intent: 'intent:add-liquidity:test',
  calls: [
    { to: TARGET, data: '0x1234' as Hex, value: 0n, label: 'Approve' },
    { to: TARGET, data: `0x5678${deadline.toString(16).padStart(8, '0')}` as Hex, value: 0n, label: 'Mint' },
  ],
})

beforeEach(() => { m.sendCalls.mockReset() })

describe('a Safe batch held by its intent', () => {
  it('proposes nothing again after a lost reply, even with regenerated deadlines, until the exit', async () => {
    m.sendCalls.mockRejectedValueOnce(new Error('wallet transport disconnected'))
    await expect(proposeSafeBatch(batch(1))).rejects.toThrow()
    await expect(proposeSafeBatch(batch(2))).rejects.toThrow()
    expect(m.sendCalls).toHaveBeenCalledOnce()
    const [shown] = heldWritesSnapshot()
    expect(shown.state).toMatchObject({ status: 'held-no-hash', exit: true })
    await expect(shown.hold.exit(shown.state, { checkedWallet: true }, m.client as never)).resolves.toMatchObject({ released: true })
    m.sendCalls.mockResolvedValueOnce({ id: PROPOSAL })
    await expect(proposeSafeBatch(batch(3))).resolves.toBe(PROPOSAL)
    expect(m.sendCalls).toHaveBeenCalledTimes(2)
    // Proposed and pending with the Safe: another proposal waits for it.
    await expect(proposeSafeBatch(batch(4))).rejects.toThrow()
    expect(m.sendCalls).toHaveBeenCalledTimes(2)
  })
})
