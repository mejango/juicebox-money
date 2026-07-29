'use client'

/**
 * Deterministic-browser-only surface for `test/browser/modal.spec.ts`.
 *
 * The modal accessibility contract — the page behind an open modal is inert,
 * a stacked dialog is interactive above the one under it — can only be proven
 * by a real browser: jsdom has no top layer, no hit testing and no focus
 * scoping. No production surface reaches a modal without a connected wallet
 * and live chain data, so the proof mounts the shared shell directly, over
 * ordinary background content, and opens the real transaction review dialog
 * (registered by the root layout's provider) on top of it.
 *
 * `next.config.js` only registers `page.browsertest.tsx` as a route when
 * NEXT_PUBLIC_DETERMINISTIC_BROWSER is set, so this route does not exist in a
 * production build.
 */

import { useEffect, useState } from 'react'
import { ModalShell } from '@/components/ui/ModalShell'
import { requireTransactionReview } from '@/lib/transaction-review'

/**
 * Two ways a third-party overlay can mount itself while an app modal is open.
 * Only one of them stays usable — which is why `ParaModalHost` owns a
 * `showModal()` dialog instead of rendering into the body.
 */
function mountOverlay(kind: 'body' | 'hosted') {
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = `${kind} overlay action`
  button.dataset.testid = `${kind}-overlay-button`
  button.addEventListener('click', () => {
    button.dataset.clicked = 'true'
  })

  if (kind === 'body') {
    const node = document.createElement('div')
    node.style.cssText =
      'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center'
    node.append(button)
    document.body.append(node)
    return
  }

  const node = document.createElement('dialog')
  node.className = 'ui-modal-host'
  node.append(button)
  document.body.append(node)
  node.showModal()
}

export default function ModalProofPage() {
  const [open, setOpen] = useState(false)
  const [background, setBackground] = useState(0)
  const [inside, setInside] = useState('untouched')
  const [review, setReview] = useState('idle')
  // Hydration handshake: clicking before React attaches would do nothing.
  const [ready, setReady] = useState(false)
  useEffect(() => setReady(true), [])

  return (
    <main
      className="mx-auto max-w-2xl px-4 py-10"
      data-modal-proof-ready={ready ? 'true' : 'false'}
    >
      <h1 className="font-agrandir text-2xl font-medium text-ink">
        Modal accessibility proof
      </h1>

      <p className="mt-4 text-sm text-smoke-700" data-testid="background-state">
        {background}
      </p>

      <div className="mt-4 flex flex-wrap gap-3">
        <button
          type="button"
          data-testid="background-button"
          onClick={() => setBackground(count => count + 1)}
          className="btn-secondary min-h-[44px] px-5 text-sm"
        >
          Background action
        </button>
        <a
          href="#background-anchor"
          id="background-anchor"
          data-testid="background-link"
          className="btn-link min-h-[44px] text-sm"
        >
          Background link
        </a>
        <button
          type="button"
          data-testid="open-modal"
          onClick={() => setOpen(true)}
          className="btn-primary min-h-[44px] px-5 text-sm"
        >
          Open modal
        </button>
      </div>

      {open ? (
        <ModalShell
          title="Proof modal"
          subtitle="Opened with showModal()."
          onClose={() => setOpen(false)}
        >
          <p className="text-sm text-smoke-700" data-testid="inside-state">
            {inside}
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            <button
              type="button"
              data-testid="inside-button"
              onClick={() => setInside('clicked')}
              className="btn-secondary min-h-[44px] px-5 text-sm"
            >
              Inside action
            </button>
            <button
              type="button"
              data-testid="open-review"
              onClick={() => {
                setReview('open')
                requireTransactionReview({
                  title: 'Stacked review dialog',
                  calls: [
                    {
                      chainId: 1,
                      to: '0x0000000000000000000000000000000000000001',
                      data: '0x',
                    },
                  ],
                }).then(
                  () => setReview('approved'),
                  () => setReview('cancelled'),
                )
              }}
              className="btn-primary min-h-[44px] px-5 text-sm"
            >
              Open review dialog
            </button>
          </div>
          <p className="mt-4 text-sm text-smoke-700" data-testid="review-state">
            {review}
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            <button
              type="button"
              data-testid="mount-body-overlay"
              onClick={() => mountOverlay('body')}
              className="btn-secondary min-h-[44px] px-5 text-sm"
            >
              Mount body-level overlay
            </button>
            <button
              type="button"
              data-testid="mount-hosted-overlay"
              onClick={() => mountOverlay('hosted')}
              className="btn-secondary min-h-[44px] px-5 text-sm"
            >
              Mount dialog-hosted overlay
            </button>
          </div>
        </ModalShell>
      ) : null}
    </main>
  )
}
