// @vitest-environment jsdom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { markParaSession, useParaAuth, type ParaRequest } from '@/providers/ParaAuthContext'
import { preloadParaHost } from '@/providers/preload-para'

const router = vi.hoisted(() => ({ refresh: vi.fn() }))
const para = vi.hoisted(() => ({
  host: vi.fn(),
  client: vi.fn(),
  loggedIn: vi.fn(),
  popup: { closed: false },
  openPopup: vi.fn(),
}))

vi.hoisted(() => { vi.stubEnv('NEXT_PUBLIC_DETERMINISTIC_BROWSER', 'false') })
vi.mock('next/navigation', () => ({ useRouter: () => router }))
vi.mock('wagmi', () => ({
  createConfig: () => ({}),
  injected: () => ({}),
  WagmiProvider: ({ children }: { children: ReactNode }) => children,
}))
vi.mock('@/providers/lazy-para-connector', () => ({ lazyParaConnector: () => ({}) }))
vi.mock('@/providers/wallet-connectors', () => ({ externalWalletConnectors: () => [] }))
vi.mock('@/lib/jbcenter-rpc', () => ({ jbCenterRpcTransport: () => ({}) }))
vi.mock('@/lib/query-persist', () => ({ installQueryPersistence: () => undefined }))
vi.mock('@/lib/safe-wallet-peer', () => ({ watchSafeWalletPeer: () => undefined }))
vi.mock('@/components/TransactionReviewProvider', () => ({
  TransactionReviewProvider: ({ children }: { children: ReactNode }) => children,
}))
vi.mock('@/providers/SignInPlaceholder', () => ({ SignInPlaceholder: () => 'Loading sign in' }))
vi.mock('@/providers/on-ramp-window', () => ({ openOnRampWindow: para.openPopup }))
vi.mock('@/providers/para-config', () => ({ getParaClient: para.client }))
vi.mock('@/providers/ParaModalHost', () => ({
  default: (props: { requestId: number; request: ParaRequest }) => {
    para.host(props)
    return <div data-para-host>{props.request.kind}</div>
  },
}))

import { IS_DETERMINISTIC_BROWSER, Providers } from '@/providers/Providers'

function Browse() {
  const { requestSignIn, requestAddFunds } = useParaAuth()
  return <>
    <p>Project content</p>
    <button onClick={requestSignIn}>Sign in</button>
    <button onClick={() => requestAddFunds({ asset: 'ETHEREUM', network: 'BASE' })}>Add funds</button>
  </>
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.useFakeTimers()
  const storage = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value) },
    removeItem: (key: string) => { storage.delete(key) },
  })
  para.client.mockReturnValue({ isFullyLoggedIn: para.loggedIn })
  para.loggedIn.mockResolvedValue(true)
  para.openPopup.mockReturnValue(para.popup)
  markParaSession(false)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  markParaSession(false)
})

async function mount() {
  await act(async () => root.render(<Providers><Browse /></Providers>))
}

async function settleImports() {
  await act(async () => { await vi.dynamicImportSettled() })
}

describe('Para startup with wallet support enabled', () => {
  it.each([true, false])('keeps anonymous browsing wallet-free after idle (native idle: %s)', async nativeIdle => {
    expect(IS_DETERMINISTIC_BROWSER).toBe(false)
    vi.spyOn(document, 'readyState', 'get').mockReturnValue('loading')
    vi.stubGlobal('requestIdleCallback', nativeIdle
      ? (callback: () => void) => window.setTimeout(callback, 4_000)
      : undefined)
    await mount()
    await act(async () => {
      window.dispatchEvent(new Event('load'))
      await vi.advanceTimersByTimeAsync(10_000)
    })
    await settleImports()

    expect(container.textContent).toContain('Project content')
    expect(para.host).not.toHaveBeenCalled()
    expect(para.client).not.toHaveBeenCalled()
  })

  it('preloads on intent without mounting or initializing the wallet', async () => {
    await mount()
    preloadParaHost()
    await settleImports()
    expect(para.host).not.toHaveBeenCalled()
    expect(para.client).not.toHaveBeenCalled()
  })

  it.each(['Sign in', 'Add funds'])('mounts the host on an explicit %s request', async label => {
    await mount()
    const button = [...container.querySelectorAll('button')].find(item => item.textContent === label)!
    act(() => button.click())
    await settleImports()
    expect(para.host).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 1,
      request: label === 'Sign in'
        ? { kind: 'auth' }
        : { kind: 'addFunds', asset: 'ETHEREUM', network: 'BASE', popup: para.popup },
    }))
    expect(para.openPopup).toHaveBeenCalledTimes(label === 'Add funds' ? 1 : 0)
  })

  it('verifies a marked session without mounting the auth UI', async () => {
    markParaSession(true)
    await mount()
    await settleImports()
    expect(para.client).toHaveBeenCalledOnce()
    expect(para.loggedIn).toHaveBeenCalledOnce()
    expect(para.host).not.toHaveBeenCalled()
  })
})
