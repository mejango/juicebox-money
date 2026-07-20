'use client'

import type { ReactNode } from 'react'
import { ChainIcon } from '@/components/ChainIcon'
import { toggleInSet } from '@/lib/authority'

export type ChainPickerRow = {
  chainId: number
  /** The row's label after the chain icon (usually the chain name). */
  name: ReactNode
  /** Disables the row's checkbox and fades the row. */
  disabled?: boolean
  /** Hover title (e.g. the reason the row is disabled). */
  title?: string
}

/**
 * The multi-chain checkbox picker every authority card uses: a field label
 * over one checkbox-per-chain row. `onChange` receives the toggled copy of
 * `selected`; `disabled` freezes every row (a row's own `disabled` fades and
 * freezes just that row). `rowClassName` overrides the per-row label class
 * for callers with bespoke styling.
 */
export function ChainPicker({
  label,
  rows,
  selected,
  onChange,
  disabled,
  className,
  rowClassName,
}: {
  label: string
  rows: ChainPickerRow[]
  selected: Set<number>
  onChange: (next: Set<number>) => void
  disabled: boolean
  className?: string
  rowClassName?: (row: ChainPickerRow) => string
}) {
  return (
    <div className={className}>
      <span className="field-label">{label}</span>
      <div className="mt-2 flex flex-wrap gap-2">
        {rows.map(row => (
          <label
            key={row.chainId}
            className={
              rowClassName
                ? rowClassName(row)
                : `flex items-center gap-2 rounded-lg border border-smoke-200 px-3 py-2 text-sm ${
                    row.disabled ? 'opacity-50' : 'cursor-pointer'
                  }`
            }
            title={row.title}
          >
            <input
              type="checkbox"
              checked={selected.has(row.chainId)}
              onChange={() => onChange(toggleInSet(selected, row.chainId))}
              disabled={disabled || !!row.disabled}
              className="accent-bluebs-600"
            />
            <ChainIcon chainId={row.chainId} size={18} />
            {row.name}
          </label>
        ))}
      </div>
    </div>
  )
}
