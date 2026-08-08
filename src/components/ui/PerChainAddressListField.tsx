'use client'

import { ChainIcon } from '@/components/ChainIcon'

/**
 * One multi-line address LIST per chain, headed "<fieldLabel> per chain" with a
 * "Use first selected value on all" shortcut when more than one chain shows.
 *
 * Used where a call replaces a whole list rather than setting one entry
 * (`setTerminalsOf`), so the box is prefilled with the live list and the user
 * edits it — the single-address variant is how the router terminal got dropped.
 */
export function PerChainAddressListField({
  fieldLabel,
  rows,
  selected,
  values,
  onChange,
  disabled,
  placeholder,
  help,
  className,
}: {
  fieldLabel: string
  rows: { chainId: number; name: string }[]
  selected: Set<number>
  values: Record<number, string>
  onChange: (values: Record<number, string>) => void
  disabled: boolean
  placeholder?: string
  help?: string
  className?: string
}) {
  const copyFirst = () => {
    const first = rows.find(row => selected.has(row.chainId))
    if (!first) return
    const value = values[first.chainId] ?? ''
    onChange(Object.fromEntries(rows.map(row => [row.chainId, value])))
  }

  return (
    <div className={className}>
      <div className="flex items-center justify-between gap-3">
        <span className="field-label">{fieldLabel} per chain</span>
        {rows.length > 1 ? (
          <button
            type="button"
            onClick={copyFirst}
            disabled={disabled}
            className="text-xs text-bluebs-600 hover:underline"
          >
            Use first selected value on all
          </button>
        ) : null}
      </div>
      <div className="mt-2 space-y-2">
        {rows.map(row => (
          <div
            key={row.chainId}
            className={`grid items-start gap-2 sm:grid-cols-[9rem_1fr] ${
              selected.has(row.chainId) ? '' : 'opacity-50'
            }`}
          >
            <span className="flex min-h-[40px] items-center gap-2 text-sm text-smoke-700">
              <ChainIcon chainId={row.chainId} size={18} />
              {row.name}
            </span>
            <textarea
              value={values[row.chainId] ?? ''}
              onChange={event =>
                onChange({ ...values, [row.chainId]: event.target.value })
              }
              disabled={disabled || !selected.has(row.chainId)}
              rows={Math.max(2, (values[row.chainId] ?? '').split('\n').length)}
              spellCheck={false}
              placeholder={placeholder}
              aria-label={`${fieldLabel} on ${row.name}`}
              className="input-well w-full px-3 py-2 font-mono text-xs disabled:opacity-60"
            />
          </div>
        ))}
      </div>
      {help ? <p className="mt-1 text-xs text-smoke-500">{help}</p> : null}
    </div>
  )
}
