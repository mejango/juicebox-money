import { createElement, forwardRef, useImperativeHandle, createRef } from 'react'
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer'
import type { Address } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  connectedAddress: undefined as Address | undefined,
}))

vi.mock('@/hooks/useWallet', () => ({
  useWallet: () => ({
    isConnected: !!mocks.connectedAddress,
    address: mocks.connectedAddress,
    connectors: [],
    connectWith: vi.fn(),
    openSignIn: vi.fn(),
    disconnect: vi.fn(),
  }),
}))
vi.mock('@/hooks/useEnsName', () => ({
  useEnsName: () => ({ data: null }),
}))
vi.mock('next/link', () => ({
  default: ({
    children,
    ...props
  }: {
    children: React.ReactNode
    [key: string]: unknown
  }) => createElement('a', props, children),
}))

const ALICE = '0x1111111111111111111111111111111111111111' as Address
const BOB = '0x2222222222222222222222222222222222222222' as Address
const STORAGE_KEY = 'jb-view-as-v1'

function fakeWindow() {
  const store = new Map<string, string>()
  return {
    store,
    window: {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key),
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  }
}

// The store keeps module-level state (cache + listeners), so every test gets
// a fresh module instance against a fresh fake window.
async function loadViewAs() {
  vi.resetModules()
  return import('@/lib/viewAs')
}

beforeEach(() => {
  mocks.connectedAddress = undefined
})

describe('viewAs store', () => {
  it('sets, persists, and clears the viewed address', async () => {
    const { store, window } = fakeWindow()
    vi.stubGlobal('window', window)
    const viewAs = await loadViewAs()

    expect(viewAs.getViewAs()).toBeNull()
    viewAs.setViewAs(BOB)
    expect(viewAs.getViewAs()).toBe(BOB)
    expect(store.get(STORAGE_KEY)).toBe(BOB)

    viewAs.clearViewAs()
    expect(viewAs.getViewAs()).toBeNull()
    expect(store.has(STORAGE_KEY)).toBe(false)
  })

  it('reads a persisted address on first access and rejects junk', async () => {
    const { store, window } = fakeWindow()
    store.set(STORAGE_KEY, BOB)
    vi.stubGlobal('window', window)
    const viewAs = await loadViewAs()
    expect(viewAs.getViewAs()).toBe(BOB)

    store.set(STORAGE_KEY, 'not-an-address')
    const reloaded = await loadViewAs()
    expect(reloaded.getViewAs()).toBeNull()
  })

  it('is inert without a window (SSR) yet still tracks in memory', async () => {
    const viewAs = await loadViewAs()
    expect(viewAs.getViewAs()).toBeNull()
    viewAs.setViewAs(BOB)
    expect(viewAs.getViewAs()).toBe(BOB)
    viewAs.clearViewAs()
    expect(viewAs.getViewAs()).toBeNull()
  })

  it('notifies useViewAs subscribers', async () => {
    const { window } = fakeWindow()
    vi.stubGlobal('window', window)
    const viewAs = await loadViewAs()

    type Value = ReturnType<typeof viewAs.useViewAs>
    const ref = createRef<Value>()
    const Harness = forwardRef<Value>(function Harness(_, forwarded) {
      const value = viewAs.useViewAs()
      useImperativeHandle(forwarded, () => value, [value])
      return null
    })
    await act(async () => {
      TestRenderer.create(createElement(Harness, { ref }))
    })
    expect(ref.current!.viewAs).toBeNull()
    expect(ref.current!.isViewAs).toBe(false)

    await act(async () => ref.current!.setViewAs(BOB))
    expect(ref.current!.viewAs).toBe(BOB)
    expect(ref.current!.isViewAs).toBe(true)

    await act(async () => ref.current!.clearViewAs())
    expect(ref.current!.viewAs).toBeNull()
  })
})

describe('useViewedAccount', () => {
  it('overrides the connected address while view-as is active', async () => {
    const { window } = fakeWindow()
    vi.stubGlobal('window', window)
    const viewAs = await loadViewAs()
    const { useViewedAccount } = await import('@/hooks/useViewedAccount')
    mocks.connectedAddress = ALICE

    type Value = ReturnType<typeof useViewedAccount>
    const ref = createRef<Value>()
    const Harness = forwardRef<Value>(function Harness(_, forwarded) {
      const value = useViewedAccount()
      useImperativeHandle(forwarded, () => value, [value])
      return null
    })
    await act(async () => {
      TestRenderer.create(createElement(Harness, { ref }))
    })
    expect(ref.current!.address).toBe(ALICE)
    expect(ref.current!.connectedAddress).toBe(ALICE)
    expect(ref.current!.isViewAs).toBe(false)

    await act(async () => viewAs.setViewAs(BOB))
    expect(ref.current!.address).toBe(BOB)
    expect(ref.current!.connectedAddress).toBe(ALICE)
    expect(ref.current!.isViewAs).toBe(true)

    await act(async () => viewAs.clearViewAs())
    expect(ref.current!.address).toBe(ALICE)
    expect(ref.current!.isViewAs).toBe(false)
  })
})

describe('WalletButton view-as state', () => {
  it('keeps View as as the final separated Sign in menu action', async () => {
    const { window } = fakeWindow()
    vi.stubGlobal('window', window)
    vi.stubGlobal('document', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })
    await loadViewAs()
    const { WalletButton } = await import('@/components/WalletButton')

    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(WalletButton))
    })
    const trigger = renderer.root.find(
      (node: ReactTestInstance) =>
        node.type === 'button' && node.props['aria-expanded'] === false,
    )
    await act(async () => trigger.props.onClick())

    const menuButtons = renderer.root.findAll(
      (node: ReactTestInstance) => node.type === 'button' && node !== trigger,
    )
    expect(menuButtons.at(-1)?.children[0]).toBe('View as…')
  })

  it('replaces the connected identity and returns through its dropdown', async () => {
    const { window } = fakeWindow()
    vi.stubGlobal('window', window)
    vi.stubGlobal('document', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })
    const viewAs = await loadViewAs()
    const { WalletButton } = await import('@/components/WalletButton')
    mocks.connectedAddress = ALICE
    viewAs.setViewAs(BOB)

    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(WalletButton))
    })
    expect(JSON.stringify(renderer.toJSON())).toContain('Viewing as')
    expect(JSON.stringify(renderer.toJSON())).not.toContain(
      '0x1111111111111111111111111111111111111111',
    )

    const trigger = renderer.root.find(
      (node: ReactTestInstance) =>
        node.type === 'button' &&
        node.props['aria-expanded'] === false,
    )
    await act(async () => trigger.props.onClick())
    const restore = renderer.root.find(
      (node: ReactTestInstance) =>
        node.type === 'button' &&
        node.children.join('') === 'View as connected wallet',
    )
    await act(async () => restore.props.onClick())

    expect(viewAs.getViewAs()).toBeNull()
    expect(JSON.stringify(renderer.toJSON())).not.toContain('Viewing as')
  })
})

describe('write seams refuse while view-as is active', () => {
  it('submitReviewedContractWrite rejects before review', async () => {
    const { window } = fakeWindow()
    vi.stubGlobal('window', window)
    const viewAs = await loadViewAs()
    const { submitReviewedContractWrite } = await import('@/lib/contract-write')
    viewAs.setViewAs(BOB)

    const review = vi.fn()
    const write = vi.fn()
    await expect(
      submitReviewedContractWrite({
        request: { chainId: 1 },
        expectedAccount: ALICE,
        review,
        switchChain: vi.fn(),
        currentAccount: () => ALICE,
        simulate: vi.fn(),
        write,
      }),
    ).rejects.toThrow(viewAs.VIEW_AS_WRITE_BLOCKED)
    expect(review).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
  })
})
