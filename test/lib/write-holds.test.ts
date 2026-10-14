import { describe, expect, it, vi } from 'vitest'
import type { Address } from 'viem'
import { peekHeld, writeHolds } from '@/lib/write-holds'

const ACCOUNT = '0x1111111111111111111111111111111111111111' as Address
const TARGET = '0x2222222222222222222222222222222222222222' as Address

describe('a held write read without the chain', () => {
  it('never offers the exit: only state() and exit() do', async () => {
    const hold = writeHolds.open({ chainId: 10, account: ACCOUNT, safe: false, call: { to: TARGET, data: '0x1234', value: 0n } })
    const client = {
      getChainId: async () => 10,
      getBlockNumber: async () => 100n,
      getTransactionCount: async () => 3,
      getTransaction: vi.fn(),
      getTransactionReceipt: vi.fn(),
      getBlock: vi.fn(),
      request: vi.fn(),
    }
    // The wallet may have sent it without saying so: held with no hash.
    await hold.send(client as never, async gate => { await gate.beforeSend(); throw new Error('wallet transport disconnected') }).catch(() => null)
    expect(await hold.state(client as never)).toMatchObject({ status: 'held-no-hash', exit: true })
    expect(peekHeld(hold)).toMatchObject({ status: 'held-no-hash', exit: false })
  })
})
