// @vitest-environment jsdom
import { createElement } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const para = vi.hoisted(() => ({
  logout: vi.fn(async () => {}),
  loggedIn: true,
  detectionFailure: false,
  marked: [] as boolean[],
  wagmiDisconnected: 0,
  connectorId: 'injected' as string,
  localFailure: false,
  events: [] as string[],
}))

vi.mock('wagmi', () => ({
  useAccount: () => ({
    address: '0x1234567890abcdef1234567890abcdef12345678',
    connector: { id: para.connectorId },
    isConnected: true,
  }),
  useConnect: () => ({ connectAsync: vi.fn(), connectors: [] }),
  useDisconnect: () => ({
    disconnectAsync: async () => {
      if (para.localFailure) throw new Error('Local reset failed')
      para.events.push('disconnect')
      para.wagmiDisconnected += 1
    },
  }),
}))

vi.mock('@/providers/Providers', () => ({ IS_DETERMINISTIC_BROWSER: false }))
vi.mock('@/lib/wallet-list', () => ({ offerableWallets: () => [] }))
vi.mock('@/providers/ParaAuthContext', () => ({
  markParaSession: (active: boolean) => { para.events.push('marker'); para.marked.push(active) },
  useParaAuth: () => ({
    modalOpen: false,
    requestSignIn: vi.fn(),
    sessionVersion: 1,
  }),
}))
vi.mock('@/providers/para-config', () => ({
  getParaClient: () => ({
    isFullyLoggedIn: async () => { if (para.detectionFailure) throw new Error('Session unavailable'); return para.loggedIn },
    logout: para.logout,
  }),
}))

const { useWallet } = await import('@/hooks/useWallet')

/** A hook needs a component around it; this is the smallest one that hands its result back. */
const roots: TestRenderer.ReactTestRenderer[] = []
afterEach(async () => { await act(async () => { for (const root of roots.splice(0)) root.unmount() }) })
async function walletHook() {
  let wallet: ReturnType<typeof useWallet> | undefined
  function Probe() {
    wallet = useWallet()
    return null
  }
  await act(async () => {
    roots.push(TestRenderer.create(createElement(Probe)))
  })
  return wallet!
}
async function disconnectOnce() {
  const wallet = await walletHook()
  await act(async () => { await wallet.disconnect() })
}

beforeEach(() => {
  para.logout.mockReset()
  para.logout.mockImplementation(async () => { para.events.push('logout') })
  para.detectionFailure = false
  para.localFailure = false
  para.events.length = 0
  para.marked.length = 0
  para.wagmiDisconnected = 0
  para.loggedIn = true
  para.connectorId = 'injected'
})

describe('disconnecting', () => {
  it('keeps session detection failures unknown, retaining local state until retry succeeds', async () => {
    para.detectionFailure = true
    const wallet = await walletHook()
    await act(async () => { await expect(wallet.disconnect()).rejects.toThrow('Your session is still connected') })
    expect(para.logout).not.toHaveBeenCalled()
    expect(para.wagmiDisconnected).toBe(0)
    expect(para.marked).toEqual([])
    para.detectionFailure = false
    await act(async () => { await wallet.disconnect() })
    expect(para.wagmiDisconnected).toBe(1)
    expect(para.marked).toEqual([false])
  })

  it('preserves the connection and marker when authoritative logout fails, then supports retry', async () => {
    para.logout.mockRejectedValueOnce(new Error('Para unavailable'))
    const wallet = await walletHook()
    await act(async () => { await expect(wallet.disconnect()).rejects.toThrow('Your session is still connected') })
    expect(para.wagmiDisconnected).toBe(0)
    expect(para.marked).toEqual([])
    await act(async () => { await wallet.disconnect() })
    expect(para.logout).toHaveBeenCalledTimes(2)
    expect(para.wagmiDisconnected).toBe(1)
    expect(para.marked).toEqual([false])
  })

  it('deduplicates a pending sign-out and keeps state until Para confirms', async () => {
    let complete!: () => void
    para.logout.mockImplementationOnce(() => new Promise<void>(resolve => { complete = resolve }))
    const wallet = await walletHook()
    const first = wallet.disconnect()
    const second = wallet.disconnect()
    expect(first).toBe(second)
    await vi.waitFor(() => expect(para.logout).toHaveBeenCalledOnce())
    expect(para.wagmiDisconnected).toBe(0)
    expect(para.marked).toEqual([])
    await act(async () => { complete(); await first })
    expect(para.wagmiDisconnected).toBe(1)
  })

  it('distinguishes a failed local reset after confirmed logout', async () => {
    para.localFailure = true
    await expect(disconnectOnce()).rejects.toThrow('You signed out, but the local wallet state did not reset')
    expect(para.marked).toEqual([false])
    expect(para.logout).toHaveBeenCalledOnce()
  })

  it('ends a Para session whatever the connector calls itself', async () => {
    // The old check keyed on `connector.id === 'para'`. An email sign-in whose
    // connector read as anything else left the session alive — and the bridge
    // effect, which exists to pick a live session up, signed the visitor
    // straight back in.
    await disconnectOnce()
    await vi.waitFor(() => expect(para.logout).toHaveBeenCalled())
    expect(para.wagmiDisconnected).toBe(1)
    expect(para.marked).toEqual([false])
    expect(para.events).toEqual(['logout', 'marker', 'disconnect'])
  })

  it('leaves an external wallet alone', async () => {
    para.loggedIn = false
    await disconnectOnce()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(para.logout).not.toHaveBeenCalled()
    expect(para.marked).toEqual([])
    expect(para.wagmiDisconnected).toBe(1)
  })
})
