// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import type { Address } from 'viem'
import { HELD_RELEASE_LABEL, WRITE_HOLD_IN_TAB_LINE, type HeldWriteView } from '@bananapus/nana-sdk-core/review'

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
vi.mock('@/lib/chains', async original => ({ ...(await original<typeof import('@/lib/chains')>()), SUPPORTED_CHAINS: [{ id: 10 }] }))

import HeldWritesList from '@/components/ui/HeldWritesList'
import { WriteHeldNotice } from '@/components/ui/WriteHeldNotice'
import { writeHolds } from '@/lib/write-holds'

const ACCOUNT = '0x1111111111111111111111111111111111111111' as Address

describe('writes held outside a flow', () => {
  it('show the SDK line app-wide for the connected account, and its release releases it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const hold = writeHolds.open({ chainId: 10, account: ACCOUNT, safe: false,
        call: { to: '0x2222222222222222222222222222222222222222' as Address, data: '0x1234', value: 0n } })
      // The wallet may have sent it without saying so.
      await hold.send(client as never, async gate => { await gate.beforeSend(); throw new Error('wallet transport disconnected') }).catch(() => null)
      vi.setSystemTime(Date.now() + 31 * 60_000)
      const host = document.createElement('div')
      document.body.append(host)
      const root = createRoot(host)
      await act(async () => root.render(<HeldWritesList account={ACCOUNT} />))
      for (let i = 0; i < 5; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
      expect(host.textContent).toContain("Your earlier transaction hasn't confirmed yet. Check your wallet.")
      const release = [...host.querySelectorAll('button')].find(button => button.textContent === HELD_RELEASE_LABEL)!
      await act(async () => { release.click() })
      for (let i = 0; i < 5; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
      expect(hold.peek()).toMatchObject({ status: 'clear' })
      await act(async () => root.unmount())
    } finally {
      vi.useRealTimers()
    }
  })

  it("say when this browser can't remember them", async () => {
    const view = { line: 'Held.', notice: WRITE_HOLD_IN_TAB_LINE, state: null, exit: false } satisfies Pick<HeldWriteView, 'line' | 'notice' | 'state' | 'exit'>
    const host = document.createElement('div')
    const root = createRoot(host)
    await act(async () => root.render(<WriteHeldNotice chainId={10} view={view} />))
    expect(host.textContent).toContain(WRITE_HOLD_IN_TAB_LINE)
    await act(async () => root.unmount())
  })
})
