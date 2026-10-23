import { act, createElement, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { vi } from 'vitest'
import { TransactionReviewProvider } from '@/components/TransactionReviewProvider'
import '../dialog-shim'

/** Render `element` under the site's own review provider: every review is its real dialog. */
export async function renderWithReviews(element: ReactElement) {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => root.render(createElement(TransactionReviewProvider, null, element)))
  return {
    host,
    unmount: () => {
      act(() => root.unmount())
      host.remove()
    },
  }
}

/** The review dialog's confirm: its footer's primary action, whatever its label. */
const confirmOf = (dialog: Element) => dialog.querySelector<HTMLButtonElement>('footer button.btn-primary')

/** The review dialog open now: the site's own (never a flow's progress), with its agree checkbox and confirm. */
function openReview(): HTMLDialogElement | null {
  return [...document.querySelectorAll<HTMLDialogElement>('dialog[open]')]
    .find(dialog => !dialog.querySelector('[data-tx-confirm]') && !dialog.closest('[data-tx-confirm]') &&
      confirmOf(dialog) && dialog.querySelector('input[type="checkbox"]')) ?? null
}

/**
 * Agree to and confirm every review dialog the page opens until `done()`, and
 * count the dialogs: an action that asks twice opens two.
 */
export async function confirmEveryReview(done: () => boolean, { each, tries = 300 }: { each?: () => void; tries?: number } = {}): Promise<number> {
  const seen = new WeakSet<HTMLDialogElement>()
  let count = 0
  for (let attempt = 0; attempt < tries && !done(); attempt++) {
    const dialog = openReview()
    if (dialog && !seen.has(dialog)) {
      seen.add(dialog)
      count += 1
      const agree = dialog.querySelector<HTMLInputElement>('input[type="checkbox"]')
      if (agree && !agree.checked) await act(async () => agree.click())
      const confirm = confirmOf(dialog)!
      await act(async () => confirm.click())
    }
    await act(async () => {
      each?.()
      await vi.dynamicImportSettled()
      await new Promise(resolve => setTimeout(resolve, 5))
    })
  }
  return count
}

/** The progress dialogs' own buttons: none may confirm (core's review is the one confirmation). */
export function progressConfirms(): string[] {
  return [...document.querySelectorAll('[data-tx-confirm] button')]
    .map(button => button.textContent ?? '')
    .filter(label => /^(Confirm|Agree|Approve|Pay|Sign)/.test(label))
}
