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
import { listedHeld } from '../support/held-chain'

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
    const [shown] = await listedHeld(SAFE, 10, m.client)
    expect(shown.state).toMatchObject({ status: 'held-no-hash', exit: true })
    await expect(shown.hold.exit(shown.state, { checkedWallet: true }, m.client as never)).resolves.toMatchObject({ released: true })
    m.sendCalls.mockResolvedValueOnce({ id: PROPOSAL })
    await expect(proposeSafeBatch(batch(3))).resolves.toBe(PROPOSAL)
    expect(m.sendCalls).toHaveBeenCalledTimes(2)
    // Proposed and pending with the Safe: another proposal waits for it.
    await expect(proposeSafeBatch(batch(4))).rejects.toThrow()
    expect(m.sendCalls).toHaveBeenCalledTimes(2)
  })

  it('never holds another batch that only shares its first call, and still refuses its own retry', async () => {
    const OTHER = `0x${'cd'.repeat(32)}` as Hex
    m.sendCalls.mockResolvedValueOnce({ id: PROPOSAL }).mockResolvedValueOnce({ id: OTHER })
    const approveThen = (intent: string, data: Hex) => ({
      chainId: 10 as const, safe: SAFE, title: 'Batch', intent,
      calls: [
        { to: TARGET, data: '0x1234' as Hex, value: 0n, label: 'Approve' },
        { to: TARGET, data, value: 0n, label: 'Act' },
      ],
    })
    await expect(proposeSafeBatch(approveThen('intent:a:test', '0xaaaa'))).resolves.toBe(PROPOSAL)
    // Another batch beginning with the same approval is its own write.
    await expect(proposeSafeBatch(approveThen('intent:b:test', '0xbbbb'))).resolves.toBe(OTHER)
    expect(m.sendCalls).toHaveBeenCalledTimes(2)
    // The first batch, pending with the Safe, is refused again.
    await expect(proposeSafeBatch(approveThen('intent:a:test', '0xaaaa'))).rejects.toThrow()
    expect(m.sendCalls).toHaveBeenCalledTimes(2)
  })

  it('refuses a batch while one the last release held under its old key (by its first call) is unresolved', async () => {
    // origin/main held a Safe batch under its own key, with the batch's first call as the hold's call; the reply was lost.
    const { writeHolds } = await import('@/lib/write-holds')
    const old = writeHolds.open({ chainId: 10, account: SAFE, safe: true, namespace: 'intent:add-liquidity:old', call: { to: TARGET, data: '0x1234', value: 0n } })
    await old.send(m.client as never, async gate => { await gate.beforeSend(); throw new Error('wallet transport disconnected') }).catch(() => null)
    m.sendCalls.mockResolvedValue({ id: PROPOSAL })
    await expect(proposeSafeBatch({ ...batch(9), intent: 'intent:liquidity:new', legacy: ['intent:add-liquidity:old'] })).rejects.toThrow()
    expect(m.sendCalls).not.toHaveBeenCalled()
  })
})

describe('a Safe batch sends what it reviewed', () => {
  it('proposes the reviewed calls even when the caller changes its array during the review', async () => {
    const { requireTransactionReview } = await import('@/lib/transaction-review')
    const request = batch(5)
    const calls = request.calls as { to: Address; data: Hex; value: bigint; label: string }[]
    vi.mocked(requireTransactionReview).mockImplementationOnce(async () => {
      calls[1].data = '0xdead'
      calls[1].value = 7n
      calls.push({ to: SAFE, data: '0xbeef', value: 0n, label: 'Added' })
    })
    m.sendCalls.mockResolvedValueOnce({ id: PROPOSAL })
    await expect(proposeSafeBatch({ ...request, intent: 'intent:reviewed-bytes:test' })).resolves.toBe(PROPOSAL)
    const reviewed = vi.mocked(requireTransactionReview).mock.calls.at(-1)![0].calls.map(({ to, data, value }) => ({ to, data, value }))
    expect(m.sendCalls.mock.calls[0][1].calls).toEqual(reviewed)
    expect(reviewed[1]).toEqual({ to: TARGET, data: `0x5678${(5).toString(16).padStart(8, '0')}`, value: 0n })
  })
})
