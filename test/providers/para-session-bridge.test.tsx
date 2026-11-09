// @vitest-environment jsdom
import { createElement } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const para = vi.hoisted(() => ({
  connectAsync: vi.fn(async () => {}),
  isFullyLoggedIn: vi.fn(async () => true),
  logout: vi.fn(async () => {}),
}))

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: undefined, isConnected: false }),
  useConnect: () => ({ connectAsync: para.connectAsync, connectors: [{ id: 'para' }] }),
  useDisconnect: () => ({ disconnectAsync: async () => {} }),
}))
vi.mock('@/providers/Providers', () => ({ IS_DETERMINISTIC_BROWSER: false }))
vi.mock('@/lib/wallet-list', () => ({ offerableWallets: () => [] }))
vi.mock('@/providers/ParaAuthContext', () => ({
  markParaSession: () => {},
  useParaAuth: () => ({ modalOpen: false, requestSignIn: vi.fn(), sessionVersion: 1 }),
}))
vi.mock('@/providers/para-config', () => ({
  getParaClient: () => ({ isFullyLoggedIn: para.isFullyLoggedIn, logout: para.logout }),
}))

const { useWallet } = await import('@/hooks/useWallet')
const { ParaSessionBridge } = await import('@/providers/ParaSessionBridge')
// Loaded up front, as a page that already started Para has it: each bridge then reaches the session at once.
await import('@/providers/para-config')

const roots: TestRenderer.ReactTestRenderer[] = []
afterEach(async () => { await act(async () => { for (const root of roots.splice(0)) root.unmount() }) })
beforeEach(() => {
  para.connectAsync.mockClear()
  para.isFullyLoggedIn.mockReset().mockResolvedValue(true)
})

type Wallet = ReturnType<typeof useWallet>
function Holder({ onWallet }: { onWallet: (wallet: Wallet) => void }) {
  onWallet(useWallet())
  return null
}

function Reader() {
  useWallet()
  return null
}

describe('the Para session bridge', () => {
  it('connects a settled Para session once, however many components read the wallet', async () => {
    await act(async () => {
      roots.push(TestRenderer.create(createElement('div', null,
        createElement(ParaSessionBridge),
        createElement(Reader), createElement(Reader), createElement(Reader),
      )))
    })
    await vi.waitFor(() => expect(para.connectAsync).toHaveBeenCalled())
    expect(para.isFullyLoggedIn).toHaveBeenCalledOnce()
    expect(para.connectAsync).toHaveBeenCalledOnce()
  })

  it('does not sign a session back in when a sign-out starts during its check', async () => {
    let finish!: () => void
    para.isFullyLoggedIn.mockImplementationOnce(() => new Promise<boolean>(resolve => { finish = () => resolve(true) }))
    let wallet: Wallet | undefined
    await act(async () => {
      roots.push(TestRenderer.create(createElement('div', null, createElement(ParaSessionBridge), createElement(Holder, { onWallet: next => { wallet = next } }))))
    })
    await vi.waitFor(() => expect(para.isFullyLoggedIn).toHaveBeenCalledOnce())
    const signingOut = wallet!.disconnect()
    await act(async () => { await signingOut; finish() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(para.logout).toHaveBeenCalledOnce()
    expect(para.connectAsync).not.toHaveBeenCalled()
  })
})
