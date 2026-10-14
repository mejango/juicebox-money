import { createElement } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { Address } from 'viem'
import type { WriteHoldState } from '@bananapus/nana-sdk-core/review'
import { useWriteHoldWatch } from '@/hooks/useWriteHoldWatch'
import { writeHolds } from '@/lib/write-holds'

const ACCOUNT = '0x1111111111111111111111111111111111111111' as Address
const TARGET = '0x2222222222222222222222222222222222222222' as Address
const client = {
  getChainId: async () => 10,
  getBlockNumber: async () => 100n,
  getTransactionCount: async () => 3,
  getTransaction: vi.fn(),
  getTransactionReceipt: vi.fn(),
  getBlock: vi.fn(),
  request: vi.fn(),
}

describe('useWriteHoldWatch', () => {
  it('shows an exit only from a fresh look at the chain, never from a replayed or saved state', async () => {
    const hold = writeHolds.open({ chainId: 10, account: ACCOUNT, safe: false, call: { to: TARGET, data: '0xabcd', value: 0n } })
    // A hashless hold saved earlier (the wallet may have sent it without saying so).
    await hold.send(client as never, async gate => { await gate.beforeSend(); throw new Error('wallet transport disconnected') }).catch(() => null)
    const seen: WriteHoldState[] = []
    function Harness() {
      useWriteHoldWatch(hold, client as never, state => seen.push(state))
      return null
    }
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      let renderer!: TestRenderer.ReactTestRenderer
      await act(async () => { renderer = TestRenderer.create(createElement(Harness)) })
      // Whatever the subscription replays carries no exit.
      expect(seen.every(state => state.status === 'clear' || !state.exit)).toBe(true)
      // The minute's fresh look at the chain offers it.
      await act(async () => { vi.advanceTimersByTime(60_000) })
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
      expect(seen.at(-1)).toMatchObject({ status: 'held-no-hash', exit: true })
      await act(async () => renderer.unmount())
    } finally {
      vi.useRealTimers()
    }
  })
})
