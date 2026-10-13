// @vitest-environment jsdom

import { act, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ModalDialog, ModalShell } from '@/components/ui/ModalShell'
import { TxConfirmDialog } from '@/components/ui/TxConfirmDialog'
import { LoadingText } from '@/components/ui/LoadingText'
import { withFailedStep } from '@/components/ui/TxSteps'
import { topLayerDialogs } from '../dialog-shim'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  document.body.style.overflow = ''
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

function dialogs(): HTMLDialogElement[] {
  return [...document.querySelectorAll('dialog')]
}

function only(): HTMLDialogElement {
  const found = dialogs()
  expect(found).toHaveLength(1)
  return found[0]
}

function pressEscape() {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      }),
    )
  })
}

function mouseDownOn(target: EventTarget) {
  act(() => {
    target.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, cancelable: true }),
    )
  })
}

describe('ModalShell', () => {
  it('opens a real dialog in the top layer with implicit modal semantics', () => {
    render(
      <ModalShell
        title="Add items"
        subtitle="Stage items"
        footer={<button type="button">Done</button>}
        onClose={vi.fn()}
      >
        <p>Body</p>
      </ModalShell>,
    )

    const dialog = only()
    expect(dialog.open).toBe(true)
    expect(topLayerDialogs()).toEqual([dialog])
    // `showModal()` makes role/aria-modal implicit; duplicating them by hand
    // is the pattern this migration removes.
    expect(dialog.getAttribute('role')).toBeNull()
    expect(dialog.getAttribute('aria-modal')).toBeNull()
    // The label association is NOT implicit and must survive.
    const labelledBy = dialog.getAttribute('aria-labelledby')
    expect(labelledBy).toBeTruthy()
    expect(document.getElementById(labelledBy!)?.textContent).toBe('Add items')
    const card = dialog.querySelector('[data-modal-card]')
    const body = dialog.querySelector('[data-modal-body]')
    const footer = dialog.querySelector('[data-modal-footer]')
    expect(card).not.toBeNull()
    expect(body?.nextElementSibling).toBe(footer)
    expect(footer?.parentElement).toBe(card)
    expect(body?.contains(footer)).toBe(false)
    const close = dialog.querySelector<HTMLButtonElement>(
      'button[aria-label="Close"]',
    )
    expect(close?.className).toContain('icon-button')
    expect(close?.className).toContain('-mr-2')
    expect(close?.querySelector('svg')?.className.baseVal).toContain('h-6')
    // The top layer supersedes z-index; no stacking context juggling remains.
    expect(dialog.className).not.toMatch(/z-\[/)
  })

  it('does not re-open an already open dialog on re-render', () => {
    const showModal = vi.spyOn(HTMLDialogElement.prototype, 'showModal')
    render(
      <ModalShell title="One" onClose={vi.fn()}>
        <p>a</p>
      </ModalShell>,
    )
    render(
      <ModalShell title="One" onClose={vi.fn()}>
        <p>b</p>
      </ModalShell>,
    )

    expect(showModal).toHaveBeenCalledTimes(1)
    expect(only().open).toBe(true)
  })

  it('routes the native cancel event to onClose without letting the UA close it', () => {
    const onClose = vi.fn()
    render(
      <ModalShell title="One" onClose={onClose}>
        <p>a</p>
      </ModalShell>,
    )

    pressEscape()

    expect(onClose).toHaveBeenCalledTimes(1)
    // React owns `open`: the dialog stays up until the owner unmounts it, so a
    // guarded onClose can refuse.
    expect(only().open).toBe(true)
  })

  it('blocks every close path while busy', () => {
    const onClose = vi.fn()
    render(
      <ModalShell title="One" onClose={onClose} busy>
        <p>a</p>
      </ModalShell>,
    )
    const dialog = only()

    pressEscape()
    mouseDownOn(dialog)
    act(() => {
      dialog.querySelector<HTMLButtonElement>('button[aria-label="Close"]')?.click()
    })

    expect(onClose).not.toHaveBeenCalled()
    expect(dialog.open).toBe(true)
  })

  it('closes on a backdrop click but not on a click inside the content', () => {
    const onClose = vi.fn()
    render(
      <ModalShell title="One" onClose={onClose}>
        <p id="inside">a</p>
      </ModalShell>,
    )
    const dialog = only()

    mouseDownOn(document.getElementById('inside')!)
    expect(onClose).not.toHaveBeenCalled()

    mouseDownOn(dialog)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes the dialog and leaves the top layer on unmount', () => {
    render(
      <ModalShell title="One" onClose={vi.fn()}>
        <p>a</p>
      </ModalShell>,
    )
    const dialog = only()

    act(() => root.render(null))

    expect(dialog.open).toBe(false)
    expect(topLayerDialogs()).toEqual([])
  })
})

describe('a confirm hosted in the shell', () => {
  it('animates progress without changing its accessible text', () => {
    render(<LoadingText text="Requesting the network-fee quote." active />)
    expect(document.querySelector('.loading-dots')?.getAttribute('aria-hidden')).toBe('true')
    expect(document.body.textContent).toContain('Requesting the network-fee quote.')
    render(<LoadingText text="Payment confirmed." />)
    expect(document.querySelector('.loading-dots')).toBeNull()
  })
  it('keeps submitted transaction hashes readable in confirmation errors', () => {
    const message = `Payment 0x${'a'.repeat(64)} was submitted; confirmation is unavailable.`
    render(<TxConfirmDialog open title="Confirm" steps={[]} activeIndex={-1}
      action="Resume" onConfirm={() => {}} onClose={() => {}} error={message} />)
    const alert = only().querySelector('[role="alert"]')!
    expect(alert.textContent).toBe(message)
    expect(alert.classList.contains('wrap-anywhere')).toBe(true)
  })

  function Hosted({
    busy,
    onClose,
    onConfirmClose,
  }: {
    busy: boolean
    onClose: () => void
    onConfirmClose: () => void
  }) {
    return (
      <ModalShell title="Add liquidity" onClose={onClose}>
        <TxConfirmDialog
          open
          title="Confirm"
          steps={[{ title: 'Approve' }, { title: 'Mint' }]}
          activeIndex={1}
          action="Adding liquidity…"
          onConfirm={() => {}}
          onClose={onConfirmClose}
          busy={busy}
        />
      </ModalShell>
    )
  }

  it('keeps the shell open while it is busy, and lets it close once it is not', () => {
    const onClose = vi.fn()
    const onConfirmClose = vi.fn()
    render(<Hosted busy onClose={onClose} onConfirmClose={onConfirmClose} />)
    // The confirm replaced the card's content in place: one dialog, the shell's.
    const dialog = only()
    expect(dialog.querySelector('[data-tx-confirm]')).not.toBeNull()
    const [shellClose] = dialog.querySelectorAll<HTMLButtonElement>('button[aria-label="Close"]')

    pressEscape()
    mouseDownOn(dialog)
    act(() => shellClose.click())

    expect(onClose).not.toHaveBeenCalled()
    expect(onConfirmClose).not.toHaveBeenCalled()
    expect(dialog.open).toBe(true)
    expect(shellClose.disabled).toBe(true)

    render(<Hosted busy={false} onClose={onClose} onConfirmClose={onConfirmClose} />)
    expect(shellClose.disabled).toBe(false)
    pressEscape()
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('the transaction confirm while a read-only phase runs', () => {
  const base = { open: true, title: 'Confirm', steps: [{ title: 'Check' }], activeIndex: 0, onConfirm: () => {}, onClose: () => {} }

  it('drops its buttons when there is no action, leaving only Close', () => {
    render(<TxConfirmDialog {...base} action={null} busy status="Checking the transactions…" />)
    const dialog = only()
    expect([...dialog.querySelectorAll('button')].map(button => button.getAttribute('aria-label') ?? button.textContent)).toEqual(['Close'])
    expect(dialog.querySelector('footer')).toBeNull()
    expect(dialog.querySelector('[role="status"] .loading-dots')).not.toBeNull()
  })

  it('keeps Cancel for work that can be stopped, and nothing else', () => {
    const onCancel = vi.fn()
    render(<TxConfirmDialog {...base} action={null} busy onCancel={onCancel} status="Getting the quote…" />)
    const buttons = [...only().querySelectorAll('footer button')]
    expect(buttons.map(button => button.textContent)).toEqual(['Cancel'])
    act(() => (buttons[0] as HTMLButtonElement).click())
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it('brings the buttons back when an action returns', () => {
    render(<TxConfirmDialog {...base} action="Retry" />)
    expect([...only().querySelectorAll('footer button')].map(button => button.textContent)).toEqual(['Cancel', 'Retry'])
  })
})

describe('modal body scroll lock', () => {
  function Stack({ inner }: { inner: boolean }) {
    return (
      <ModalShell title="Outer" onClose={vi.fn()}>
        {inner ? (
          <ModalDialog labelledBy="inner-title" onClose={vi.fn()}>
            <div>
              <h2 id="inner-title">Inner</h2>
            </div>
          </ModalDialog>
        ) : null}
      </ModalShell>
    )
  }

  it('is reference counted so a stacked modal cannot unlock the page early', () => {
    document.body.style.overflow = 'scroll'

    render(<Stack inner={false} />)
    expect(document.body.style.overflow).toBe('hidden')

    render(<Stack inner />)
    expect(dialogs()).toHaveLength(2)
    expect(document.body.style.overflow).toBe('hidden')

    // Closing only the inner modal must NOT restore scrolling: the outer one
    // is still open. This is the leak the per-instance capture/restore had.
    render(<Stack inner={false} />)
    expect(document.body.style.overflow).toBe('hidden')

    act(() => root.render(null))
    expect(document.body.style.overflow).toBe('scroll')
  })

  it('stacks the later dialog above the earlier one in the top layer', () => {
    // Order in the top layer follows showModal() call order, which is what
    // production does: a modal is up, and the review dialog opens over it.
    render(<Stack inner={false} />)
    render(<Stack inner />)

    const [outer, inner] = dialogs()
    const layer = topLayerDialogs()
    expect(layer).toHaveLength(2)
    expect(layer[0]).toBe(outer)
    expect(layer[1]).toBe(inner)
    expect(inner.getAttribute('aria-labelledby')).toBe('inner-title')
  })
})

describe('ModalDialog', () => {
  it('keeps aria-describedby and honours dismissible=false', () => {
    const onClose = vi.fn()
    function Host() {
      const [dismissible, setDismissible] = useState(false)
      return (
        <ModalDialog
          labelledBy="t"
          describedBy="d"
          dismissible={dismissible}
          onClose={onClose}
        >
          <div>
            <h2 id="t">Review</h2>
            <p id="d">Description</p>
            <button type="button" onClick={() => setDismissible(true)}>
              allow
            </button>
          </div>
        </ModalDialog>
      )
    }
    render(<Host />)
    const dialog = only()
    expect(dialog.getAttribute('aria-describedby')).toBe('d')

    pressEscape()
    mouseDownOn(dialog)
    expect(onClose).not.toHaveBeenCalled()

    act(() => {
      dialog.querySelector('button')?.click()
    })
    pressEscape()
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('a confirm error that carries a link', () => {
  it('turns an explorer address in the error into a link', () => {
    render(<TxConfirmDialog open title="Confirm" steps={[]} activeIndex={-1} action={null} complete={false}
      onConfirm={() => {}} onClose={() => {}} error="Couldn't confirm yet. Check https://etherscan.io/tx/0xabc before sending again." />)
    const link = only().querySelector('[role="alert"] a')!
    expect(link.getAttribute('href')).toBe('https://etherscan.io/tx/0xabc')
    expect(link.getAttribute('rel')).toContain('noopener')
    expect(only().querySelector('[role="alert"]')!.textContent).toBe("Couldn't confirm yet. Check https://etherscan.io/tx/0xabc before sending again.")
  })
})

describe('TxSteps failed steps', () => {
  it('shows × and a status on the failed step, and keeps earlier steps done', () => {
    render(<TxConfirmDialog open title="Confirm" action="Retry" onConfirm={() => {}} onClose={() => {}} activeIndex={1}
      steps={withFailedStep([{ title: 'Approve' }, { title: 'Mint' }, { title: 'Done' }], 1, true)} />)
    const items = [...only().querySelectorAll('li[data-state]')]
    expect(items.map(item => item.getAttribute('data-state'))).toEqual(['complete', 'failed', 'pending'])
    expect(items[1].textContent).toContain('×')
    expect(items[1].textContent).toContain('Failed')
  })

  it('leaves the steps alone when nothing failed', () => {
    const steps = [{ title: 'Approve' }]
    expect(withFailedStep(steps, 0, false)).toBe(steps)
  })
})
