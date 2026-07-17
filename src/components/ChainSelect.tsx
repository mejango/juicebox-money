'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { chainName } from '@/lib/urn'
import { ChainIcon } from './ChainIcon'

function CaretIcon({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`h-5 w-5 shrink-0 text-grey-500 transition-transform ${
        open ? 'rotate-180' : ''
      }`}
      aria-hidden
    >
      <path d="m5 7.5 5 5 5-5" />
    </svg>
  )
}

function SelectedMark() {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-5 w-5 text-bluebs-500"
      aria-hidden
    >
      <path d="m4.5 10 3.25 3.25L15.5 5.5" />
    </svg>
  )
}

function useChainMenu() {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [open])

  return { open, setOpen, rootRef }
}

function MenuRow({
  chainId,
  selected,
  onSelect,
  disabled,
  multiple = false,
}: {
  chainId: number
  selected: boolean
  onSelect: () => void
  disabled: boolean
  multiple?: boolean
}) {
  const name = chainName(chainId)
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      aria-label={
        multiple ? `${selected ? 'Remove' : 'Add'} ${name}` : `Select ${name}`
      }
      onClick={onSelect}
      disabled={disabled}
      className={`flex min-h-[56px] w-full items-center gap-3 px-4 text-left text-base transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        selected
          ? 'bg-bluebs-25 text-grey-900'
          : 'bg-white text-grey-900 hover:bg-grey-50'
      }`}
    >
      <ChainIcon chainId={chainId} size={30} />
      <span className="min-w-0 flex-1 truncate">{name}</span>
      {selected ? <SelectedMark /> : null}
    </button>
  )
}

export function ChainSelect({
  options,
  value,
  onChange,
  disabled = false,
  placeholder = 'Select a chain',
  className = '',
}: {
  options: readonly number[]
  value: number | null
  onChange: (chainId: number) => void
  disabled?: boolean
  placeholder?: string
  className?: string
}) {
  const { open, setOpen, rootRef } = useChainMenu()
  const menuId = useId()
  const label = value === null ? placeholder : chainName(value)

  return (
    <div
      ref={rootRef}
      className={`relative min-w-0 ${className}`}
      onKeyDown={event => event.key === 'Escape' && setOpen(false)}
    >
      <button
        type="button"
        onClick={() => !disabled && setOpen(current => !current)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={value === null ? placeholder : `Selected chain: ${label}`}
        className="flex min-h-[52px] w-full items-center gap-3 rounded-lg border border-grey-300 bg-white px-3.5 text-left text-grey-900 shadow-[0_2px_8px_rgba(0,0,0,0.06)] transition-colors hover:border-bluebs-300 disabled:cursor-not-allowed disabled:bg-grey-25 disabled:text-grey-400"
      >
        {value !== null ? <ChainIcon chainId={value} size={30} /> : null}
        <span className="min-w-0 flex-1 truncate text-base font-medium">
          {label}
        </span>
        <CaretIcon open={open} />
      </button>

      {open ? (
        <div
          id={menuId}
          role="listbox"
          aria-label="Chains"
          className="absolute inset-x-0 top-full z-50 mt-2 overflow-hidden rounded-xl border border-grey-200 bg-white py-1 shadow-[0_12px_30px_rgba(0,0,0,0.12)]"
        >
          {options.map(chainId => (
            <MenuRow
              key={chainId}
              chainId={chainId}
              selected={chainId === value}
              disabled={disabled}
              onSelect={() => {
                onChange(chainId)
                setOpen(false)
              }}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

export function MultiChainSelect({
  options,
  values,
  onToggle,
  disabled = false,
  className = '',
}: {
  options: readonly number[]
  values: readonly number[]
  onToggle: (chainId: number) => void
  disabled?: boolean
  className?: string
}) {
  return (
    <div
      role="group"
      aria-label="Chains"
      className={`flex min-w-0 flex-wrap gap-2 ${className}`}
    >
      {options.map(chainId => {
        const selected = values.includes(chainId)
        const name = chainName(chainId)
        return (
          <button
            key={chainId}
            type="button"
            aria-pressed={selected}
            aria-label={`${selected ? 'Remove' : 'Add'} ${name}`}
            onClick={() => onToggle(chainId)}
            disabled={disabled}
            className={`inline-flex min-h-[48px] items-center gap-2 rounded-lg border px-3.5 text-sm font-medium transition-colors focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40 ${
              selected
                ? 'border-bluebs-500 bg-bluebs-25 text-bluebs-700 shadow-[0_1px_4px_rgba(39,79,245,0.12)]'
                : 'border-grey-300 bg-white text-grey-700 hover:border-bluebs-300 hover:text-bluebs-600'
            }`}
          >
            <ChainIcon chainId={chainId} size={26} />
            <span>{name}</span>
          </button>
        )
      })}
    </div>
  )
}
