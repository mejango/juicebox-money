'use client'

import { useEffect, useId, useRef, type ReactNode } from 'react'
import type { ReviewContextRow } from '@bananapus/nana-sdk-core/review'
import { createPortal } from 'react-dom'
import {
  ModalCloseButton,
  ModalDialog,
  useEnclosingModalCard,
  useHoldEnclosingModal,
} from '@/components/ui/ModalShell'
import { TxSteps, type TxStep } from '@/components/ui/TxSteps'
import { LoadingText } from '@/components/ui/LoadingText'
import { transactionMessage } from '@/lib/transaction-message'

export type TxConfirmRow = {
  label: ReactNode
  value: ReactNode
  /** Render the value in a monospace face (addresses, hashes). */
  mono?: boolean
  /** Emphasize the value (the amount that leaves the wallet). */
  strong?: boolean
}

/** A follow-up the action offers after it ran: try again, recheck, resume. It never confirms a send; the review does. */
export type TxProgressRetry = { label: string; onClick: () => void; disabled?: boolean }

/** The rows a review shows as the site's own summary: those whose label and value are text. */
export function contextRows(rows: readonly TxConfirmRow[]): ReviewContextRow[] {
  return rows.flatMap(row => {
    const text = (node: ReactNode) => typeof node === 'string' || typeof node === 'number' || typeof node === 'bigint' ? String(node) : null
    const label = text(row.label)
    const value = text(row.value)
    return label === null || value === null ? [] : [{ label, value, ...(row.strong ? { strong: true } : {}), ...(row.mono ? { mono: true } : {}) }]
  })
}

/**
 * An action's progress: its frozen plan (label/value rows), the wallet-prompt
 * queue, status and error. The review is the action's one confirmation, so
 * this starts the action (`start`) once its plan is ready and offers only
 * follow-ups (`retry`). Closing is refused while `busy`; once `complete` the
 * footer collapses to Done.
 */
export function TxProgress({
  open,
  onClose,
  eyebrow = 'Review',
  title,
  rows,
  children,
  notice,
  steps,
  activeIndex,
  stepsIntro,
  start,
  startKey,
  retry,
  cancelLabel = 'Cancel',
  onCancel,
  busy = false,
  complete = false,
  preparing = false,
  status,
  error,
}: {
  open: boolean
  onClose: () => void
  eyebrow?: string | null
  title: ReactNode
  rows?: readonly TxConfirmRow[]
  /** Extra body content under the rows (warnings, notes, custom grids). */
  children?: ReactNode
  /** Project notice or disclosure at the end of the body, above the actions. */
  notice?: ReactNode
  steps: readonly TxStep[]
  activeIndex: number
  stepsIntro?: string
  /** Starts the action once it is open and prepared; its review is the one confirmation. */
  start?: () => void
  /** A multi-step action's current step: a new key starts that step's review once it is ready. */
  startKey?: unknown
  retry?: TxProgressRetry | null
  cancelLabel?: string
  /** Stops the work in progress without cost; the Cancel button stays live while busy. */
  onCancel?: () => void
  busy?: boolean
  complete?: boolean
  /** Rows and steps are still being read; `status` says what is happening. */
  preparing?: boolean
  status?: ReactNode
  error?: ReactNode
}) {
  const titleId = useId()
  // Inside a ModalShell already, the confirm replaces that card's content in
  // place: one scrim, one card, and closing brings the form back.
  const host = useEnclosingModalCard()
  // Hosted, the confirm has no dialog of its own: while busy it keeps the
  // enclosing shell open, or Escape there would drop a send in flight.
  useHoldEnclosingModal(open && busy)
  // Started once per open and step: each step's review is its own confirmation, with no click between.
  const started = useRef<{ key: unknown } | null>(null)
  useEffect(() => {
    if (!open) { started.current = null; return }
    if (preparing || !start || (started.current && Object.is(started.current.key, startKey))) return
    started.current = { key: startKey }
    start()
  }, [open, preparing, start, startKey])
  useEffect(() => {
    if (!host || !open) return
    const hidden = Array.from(host.children).filter(
      (child): child is HTMLElement =>
        child instanceof HTMLElement &&
        !child.hasAttribute('data-tx-confirm') &&
        !child.hidden,
    )
    hidden.forEach(child => (child.hidden = true))
    return () => hidden.forEach(child => (child.hidden = false))
  }, [host, open])
  if (!open) return null
  const section = (
    <section
      data-tx-confirm
      className={
        host
          ? 'w-full bg-bone'
          : 'w-full max-w-lg overflow-hidden rounded-2xl border border-smoke-300 bg-bone shadow-2xl sm:my-auto'
      }
    >
        <header className="flex items-start justify-between gap-4 border-b border-smoke-200 bg-bone px-5 py-4">
          <div className="min-w-0">
            {eyebrow ? (
              <p className="text-xs font-medium uppercase tracking-wide text-bluebs-600">
                {eyebrow}
              </p>
            ) : null}
            <h2
              id={titleId}
              className={`${eyebrow ? 'mt-1 ' : ''}font-agrandir text-xl font-medium text-ink`}
            >
              {title}
            </h2>
          </div>
          <ModalCloseButton
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
            className="-mr-2 -mt-2 transition-transform hover:scale-110 hover:bg-transparent disabled:opacity-40"
          />
        </header>
        <div className="space-y-4 px-5 py-5">
          {preparing ? (
            <p className="py-2 text-sm text-bluebs-700" role="status">
              {typeof status === 'string' ? <LoadingText text={transactionMessage(status)} active /> : status ?? <LoadingText text="Preparing…" />}
            </p>
          ) : (
            <>
              {rows && rows.length > 0 ? (
                <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                  {rows.map((row, index) => (
                    <TxConfirmRowItem key={index} row={row} />
                  ))}
                </div>
              ) : null}
              {children}
              <TxSteps
                steps={steps}
                activeIndex={complete ? steps.length : activeIndex}
                intro={stepsIntro}
                className="rounded-xl border border-smoke-200 bg-white p-3"
              />
              {status ? <p role="status" className="text-sm text-bluebs-700">{typeof status === 'string' ? <LoadingText text={transactionMessage(status)} active={busy || !retry || undefined} /> : status}</p> : null}
            </>
          )}
          {error ? <p role="alert" className="wrap-anywhere text-sm text-red-600">{typeof error === 'string' ? <LinkedText text={transactionMessage(error)} /> : error}</p> : null}
          {notice}
        </div>
        {complete || retry || !busy || onCancel ? (
          <footer className="flex justify-end gap-2 border-t border-smoke-200 bg-bone px-5 py-4">
            {complete ? (
              <button
                type="button"
                className="btn-primary min-h-[44px] px-5 text-sm"
                onClick={onClose}
              >
                Done
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="btn-secondary min-h-[44px] px-5 text-sm"
                  disabled={busy && !onCancel}
                  onClick={busy ? onCancel : onClose}
                >
                  {cancelLabel}
                </button>
                {retry ? (
                  <button
                    type="button"
                    className="btn-primary min-h-[44px] px-5 text-sm"
                    disabled={busy || preparing || retry.disabled}
                    onClick={retry.onClick}
                  >
                    {retry.label}
                  </button>
                ) : null}
              </>
            )}
          </footer>
        ) : null}
    </section>
  )
  if (host) return createPortal(section, host)
  return (
    <ModalDialog
      onClose={onClose}
      dismissible={!busy}
      labelledBy={titleId}
      className="items-start justify-center px-3 py-6"
    >
      {section}
    </ModalDialog>
  )
}

/** An explorer address inside a message becomes a link, so the line can say where to look. */
function LinkedText({ text }: { text: string }) {
  return (
    <>
      {text.split(/(https:\/\/[^\s]+?)(?=[.,;]?(?:\s|$))/).map((part, index) =>
        index % 2 ? (
          <a key={index} href={part} target="_blank" rel="noopener noreferrer" className="underline">
            {part}
          </a>
        ) : (
          part
        ),
      )}
    </>
  )
}

function TxConfirmRowItem({ row }: { row: TxConfirmRow }) {
  return (
    <>
      <span className="text-smoke-500">{row.label}</span>
      <span
        className={`min-w-0 text-right text-ink ${
          row.mono ? 'break-all font-mono text-xs' : 'break-words'
        } ${row.strong ? 'font-medium' : ''}`}
      >
        {row.value}
      </span>
    </>
  )
}
