// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import type { Address } from 'viem'

const client = vi.hoisted(() => ({
  getChainId: async () => 10,
  getBlockNumber: async () => 100n,
  getTransactionCount: async () => 3,
  getTransaction: async () => { throw Object.assign(new Error('not found'), { name: 'TransactionNotFoundError' }) },
  getTransactionReceipt: async () => null,
  getBlock: async () => ({ number: 100n, hash: `0x${'aa'.repeat(32)}`, timestamp: 1n }),
  request: async () => null,
}))
vi.mock('@/lib/wallet-core', () => ({ publicClient: () => client }))

import { HeldWritesNotice } from '@/components/ui/HeldWritesNotice'
import { heldWritesSnapshot, sendUnderHold, writeHolds } from '@/lib/write-holds'

describe('writes held outside a flow', () => {
  it('show the hold line app-wide, and the exit releases it', async () => {
    const hold = writeHolds.open({ chainId: 10, account: '0x1111111111111111111111111111111111111111' as Address, safe: false,
      call: { to: '0x2222222222222222222222222222222222222222' as Address, data: '0x1234', value: 0n } })
    // The wallet may have sent it without saying so.
    await sendUnderHold(10, hold, client as never, async gate => { await gate.beforeSend(); throw new Error('wallet transport disconnected') }).catch(() => null)
    expect(heldWritesSnapshot()).toHaveLength(1)
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => root.render(<HeldWritesNotice />))
    expect(host.textContent).toContain("Your earlier transaction hasn't confirmed yet. Check your wallet.")
    const exit = [...host.querySelectorAll('button')].find(button => button.textContent === 'I checked my wallet. Send again')!
    await act(async () => { exit.click() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(heldWritesSnapshot()).toHaveLength(0)
    expect(hold.peek()).toMatchObject({ status: 'clear' })
    await act(async () => root.unmount())
  })
})
