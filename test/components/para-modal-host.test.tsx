// @vitest-environment jsdom

import { act, type ComponentProps, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ModalShell } from '@/components/ui/ModalShell'
import { topLayerDialogs } from '../dialog-shim'

const para = vi.hoisted(() => ({
  isOpen: false,
  openModal: vi.fn(),
  portalContainer: null as Element | null,
  loggedIn: true,
  initiateOnRampTransaction: vi.fn(async () => ({
    portalUrl: 'https://portal.example/buy',
  })),
  connectorId: 'injected' as string | undefined,
  // ParaProvider renders nothing until Para's API answers; mirror that.
  driverLive: true,
  address: '0xfeedfacefeedfacefeedfacefeedfacefeedface' as string | undefined,
}))

vi.mock('@getpara/react-sdk-lite/styles.css', () => ({}))
vi.mock('@getpara/react-sdk-lite', () => ({
  ParaProvider: ({ children }: { children: ReactNode }) =>
    para.driverLive ? children : null,
  useModal: () => ({ isOpen: para.isOpen, openModal: para.openModal }),
  useAuthenticateWithEmailOrPhone: () => ({
    authenticateWithEmailOrPhoneAsync: vi.fn(),
    error: null,
  }),
  useAuthenticateWithOAuth: () => ({
    authenticateWithOAuthAsync: vi.fn(),
    error: null,
  }),
  useVerifyNewAccount: () => ({
    verifyNewAccountAsync: vi.fn(),
    isPending: false,
    error: null,
  }),
  useResendVerificationCode: () => ({ resendVerificationCodeAsync: vi.fn() }),
}))
// The SDK ships these as string enums; the host uses them as lookup tables.
vi.mock('@getpara/web-sdk', () => ({
  Network: { ETHEREUM: 'ETHEREUM', BASE: 'BASE' },
  OnRampAsset: { ETHEREUM: 'ETHEREUM', USDC: 'USDC' },
  OnRampProvider: { MOONPAY: 'MOONPAY' },
  OnRampPurchaseType: { BUY: 'BUY' },
}))
vi.mock('@getpara/react-component-library', () => ({
  PortalContainerProvider: ({
    container,
    children,
  }: {
    container: Element
    children: ReactNode
  }) => {
    para.portalContainer = container
    return children
  },
}))
vi.mock('wagmi', () => ({
  useAccount: () => ({
    address: para.address,
    connector: para.connectorId ? { id: para.connectorId } : undefined,
  }),
  // The shell lists wallets straight from EIP-6963; none of it needs Para.
  useConnectors: () => [],
}))
vi.mock('@/hooks/useWallet', () => ({
  useWallet: () => ({ connectors: [], connectWith: vi.fn() }),
}))
vi.mock('@/providers/para-config', () => ({
  getParaClient: () => ({
    isFullyLoggedIn: async () => para.loggedIn,
    initiateOnRampTransaction: para.initiateOnRampTransaction,
    onStatePhaseChange: () => () => {},
  }),
  PARA_APP: { appName: 'Juicebox' },
  PARA_ONRAMP_PROVIDER: 'MOONPAY',
}))

const { default: ParaModalHost } = await import('@/providers/ParaModalHost')

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  para.isOpen = false
  para.portalContainer = null
  para.loggedIn = true
  para.connectorId = 'injected'
  para.driverLive = true
  para.address = '0xfeedfacefeedfacefeedfacefeedfacefeedface'
  para.openModal.mockClear()
  para.initiateOnRampTransaction.mockClear()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.style.overflow = ''
})

function render(node: ReactNode) {
  act(() => root.render(node))
}

function host(): HTMLDialogElement | null {
  return document.querySelector('dialog.ui-modal-host')
}

function Host({
  requestId = 1,
  request = { kind: 'auth' as const },
}: {
  requestId?: number
  request?: ComponentProps<typeof ParaModalHost>['request']
}) {
  return (
    <ParaModalHost
      requestId={requestId}
      request={request}
      onOpenChange={() => {}}
      onSettled={() => {}}
      entry=""
      onEntryChange={() => {}}
    />
  )
}

const ADD_FUNDS = {
  kind: 'addFunds',
  asset: 'ETHEREUM',
  network: 'BASE',
} as const

/** The host resolves the session before branching, so the assertions have to
 *  wait for that microtask to drain. */
async function settle() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('ParaModalHost', () => {
  it('hosts the whole Para tree inside a dialog it owns, not the body', () => {
    render(<Host />)

    const dialog = host()
    expect(dialog).not.toBeNull()
    expect(dialog!.parentElement).toBe(document.body)
    // Para portals its overlay through this container; pointing it at the
    // host is what keeps the overlay inside the top layer.
    expect(para.portalContainer).toBe(dialog)
  })

  it('signs in with our own sheet, never Para’s packaged modal', () => {
    render(<Host />)

    expect(para.openModal).not.toHaveBeenCalled()
    expect(host()!.textContent).toContain('You will receive a code')
    // Our sheet is what puts the host in the top layer for an auth request.
    expect(host()!.open).toBe(true)
  })

  it('holds the sheet’s silhouette open while Para is still starting up', () => {
    // ParaProvider renders nothing until Para's API answers, so Driver — and
    // the sheet with it — does not exist for the first few hundred ms. If the
    // dialog waited for Driver, the page would reappear between the
    // placeholder and the sheet, which is exactly what it used to do.
    para.driverLive = false
    render(<Host />)

    expect(host()!.open).toBe(true)
    expect(host()!.textContent).toContain('Sign in')
    expect(para.openModal).not.toHaveBeenCalled()
  })

  it('shows the real controls, and keeps what was typed, before Para is up', async () => {
    // None of the sheet's chrome needs Para — the provider marks are inlined
    // and the wallet marks come from EIP-6963 — so the silhouette is the real
    // thing, and the swap to the live sheet should change nothing visible.
    para.driverLive = false
    const typed: string[] = []
    act(() =>
      root.render(
        <ParaModalHost
          requestId={1}
          request={{ kind: 'auth' }}
          onOpenChange={() => {}}
          onSettled={() => {}}
          entry="me@example.com"
          onEntryChange={value => typed.push(value)}
        />,
      ),
    )

    const field = host()!.querySelector('input')
    expect(field).not.toBeNull()
    expect(field!.value).toBe('me@example.com')
    expect(host()!.textContent).toContain('Or, use socials')
    expect(host()!.textContent).toContain('or, a wallet')
    // Typing during the wait has to reach the state that outlives this.
    act(() => {
      // React tracks the value on the node, so it has to be set through the
      // native setter or the synthetic onChange never fires.
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!.call(field, 'me@example.org')
      field!.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(typed).toContain('me@example.org')
  })

  it('mirrors Para’s own open state onto showModal()/close()', () => {
    // An add-funds request with a session already in hand never opens the
    // sheet, so Para's modal is the only thing driving the host here.
    render(<Host request={ADD_FUNDS} />)
    const dialog = host()!
    expect(dialog.open).toBe(false)

    para.isOpen = true
    render(<Host requestId={2} request={ADD_FUNDS} />)
    expect(dialog.open).toBe(true)

    para.isOpen = false
    render(<Host requestId={2} request={ADD_FUNDS} />)
    expect(dialog.open).toBe(false)
  })

  it('buys to the connected external wallet rather than the embedded one', async () => {
    render(<Host request={ADD_FUNDS} />)
    await settle()

    // Para's add-funds modal has no address parameter, so an injected wallet
    // has to go through the headless call or the ETH lands in the wrong place.
    expect(para.openModal).not.toHaveBeenCalled()
    expect(para.initiateOnRampTransaction).toHaveBeenCalledTimes(1)
    expect(para.initiateOnRampTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        externalWalletAddress: para.address,
        shouldOpenPopup: true,
        params: expect.objectContaining({
          asset: 'ETHEREUM',
          network: 'BASE',
          provider: 'MOONPAY',
        }),
      }),
    )
  })

  it('warns that the purchase may not go through, and offers the window again', async () => {
    render(<Host request={ADD_FUNDS} />)
    await settle()

    // A card decline arrives inside the provider's window with no
    // explanation, so the guidance has to live on our side of the handoff.
    const text = host()!.textContent ?? ''
    expect(text).toContain('always go through')
    expect(text).toContain('bank transfer')
    // Popup blockers are common enough that the link has to be clickable.
    const link = host()!.querySelector('a[href="https://portal.example/buy"]')
    expect(link).not.toBeNull()
  })

  it('uses Para’s own add-funds screen for the embedded wallet', async () => {
    para.connectorId = 'para'
    render(<Host request={ADD_FUNDS} />)
    await settle()

    expect(para.initiateOnRampTransaction).not.toHaveBeenCalled()
    expect(para.openModal).toHaveBeenCalledWith({
      step: 'ACCOUNT_ADD_FUNDS_BUY',
    })
  })

  it('signs in first when the on-ramp has no Para session to bill against', async () => {
    para.loggedIn = false
    render(<Host request={ADD_FUNDS} />)
    await settle()

    expect(para.initiateOnRampTransaction).not.toHaveBeenCalled()
    expect(para.openModal).not.toHaveBeenCalled()
    expect(host()!.textContent).toContain('You will receive a code')
  })

  it('does not reopen the sheet when sign-in for the on-ramp is cancelled', async () => {
    // Closing reports the same event whether the visitor signed in or gave up,
    // so resuming unconditionally walks back into "no session, open the sheet"
    // and the sheet becomes impossible to dismiss.
    para.loggedIn = false
    render(<Host request={ADD_FUNDS} />)
    await settle()
    expect(host()!.open).toBe(true)

    const close = [...host()!.querySelectorAll('button')].find(
      button => button.getAttribute('aria-label') === 'Close',
    )
    act(() => close?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await settle()

    expect(host()!.open).toBe(false)
    expect(para.initiateOnRampTransaction).not.toHaveBeenCalled()
  })

  it('keeps Escape as Para’s own dismissal path', () => {
    para.isOpen = true
    render(<Host />)
    const dialog = host()!

    const cancelled = !dialog.dispatchEvent(
      new Event('cancel', { bubbles: false, cancelable: true }),
    )

    // Closing the host natively would leave Para believing it was still open.
    expect(cancelled).toBe(true)
    expect(dialog.open).toBe(true)
  })

  it('sits above an already open ModalShell, so sign-in from inside a modal works', () => {
    // This is the regression the native-dialog migration would otherwise
    // introduce: `showModal()` inerts every body-level overlay, and sign-in is
    // reachable from inside AddShopItemsModal and RedeemShopItemsModal.
    para.isOpen = true
    render(
      <>
        <ModalShell title="Add items" onClose={() => {}}>
          <p>body</p>
        </ModalShell>
        <Host />
      </>,
    )

    const shell = document.querySelector<HTMLDialogElement>('dialog.modal-dialog')!
    const dialog = host()!
    const layer = topLayerDialogs()

    expect(layer[layer.length - 1]).toBe(dialog)
    expect(layer.indexOf(dialog)).toBeGreaterThan(layer.indexOf(shell))
    expect(shell.contains(dialog)).toBe(false)
  })

  it('removes its host on unmount', () => {
    render(<Host />)
    expect(host()).not.toBeNull()

    act(() => root.render(null))
    expect(host()).toBeNull()
  })
})
