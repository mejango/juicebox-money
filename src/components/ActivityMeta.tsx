import { ChainIcon } from '@/components/ChainIcon'
import { TxDebugPromptLink } from '@/components/TxDebugPromptLink'
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
  also = [],
}: {
  chainId: number
  txHash: string
  /** Further chains carrying this same action; each icon links its own tx. */
  also?: { chainId: number; txHash: string }[]
}) {
  const entries = [{ chainId, txHash }, ...also]
  // Several chains read as one action: full-size icons overlapped like an
  // avatar stack — leftmost on top — each still its own tx link.
  const stacked = entries.length > 1
  return (
    <>
      <span>on</span>
      <span className="inline-flex items-center">
        {entries.map((entry, index) => {
          const explorer = explorerHostname(entry.chainId)
          const txUrl = explorer ? `https://${explorer}/tx/${entry.txHash}` : null
          const overlap = stacked && index > 0 ? '-ml-1.5' : ''
          const depth = stacked ? { zIndex: entries.length - index } : undefined
          return txUrl ? (
            <a
              key={entry.chainId}
              href={txUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`View transaction on ${chainName(entry.chainId)}`}
              className={`relative inline-flex rounded-full transition-opacity hover:z-10 hover:opacity-70 ${overlap}`}
              style={depth}
            >
              <ChainIcon chainId={entry.chainId} size={18} />
            </a>
          ) : (
            <span
              key={entry.chainId}
              className={`relative inline-flex ${overlap}`}
              style={depth}
            >
              <ChainIcon chainId={entry.chainId} size={18} standalone />
            </span>
          )
        })}
      </span>
      <TxDebugPromptLink calls={entries} />
    </>
  )
}

/**
 * A project-token headline for rows that move tokens rather than value: the
 * formatted count ("3.6m ART") and the tag that says how they moved.
 */
export type ActivityHeadline = {
  amount: string
  tag: 'reserved distro'
}

const FLOW_TAG_CLASS: Record<'in' | 'out' | ActivityHeadline['tag'], string> = {
  in: 'border-bluebs-500 text-bluebs-600',
  out: 'border-peel-500 text-peel-600',
  'reserved distro': 'border-melon-500 text-melon-700',
}

/**
 * The row's flow cluster: the bold amount, then the in/out tag. Renders an
 * (empty) span even without a flow so flex layouts keep their two sides.
 */
export function ActivityAmountLine({
  amountUsd,
  amountToken,
  direction,
  kind,
  headline,
}: {
  amountUsd: string | null | undefined
  amountToken?: ActivityAmountToken | null
  direction?: 'in' | 'out' | null
  /** What happened, for rows that move no value — shown instead of in/out. */
  kind?: string | null
  /** A token-count headline with its own tag; takes the amount's place. */
  headline?: ActivityHeadline | null
}) {
  const amount = headline?.amount ?? activityAmountLabel(amountUsd, amountToken)
  const tag = headline
    ? headline.tag
    : amount && (direction === 'in' || direction === 'out')
      ? direction
      : null

  return (
    <span className="flex min-w-0 items-center gap-1.5 text-sm text-smoke-500">
      {amount ? (
        <span className="truncate font-semibold text-ink">{amount}</span>
      ) : kind ? (
        <span className="inline-flex h-5 items-center border border-smoke-300 px-1.5 text-[10px] font-medium leading-none text-smoke-600">
          {kind}
        </span>
      ) : null}
      {tag ? (
        <span
          className={`inline-flex h-5 min-w-7 items-center justify-center border px-1.5 text-center text-[10px] font-medium leading-none ${FLOW_TAG_CLASS[tag]}`}
        >
          {tag}
        </span>
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
  const hasAmount = activityAmountLabel(amountUsd, amountToken) !== null
  const amount = showAmount
    ? activityAmountLabel(amountUsd, amountToken)
    : null

  return (
    <span className="flex min-w-0 items-center gap-1.5 whitespace-nowrap text-xs text-smoke-500">
      {amount ? <span className="truncate">{amount}</span> : null}
      {hasAmount && (direction === 'in' || direction === 'out') ? (
        <span
          className={`inline-flex h-5 min-w-7 shrink-0 items-center justify-center border px-1.5 text-center text-[10px] font-medium leading-none ${
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
          className="inline-flex shrink-0 transition-opacity hover:opacity-70"
        >
          <ChainIcon chainId={chainId} size={18} />
        </a>
      ) : (
        <ChainIcon chainId={chainId} size={18} standalone />
      )}
    </span>
  )
}
