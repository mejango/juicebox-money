'use client'

import { useCallback, useEffect, useId, useRef, type ReactNode } from 'react'

/**
 * Body scroll lock, reference counted.
 *
 * The browser gives us everything else about a modal for free once the dialog
 * is opened with `showModal()`, but not this. Counting matters because modals
 * stack: a per-instance capture/restore lets the inner dialog hand scrolling
 * back to the page while the outer one is still open. Only the first lock
 * captures the previous value, only the last release restores it.
 */
let scrollLocks = 0
let overflowBeforeFirstLock = ''

function lockBodyScroll(): () => void {
  if (scrollLocks === 0) {
    overflowBeforeFirstLock = document.body.style.overflow
    document.body.style.overflow = 'hidden'
  }
  scrollLocks += 1

  let released = false
  return () => {
    if (released) return
    released = true
    scrollLocks -= 1
    if (scrollLocks === 0) {
      document.body.style.overflow = overflowBeforeFirstLock
    }
  }
}

/**
 * The bare native modal: a `<dialog>` opened with `showModal()`, so the top
 * layer owns the backdrop, focus containment, and — the reason this exists —
 * the inertness of everything behind it. A screen reader cannot reach the page
 * under an open `showModal()` dialog, which no amount of `aria-modal` and
 * z-index could achieve.
 *
 * `role="dialog"` and `aria-modal` are implicit here and must not be repeated;
 * the labelling relationships are not, so pass `labelledBy`/`describedBy`.
 *
 * Use this directly only for modals whose chrome differs from {@link
 * ModalShell}'s titled card. Content must live in a single wrapper child:
 * clicks that land on the dialog element itself are backdrop clicks.
 */
export function ModalDialog({
  onClose,
  dismissible = true,
  labelledBy,
  describedBy,
  className = '',
  children,
}: {
  onClose: () => void
  /** When false, Escape and backdrop clicks are ignored (e.g. mid-send). */
  dismissible?: boolean
  labelledBy?: string
  describedBy?: string
  /** Layout utilities for the full-viewport dialog surface. */
  className?: string
  children: ReactNode
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    // showModal() throws InvalidStateError on an already open dialog.
    if (!dialog.open) dialog.showModal()
    const releaseScroll = lockBodyScroll()
    return () => {
      releaseScroll()
      if (dialog.open) dialog.close()
    }
  }, [])

  const dismiss = () => {
    if (dismissible) onClose()
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      className={`modal-dialog ${className}`}
      onCancel={event => {
        // React owns the open state: unmounting the element is what closes the
        // dialog. Always stop the UA from closing it itself, so an owner that
        // refuses to close (busy, discard confirm) keeps a live dialog rather
        // than a hidden one React still believes is open.
        event.preventDefault()
        dismiss()
      }}
      onMouseDown={event => {
        // Backdrop clicks target the dialog element; content is in a child.
        if (event.target === event.currentTarget) dismiss()
      }}
    >
      {children}
    </dialog>
  )
}

/**
 * The shared modal chrome: a native modal dialog with a bordered header
 * carrying the title and a × button. `busy` blocks every close path (backdrop,
 * Escape, ×) while transactions are in flight; `onClose` may layer its own
 * guards (e.g. a discard-confirm) on top.
 */
export function ModalShell({
  title,
  subtitle,
  onClose,
  busy = false,
  maxWidth = 'max-w-2xl',
  children,
}: {
  title: ReactNode
  subtitle?: ReactNode
  onClose: () => void
  busy?: boolean
  maxWidth?: string
  children: ReactNode
}) {
  const titleId = useId()

  const close = useCallback(() => {
    if (!busy) onClose()
  }, [busy, onClose])

  return (
    <ModalDialog
      onClose={close}
      dismissible={!busy}
      labelledBy={titleId}
      className="items-start justify-center px-3 py-5 sm:px-6 sm:py-10"
    >
      <div
        className={`card w-full ${maxWidth} overflow-hidden shadow-[0_24px_72px_rgba(19,17,25,0.28)]`}
      >
        <div className="flex items-start justify-between gap-4 border-b border-smoke-200 px-5 py-4 sm:px-6">
          <div>
            <h2 id={titleId} className="font-agrandir text-xl font-medium text-ink">
              {title}
            </h2>
            {subtitle ? (
              <p className="mt-1 text-xs leading-relaxed text-smoke-700">
                {subtitle}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={close}
            disabled={busy}
            aria-label="Close"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-xl text-smoke-700 hover:bg-smoke-75 hover:text-ink disabled:opacity-50"
          >
            ×
          </button>
        </div>

        <div className="max-h-[calc(100vh-10rem)] overflow-y-auto px-5 py-5 sm:px-6">
          {children}
        </div>
      </div>
    </ModalDialog>
  )
}
