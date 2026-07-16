import { chainName } from '@/lib/urn'

/**
 * Solid block chain chips (DESIGN.md §Chip mosaic). Every combination is
 * checked ≥ 4.5:1: ink on #4a4553 = 8.1, white on #b91c1c = 6.5, white on
 * #274690 = 8.9, white on #1a5db4 = 6.4, white on #6b6577 = 5.6.
 */
const CHIP: Record<number, { label: string; className: string }> = {
  1: { label: 'ETH', className: 'bg-[#4a4553] text-ink' },
  10: { label: 'OP', className: 'bg-[#b91c1c] text-white' },
  8453: { label: 'BASE', className: 'bg-navy text-white' },
  42161: { label: 'ARB', className: 'bg-[#1a5db4] text-white' },
  11155111: { label: 'SEP', className: 'bg-[#6b6577] text-white' },
  11155420: { label: 'OP SEP', className: 'bg-[#b91c1c] text-white' },
  84532: { label: 'BASE SEP', className: 'bg-navy text-white' },
  421614: { label: 'ARB SEP', className: 'bg-[#1a5db4] text-white' },
}

export function ChainBadge({
  chainId,
  full = false,
}: {
  chainId: number
  /** Spell out the full chain name instead of the short code. */
  full?: boolean
}) {
  const chip = CHIP[chainId] ?? {
    label: `#${chainId}`,
    className: 'bg-[#4a4553] text-ink',
  }
  return (
    <span
      className={`chip ${chip.className}`}
      title={chainName(chainId)}
    >
      {full ? chainName(chainId) : chip.label}
    </span>
  )
}
