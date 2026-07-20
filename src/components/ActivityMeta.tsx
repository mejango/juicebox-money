import { JB_CHAINS, type JBChainId } from '@bananapus/nana-sdk-core'
import { ChainIcon } from '@/components/ChainIcon'

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

/** Shared activity direction/value/chain cluster used by both activity feeds. */
export function ActivityMeta({
  chainId,
  txHash,
  amountUsd,
  direction,
}: {
  chainId: number
  txHash: string
  amountUsd: string | null | undefined
  direction: 'in' | 'out'
}) {
  const chain = JB_CHAINS[chainId as JBChainId]
  const txUrl = chain?.etherscanHostname
    ? `https://${chain.etherscanHostname}/tx/${txHash}`
    : null
  const usd = formatIndexedUsd(amountUsd)

  return (
    <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs text-smoke-500">
      {usd ? <span>{usd}</span> : null}
      <span
        className={`inline-flex h-5 min-w-7 items-center justify-center border px-1.5 text-center text-[10px] font-medium leading-none ${
          direction === 'in'
            ? 'border-bluebs-500 text-bluebs-600'
            : 'border-peel-500 text-peel-600'
        }`}
      >
        {direction}
      </span>
      {txUrl ? (
        <a
          href={txUrl}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`View transaction on ${chain?.name ?? 'chain explorer'}`}
          className="inline-flex transition-opacity hover:opacity-70"
        >
          <ChainIcon chainId={chainId} size={18} />
        </a>
      ) : (
        <ChainIcon chainId={chainId} size={18} />
      )}
    </span>
  )
}
