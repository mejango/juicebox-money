'use client'

import type { ReactNode } from 'react'

/** Shared create-flow UI primitives. */

/** Render " | "-separated text with subtle, spaced pipes. */
export function Piped({ text }: { text: string }) {
  const parts = text.split(' | ')
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-2">
      {parts.map((part, i) => (
        <span key={i} className="whitespace-nowrap">
          {part}
          {i < parts.length - 1 ? (
            <span
              aria-hidden
              className="ml-2 hidden text-smoke-300 sm:inline"
            >
              |
            </span>
          ) : null}
        </span>
      ))}
    </span>
  )
}

export function CheckIcon({ className }: { className: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="m5 13 4 4L19 7" />
    </svg>
  )
}

/** Selectable row shared by OptionRow (radio mark) and CheckRow (square mark). */
function SelectableRow({
  kind,
  checked,
  onActivate,
  disabled,
  title,
  blurb,
}: {
  kind: 'radio' | 'checkbox'
  checked: boolean
  onActivate: () => void
  disabled: boolean
  title: string
  /** A node, not just a string: some rows carry a list of what they grant. It stays phrasing
   *  content — this row is a `<button>`, and a `<ul>` inside one is invalid. */
  blurb: ReactNode
}) {
  return (
    <button
      type="button"
      role={kind}
      onClick={onActivate}
      disabled={disabled}
      aria-checked={checked}
      className="group flex min-h-[52px] w-full items-start gap-3 rounded-lg border border-smoke-200 bg-white px-3 py-2.5 text-left transition-colors hover:border-bluebs-200 hover:bg-grey-50 focus-visible:border-bluebs-400 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40"
    >
      {kind === 'radio' ? (
        <span
          className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border bg-white transition-shadow group-focus-visible:ring-4 group-focus-visible:ring-bluebs-50 ${
            checked ? 'border-bluebs-500' : 'border-grey-300'
          }`}
        >
          {checked ? <span className="h-2 w-2 rounded-full bg-bluebs-500" /> : null}
        </span>
      ) : (
        <span
          className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border transition-shadow group-focus-visible:ring-4 group-focus-visible:ring-bluebs-50 ${
            checked
              ? 'border-bluebs-600 bg-bluebs-600'
              : 'border-grey-300 bg-white'
          }`}
        >
          {checked ? <CheckIcon className="h-3 w-3 text-white" /> : null}
        </span>
      )}
      <span className="min-w-0">
        <span className="block text-sm font-medium text-ink">{title}</span>
        <span className="mt-0.5 block text-xs leading-relaxed text-smoke-700">
          {blurb}
        </span>
      </span>
    </button>
  )
}

/** One questionnaire choice: radio-style row with a title and a one-liner. */
export function OptionRow({
  checked,
  onSelect,
  disabled,
  title,
  blurb,
}: {
  checked: boolean
  onSelect: () => void
  disabled: boolean
  title: string
  blurb: string
}) {
  return (
    <SelectableRow
      kind="radio"
      checked={checked}
      onActivate={onSelect}
      disabled={disabled}
      title={title}
      blurb={blurb}
    />
  )
}

/** Checkbox-style row (same look as OptionRow, square mark). */
export function CheckRow({
  checked,
  onToggle,
  disabled,
  title,
  blurb,
}: {
  checked: boolean
  onToggle: () => void
  disabled: boolean
  title: string
  blurb: ReactNode
}) {
  return (
    <SelectableRow
      kind="checkbox"
      checked={checked}
      onActivate={onToggle}
      disabled={disabled}
      title={title}
      blurb={blurb}
    />
  )
}

/** Friendly dashed add-pill ("+ Add a recipient", "+ Add an item"). */
export function AddButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void
  disabled: boolean
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="group inline-flex min-h-[40px] items-center gap-2 rounded-full border border-dashed border-grey-400 bg-white py-1.5 pl-1.5 pr-4 text-xs font-medium text-grey-700 transition-colors hover:border-bluebs-500 hover:text-bluebs-700 disabled:opacity-60"
    >
      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-bluebs-100 font-agrandir text-sm text-bluebs-700 transition-colors group-hover:bg-bluebs-600 group-hover:text-white">
        +
      </span>
      {children}
    </button>
  )
}

/** Compact rectangular toggle (tax rates, modes, currencies). */
export function ChipButton({
  active,
  onClick,
  disabled,
  children,
}: {
  active: boolean
  onClick: () => void
  disabled: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={
        active
          ? 'inline-flex min-h-[40px] items-center rounded-lg border border-bluebs-500 bg-bluebs-25 px-3.5 text-xs font-medium text-bluebs-700 shadow-[0_1px_4px_rgba(39,79,245,0.12)] transition-colors focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40'
          : 'inline-flex min-h-[40px] items-center rounded-lg border border-grey-300 bg-white px-3.5 text-xs font-medium text-grey-700 transition-colors hover:border-bluebs-300 hover:text-bluebs-600 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40'
      }
    >
      {children}
    </button>
  )
}

/** Rotate-on-expand chevron used by collapsible headers. */
export function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={`h-4 w-4 shrink-0 text-smoke-500 transition-transform ${open ? 'rotate-180' : ''}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}

/** Collapsible subsection: label + summary when closed. */
export function SubSection({
  label,
  summary,
  open,
  onToggle,
  children,
}: {
  label: string
  summary: string
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  return (
    <div className="mt-3 rounded-xl border border-grey-200 bg-white">
      <button
        onClick={onToggle}
        aria-expanded={open}
        className="flex min-h-[52px] w-full items-center justify-between gap-3 px-4 py-3 text-left"
      >
        <span className="field-label !text-smoke-700">{label}</span>
        <span className="flex min-w-0 items-center gap-2.5">
          {!open ? (
            <span className="truncate text-sm font-medium text-ink">
              <Piped text={summary} />
            </span>
          ) : null}
          <Chevron open={open} />
        </span>
      </button>
      {open ? <div className="px-4 pb-4">{children}</div> : null}
    </div>
  )
}
