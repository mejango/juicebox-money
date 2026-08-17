// @vitest-environment jsdom
import { createElement } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const para = vi.hoisted(() => ({
  logout: vi.fn(async () => {}),
  loggedIn: true,
  marked: [] as boolean[],
  wagmiDisconnected: 0,
  connectorId: 'injected' as string,
}))

vi.mock('wagmi', () => ({
  useAccount: () => ({
    address: '0x1234567890abcdef1234567890abcdef12345678',
    connector: { id: para.connectorId },
    isConnected: true,
  }),
  useConnect: () => ({ connectAsync: vi.fn(), connectors: [] }),
  useDisconnect: () => ({
    disconnect: () => {
      para.wagmiDisconnected += 1
    },
  }),
}))

vi.mock('@/providers/Providers', () => ({ IS_DETERMINISTIC_BROWSER: false }))
vi.mock('@/lib/wallet-list', () => ({ offerableWallets: () => [] }))
vi.mock('@/providers/ParaAuthContext', () => ({
  markParaSession: (active: boolean) => para.marked.push(active),
  useParaAuth: () => ({
    modalOpen: false,
    requestSignIn: vi.fn(),
    sessionVersion: 1,
  }),
}))
vi.mock('@/providers/para-config', () => ({
  getParaClient: () => ({
    isFullyLoggedIn: async () => para.loggedIn,
    logout: para.logout,
  }),
}))

const { useWallet } = await import('@/hooks/useWallet')

/** A hook needs a component around it; this is the smallest one that hands its result back. */
async function disconnectOnce() {
  let wallet: ReturnType<typeof useWallet> | undefined
  function Probe() {
    wallet = useWallet()
    return null
  }
  await act(async () => {
    TestRenderer.create(createElement(Probe))
  })
  await act(async () => {
    wallet!.disconnect()
  })
}

beforeEach(() => {
  para.logout.mockClear()
  para.marked.length = 0
  para.wagmiDisconnected = 0
  para.loggedIn = true
  para.connectorId = 'injected'
})

describe('disconnecting', () => {
  it('ends a Para session whatever the connector calls itself', async () => {
    // The old check keyed on `connector.id === 'para'`. An email sign-in whose
    // connector read as anything else left the session alive — and the bridge
    // effect, which exists to pick a live session up, signed the visitor
    // straight back in.
    await disconnectOnce()
    await vi.waitFor(() => expect(para.logout).toHaveBeenCalled())
    expect(para.wagmiDisconnected).toBe(1)
    expect(para.marked).toEqual([false])
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
