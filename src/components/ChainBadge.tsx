import { chainName } from '@/lib/urn'

/**
 * Tinted chain chips (DESIGN.md §Chips): soft fruit-scale tints with their
 * dark text stops. Every combination is checked ≥ 4.5:1: grey-700 on
 * smoke-100 = 8.5, peel-800 on peel-100 = 8.4, bluebs-700 on bluebs-100 =
 * 5.1, grape-700 on grape-100 = 9.5.
 */
const CHIP: Record<number, { label: string; className: string }> = {
  1: { label: 'ETH', className: 'bg-smoke-100 text-grey-700' },
  10: { label: 'OP', className: 'bg-peel-100 text-peel-800' },
  8453: { label: 'BASE', className: 'bg-bluebs-100 text-bluebs-700' },
  42161: { label: 'ARB', className: 'bg-grape-100 text-grape-700' },
  11155111: { label: 'SEP', className: 'bg-smoke-100 text-grey-700' },
  11155420: { label: 'OP SEP', className: 'bg-peel-100 text-peel-800' },
  84532: { label: 'BASE SEP', className: 'bg-bluebs-100 text-bluebs-700' },
  421614: { label: 'ARB SEP', className: 'bg-grape-100 text-grape-700' },
}

/** The tint pair for a chain, for chips rendered outside this component. */
export function chainChipClass(chainId: number): string {
  return (CHIP[chainId] ?? { className: 'bg-smoke-100 text-grey-700' })
    .className
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
    className: 'bg-smoke-100 text-grey-700',
  }
  return (
    <span className={`chip ${chip.className}`} title={chainName(chainId)}>
      {full ? chainName(chainId) : chip.label}
    </span>
  )
}
