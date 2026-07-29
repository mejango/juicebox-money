// @vitest-environment jsdom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ModalShell } from '@/components/ui/ModalShell'
import { topLayerDialogs } from '../dialog-shim'

const para = vi.hoisted(() => ({
  isOpen: false,
  openModal: vi.fn(),
  portalContainer: null as Element | null,
}))

vi.mock('@getpara/react-sdk-lite/styles.css', () => ({}))
vi.mock('@getpara/react-sdk-lite', () => ({
  ParaProvider: ({ children }: { children: ReactNode }) => children,
  useModal: () => ({ isOpen: para.isOpen, openModal: para.openModal }),
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
vi.mock('@/providers/para-config', () => ({
  getParaClient: () => ({}),
  PARA_APP: { appName: 'Juicebox' },
}))

const { default: ParaModalHost } = await import('@/providers/ParaModalHost')

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  para.isOpen = false
  para.portalContainer = null
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

function Host({ requestId = 1 }: { requestId?: number }) {
  return (
    <ParaModalHost
      requestId={requestId}
      onOpenChange={() => {}}
      onSettled={() => {}}
    />
  )
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
    expect(para.openModal).toHaveBeenCalledTimes(1)
  })

  it('mirrors Para’s own open state onto showModal()/close()', () => {
    render(<Host />)
    const dialog = host()!
    expect(dialog.open).toBe(false)

    para.isOpen = true
    render(<Host requestId={2} />)
    expect(dialog.open).toBe(true)

    para.isOpen = false
    render(<Host requestId={2} />)
    expect(dialog.open).toBe(false)
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
