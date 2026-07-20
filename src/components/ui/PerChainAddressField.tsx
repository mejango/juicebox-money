'use client'

import type { ReactNode } from 'react'
import { ChainIcon } from '@/components/ChainIcon'
import { AddressField } from '@/components/create/AddressField'

/**
 * One address input per chain, headed "<fieldLabel> per chain" with a
 * "Use first selected value on all" shortcut when more than one chain shows.
 * Rows deselected in `selected` fade and freeze their input. `onChange`
 * always receives the full chainId→value record; `help` renders the muted
 * footnote and `children` append custom content inside the block.
 */
export function PerChainAddressField({
  fieldLabel,
  rows,
  selected,
  values,
  onChange,
  disabled,
  placeholder,
  help,
  className,
  children,
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
  children?: ReactNode
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
            <AddressField
              value={values[row.chainId] ?? ''}
              onChange={value => onChange({ ...values, [row.chainId]: value })}
              disabled={disabled || !selected.has(row.chainId)}
              compact
              placeholder={placeholder}
              ariaLabel={`${fieldLabel} on ${row.name}`}
            />
          </div>
        ))}
      </div>
      {help ? <p className="mt-1 text-xs text-smoke-500">{help}</p> : null}
      {children}
    </div>
  )
}
