'use client'

import { useId, type ReactNode } from 'react'
import { ModalCloseButton, ModalDialog } from '@/components/ui/ModalShell'
import { TxSteps } from '@/components/ui/TxSteps'

export type TxConfirmRow = {
  label: ReactNode
  value: ReactNode
  /** Render the value in a monospace face (addresses, hashes). */
  mono?: boolean
  /** Emphasize the value (the amount that leaves the wallet). */
  strong?: boolean
}

/**
 * The one review surface for every wallet write: a frozen plan (label/value
 * rows), the wallet-prompt queue, then a single action. Closing is refused
 * while `busy`; once `complete` the footer collapses to Done.
 */
export function TxConfirmDialog({
  open,
  onClose,
  eyebrow = 'Review',
  title,
  rows,
  children,
  steps,
  activeIndex,
  stepsIntro,
  action,
  actionDisabled = false,
  cancelLabel = 'Cancel',
  onConfirm,
  busy = false,
  complete = false,
  status,
  error,
}: {
  open: boolean
  onClose: () => void
  eyebrow?: string
  title: ReactNode
  rows?: readonly TxConfirmRow[]
  /** Extra body content under the rows (warnings, notes, custom grids). */
  children?: ReactNode
  steps: readonly { key?: string; title: ReactNode; detail?: string }[]
  activeIndex: number
  stepsIntro?: string
  action: string
  actionDisabled?: boolean
  cancelLabel?: string
  onConfirm: () => void
  busy?: boolean
  complete?: boolean
  status?: ReactNode
  error?: ReactNode
}) {
  const titleId = useId()
  if (!open) return null
  return (
    <ModalDialog
      onClose={onClose}
      dismissible={!busy}
      labelledBy={titleId}
      className="items-start justify-center px-3 py-6 sm:items-center"
    >
      <section className="w-full max-w-lg overflow-hidden rounded-2xl border border-smoke-300 bg-bone shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-smoke-200 bg-bone px-5 py-4">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-wide text-bluebs-600">
              {eyebrow}
            </p>
            <h2
              id={titleId}
              className="mt-1 font-agrandir text-xl font-medium text-ink"
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
          {status ? <p className="text-sm text-bluebs-700">{status}</p> : null}
          {error ? <p className="text-sm text-red-600">{error}</p> : null}
        </div>
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
                disabled={busy}
                onClick={onClose}
              >
                {cancelLabel}
              </button>
              <button
                type="button"
                className="btn-primary min-h-[44px] px-5 text-sm"
                disabled={busy || actionDisabled}
                onClick={onConfirm}
              >
                {action}
              </button>
            </>
          )}
        </footer>
      </section>
    </ModalDialog>
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
