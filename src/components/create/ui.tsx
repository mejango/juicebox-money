'use client'

/** Shared create-flow UI primitives. */

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
    <button
      onClick={onSelect}
      disabled={disabled}
      aria-pressed={checked}
      className={`flex w-full items-start gap-3 rounded-xl border px-4 py-3.5 text-left transition-colors disabled:opacity-60 ${
        checked
          ? 'border-ink bg-white'
          : 'border-smoke-200 bg-white hover:border-smoke-400'
      }`}
    >
      <span
        className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 ${
          checked ? 'border-ink bg-ink' : 'border-smoke-300'
        }`}
      >
        {checked ? <CheckIcon className="h-3 w-3 text-bone" /> : null}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-ink">{title}</span>
        <span className="mt-0.5 block text-xs leading-relaxed text-smoke-700">
          {blurb}
        </span>
      </span>
    </button>
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
  blurb: string
}) {
  return (
    <button
      onClick={onToggle}
      disabled={disabled}
      aria-pressed={checked}
      className={`flex w-full items-start gap-3 rounded-xl border px-4 py-3.5 text-left transition-colors disabled:opacity-60 ${
        checked
          ? 'border-ink bg-white'
          : 'border-smoke-200 bg-white hover:border-smoke-400'
      }`}
    >
      <span
        className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border-2 ${
          checked ? 'border-ink bg-ink' : 'border-smoke-300'
        }`}
      >
        {checked ? <CheckIcon className="h-3 w-3 text-bone" /> : null}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-ink">{title}</span>
        <span className="mt-0.5 block text-xs leading-relaxed text-smoke-700">
          {blurb}
        </span>
      </span>
    </button>
  )
}

/** Small pill chip toggle (tax rates, modes, currencies). */
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
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={
        active
          ? 'inline-flex min-h-[40px] items-center rounded-full bg-split-100 px-4 text-xs font-medium text-ink ring-1 ring-ink disabled:opacity-60'
          : 'inline-flex min-h-[40px] items-center rounded-full border border-smoke-300 bg-white px-4 text-xs font-medium text-smoke-700 hover:border-smoke-400 hover:text-ink disabled:opacity-60'
      }
    >
      {children}
    </button>
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
    <div className="mt-3 rounded-xl border border-smoke-200 bg-white">
      <button
        onClick={onToggle}
        aria-expanded={open}
        className="flex min-h-[52px] w-full items-center justify-between gap-3 px-4 py-3 text-left"
      >
        <span className="field-label !text-smoke-700">{label}</span>
        <span className="flex min-w-0 items-center gap-2.5">
          {!open ? (
            <span className="truncate text-sm font-medium text-ink">
              {summary}
            </span>
          ) : null}
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
        </span>
      </button>
      {open ? <div className="px-4 pb-4">{children}</div> : null}
    </div>
  )
}
