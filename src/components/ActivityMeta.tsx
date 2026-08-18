import { ChainIcon } from '@/components/ChainIcon'
import { explorerHostname } from '@/lib/chainDisplay'
import { formatTokenAmount, formatUsd18 } from '@/lib/format'
import { chainName } from '@/lib/urn'

/**
 * The accounting-token denomination for a feed whose project accounts in a
 * single token kind on every chain: the raw indexed amount plus how to
 * label it.
 */
export type ActivityAmountToken = {
  raw: string | null | undefined
  symbol: string
  decimals: number
}

/**
 * Bendystraw stores indexed USD amounts as 18-decimal fixed point values.
 *
 * Delegates to the canonical `formatUsd18` rather than re-deriving: this used to divide
 * through `Number`, which truncates, and rounded via `toLocaleString` instead of the
 * half-up BigInt path — so the feed could disagree with every other USD figure in the app.
 */
function formatIndexedUsd(raw: string | null | undefined): string | null {
  if (!raw) return null
  try {
    const value = BigInt(raw)
    // Genuinely-zero amounts (e.g. credit-funded pays) show no amount at all.
    if (value <= 0n) return null
    return formatUsd18(value, { compact: true })
  } catch {
    return null
  }
}

/** Genuinely-zero amounts (e.g. credit-funded pays) show no amount at all. */
function formatIndexedToken(token: ActivityAmountToken): string | null {
  if (!token.raw) return null
  try {
    if (BigInt(token.raw) <= 0n) return null
    return `${formatTokenAmount(token.raw, token.decimals)} ${token.symbol}`
  } catch {
    return null
  }
}

/** The formatted flow amount for a row, or null when zero or absent. */
export function activityAmountLabel(
  amountUsd: string | null | undefined,
  amountToken?: ActivityAmountToken | null,
): string | null {
  return amountToken
    ? formatIndexedToken(amountToken)
    : formatIndexedUsd(amountUsd)
}

/** "on <chain>" — sits next to the row's time; the icon links to the tx. */
export function ActivityOnChain({
  chainId,
  txHash,
}: {
  chainId: number
  txHash: string
}) {
  const explorer = explorerHostname(chainId)
  const txUrl = explorer ? `https://${explorer}/tx/${txHash}` : null
  return (
    <>
      <span>on</span>
      {txUrl ? (
        <a
          href={txUrl}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`View transaction on ${chainName(chainId)}`}
          className="inline-flex transition-opacity hover:opacity-70"
        >
          <ChainIcon chainId={chainId} size={18} />
        </a>
      ) : (
        <ChainIcon chainId={chainId} size={18} standalone />
      )}
    </>
  )
}

/**
 * The row's flow cluster: the in/out tag, then the bold amount. Renders an
 * (empty) span even without a flow so flex layouts keep their two sides.
 */
export function ActivityAmountLine({
  amountUsd,
  amountToken,
  direction,
}: {
  amountUsd: string | null | undefined
  amountToken?: ActivityAmountToken | null
  direction?: 'in' | 'out' | null
}) {
  const amount = activityAmountLabel(amountUsd, amountToken)

  return (
    <span className="flex min-w-0 items-center gap-1.5 text-sm text-smoke-500">
      {direction === 'in' || direction === 'out' ? (
        <span
          className={`inline-flex h-5 min-w-7 items-center justify-center border px-1.5 text-center text-[10px] font-medium capitalize leading-none ${
            direction === 'in'
              ? 'border-bluebs-500 text-bluebs-600'
              : 'border-peel-500 text-peel-600'
          }`}
        >
          {direction}
        </span>
      ) : null}
      {amount ? (
        <span className="truncate font-semibold text-ink">{amount}</span>
      ) : null}
    </span>
  )
}

/** "to" for outflows, "from" for inflows, "by" for everything else. */
export function actorPrefix(direction: 'in' | 'out' | null | undefined): string {
  return direction === 'out' ? 'to' : direction === 'in' ? 'from' : 'by'
}

/** Shared activity direction/value/chain cluster used by both activity feeds. */
export function ActivityMeta({
  chainId,
  txHash,
  amountUsd,
  amountToken,
  direction,
  showAmount = true,
}: {
  chainId: number
  txHash: string
  amountUsd: string | null | undefined
  /**
   * When set, the feed's project accounts in exactly one token kind, so the
   * raw amount is rendered in it instead of the indexed USD value.
   */
  amountToken?: ActivityAmountToken | null
  direction?: 'in' | 'out' | null
  /** false = the row renders the amount itself (as its own line). */
  showAmount?: boolean
}) {
  const explorer = explorerHostname(chainId)
  const txUrl = explorer
    ? `https://${explorer}/tx/${txHash}`
    : null
  const amount = showAmount
    ? activityAmountLabel(amountUsd, amountToken)
    : null

  return (
    <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs text-smoke-500">
      {amount ? <span>{amount}</span> : null}
      {direction === 'in' || direction === 'out' ? (
        <span
          className={`inline-flex h-5 min-w-7 items-center justify-center border px-1.5 text-center text-[10px] font-medium capitalize leading-none ${
            direction === 'in'
              ? 'border-bluebs-500 text-bluebs-600'
              : 'border-peel-500 text-peel-600'
          }`}
        >
          {direction}
        </span>
      ) : null}
      {txUrl ? (
        <a
          href={txUrl}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`View transaction on ${chainName(chainId)}`}
          className="inline-flex transition-opacity hover:opacity-70"
        >
          <ChainIcon chainId={chainId} size={18} />
        </a>
      ) : (
        <ChainIcon chainId={chainId} size={18} standalone />
      )}
    </span>
  )
}
