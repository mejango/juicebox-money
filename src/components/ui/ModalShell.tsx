'use client'

import { useCallback, useEffect, useId, type ReactNode } from 'react'

/**
 * The shared modal chrome: fixed overlay with backdrop-click close, body
 * scroll-lock + Escape-close while mounted, and a bordered header with the
 * title and a × button. `busy` blocks every close path (backdrop, Escape,
 * ×) while transactions are in flight; `onClose` may layer its own guards
 * (e.g. a discard-confirm) on top.
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

  useEffect(() => {
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.body.style.overflow = previous
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [close])

  return (
    <div
      className="fixed inset-0 z-[80] flex items-start justify-center overflow-y-auto bg-slate-950/55 px-3 py-5 sm:px-6 sm:py-10"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onMouseDown={event => {
        if (event.target === event.currentTarget) close()
      }}
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
    </div>
  )
}
