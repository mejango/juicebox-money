'use client'

import type { JBChainId } from '@bananapus/nana-sdk-core'
import type { ReactNode } from 'react'
import { ChainIcon } from '@/components/ChainIcon'

/**
 * The selected/unselected chain-pill toggle multi-chain pickers render per
 * chain. `md` is the 44px pill (24px icon); `lg` is the 48px variant (26px
 * icon) with explicit focus-visible/cursor states for form-like pickers.
 */
export function ChainPillButton({
  chainId,
  selected,
  onClick,
  disabled = false,
  size = 'md',
  ariaLabel,
  title,
  children,
}: {
  chainId: JBChainId
  selected: boolean
  onClick: () => void
  disabled?: boolean
  size?: 'md' | 'lg'
  ariaLabel?: string
  title?: string
  children: ReactNode
}) {
  const base =
    size === 'lg'
      ? 'inline-flex min-h-[48px] items-center gap-2 rounded-lg border px-3.5 text-sm font-medium transition-colors focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40'
      : 'inline-flex min-h-[44px] items-center gap-2 rounded-lg border px-3.5 text-sm font-medium transition-colors disabled:opacity-40'
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={ariaLabel}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`${base} ${
        selected
          ? 'border-bluebs-500 bg-bluebs-25 text-bluebs-700 shadow-[0_1px_4px_rgba(39,79,245,0.12)]'
          : 'border-grey-300 bg-white text-grey-700 hover:border-bluebs-300 hover:text-bluebs-600'
      }`}
    >
      <ChainIcon chainId={chainId} size={size === 'lg' ? 26 : 24} />
      {children}
    </button>
  )
}
