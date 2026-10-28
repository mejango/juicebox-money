// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WalletButton } from '@/components/WalletButton'
import { ParaLocalDisconnectError, ParaSessionLogoutError } from '@/providers/para-logout'

const state = vi.hoisted(() => ({ disconnect: vi.fn() }))
vi.mock('@/hooks/useWallet', () => ({ useWallet: () => ({ isConnected: true, address: '0x1111111111111111111111111111111111111111', disconnect: state.disconnect, openSignIn: vi.fn() }) }))
vi.mock('wagmi', () => ({ useAccount: () => ({ chainId: 1 }) }))
vi.mock('next/navigation', () => ({ usePathname: () => '/' }))
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <span>{children}</span> }))
vi.mock('next/dynamic', () => ({ default: () => () => null }))
vi.mock('@/components/ui/AddressLabel', () => ({ AddressLabel: () => <span>Wallet address</span> }))
vi.mock('@/lib/viewAs', () => ({ useViewAs: () => ({ viewAs: null, clearViewAs: vi.fn() }) }))
vi.mock('@/hooks/useProjectHandleFromRoute', () => ({ useProjectHandleFromRoute: () => null }))
vi.mock('@/providers/ProjectRouteContext', () => ({ useResolvedProjectRoute: () => null }))
let root: Root | undefined
let host: HTMLDivElement | undefined
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; host?.remove() })
async function menu() {
  host = document.createElement('div'); document.body.append(host)
  await act(async () => { root = createRoot(host!); root.render(<WalletButton />) })
  await act(async () => host!.querySelector('button')!.click())
}
const button = () => Array.from(host!.querySelectorAll('button')).find(node => /Sign(?:ing)? out/.test(node.textContent ?? ''))!

describe('wallet sign-out feedback', () => {
  it.each([new ParaSessionLogoutError(), new ParaLocalDisconnectError()])('keeps failures visible and supports retry: %s', async error => {
    let finish!: () => void
    state.disconnect.mockReset().mockRejectedValueOnce(error).mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
    await menu()
    await act(async () => button().click())
    expect(host!.querySelector('[role="alert"]')?.textContent).toBe(error.message)
    expect(button().disabled).toBe(false)
    await act(async () => button().click())
    expect(button().textContent).toBe('Signing out…')
    expect(button().disabled).toBe(true)
    expect(host!.querySelector('[role="alert"]')).toBeNull()
    await act(async () => finish())
    expect(button()).toBeUndefined()
    expect(state.disconnect).toHaveBeenCalledTimes(2)
  })
})
