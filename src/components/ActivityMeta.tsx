import { ChainIcon } from '@/components/ChainIcon'
import { explorerHostname } from '@/lib/chainDisplay'
import { formatTokenAmount } from '@/lib/format'
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

/** Bendystraw stores indexed USD amounts as 18-decimal fixed point values. */
function formatIndexedUsd(raw: string | null | undefined): string | null {
  if (!raw) return null
  try {
    const usd = Number(BigInt(raw) / 1_000_000_000_000n) / 1_000_000
    if (!Number.isFinite(usd) || usd <= 0) return null
    if (usd < 0.01) return '<$0.01'
    return `$${usd.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`
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

/** Shared activity direction/value/chain cluster used by both activity feeds. */
export function ActivityMeta({
  chainId,
  txHash,
  amountUsd,
  amountToken,
  direction,
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
}) {
  const explorer = explorerHostname(chainId)
  const txUrl = explorer
    ? `https://${explorer}/tx/${txHash}`
    : null
  const amount = amountToken
    ? formatIndexedToken(amountToken)
    : formatIndexedUsd(amountUsd)

  return (
    <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs text-smoke-500">
      {amount ? <span>{amount}</span> : null}
      {direction === 'in' || direction === 'out' ? (
        <span
          className={`inline-flex h-5 min-w-7 items-center justify-center border px-1.5 text-center text-[10px] font-medium leading-none ${
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
