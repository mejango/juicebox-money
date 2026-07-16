import { JB_CHAINS, type JBChainId } from '@bananapus/nana-sdk-core'
import { BsActivityEvent } from '@/lib/bendystraw'
import { formatDate, formatTokenAmount, truncateAddress } from '@/lib/format'

function txUrl(chainId: number, txHash: string): string | null {
  const host = JB_CHAINS[chainId as JBChainId]?.etherscanHostname
  return host ? `https://${host}/tx/${txHash}` : null
}

function Row({
  event,
  decimals,
  symbol,
}: {
  event: BsActivityEvent
  decimals: number
  symbol: string
}) {
  const link = txUrl(event.chainId, event.txHash)
  let body: React.ReactNode = null

  if (event.payEvent) {
    body = (
      <>
        <p className="text-sm">
          <span className="text-smoke-700">
            {truncateAddress(event.payEvent.beneficiary)}
          </span>{' '}
          paid{' '}
          <span className="font-bold text-ink">
            {formatTokenAmount(event.payEvent.amount, decimals)} {symbol}
          </span>
        </p>
        {event.payEvent.memo ? (
          <p className="mt-1 truncate text-sm italic text-smoke-700">
            “{event.payEvent.memo}”
          </p>
        ) : null}
      </>
    )
  } else if (event.cashOutTokensEvent) {
    body = (
      <p className="text-sm">
        <span className="text-smoke-700">
          {truncateAddress(event.cashOutTokensEvent.beneficiary)}
        </span>{' '}
        cashed out for{' '}
        <span className="font-bold text-melon-700">
          {formatTokenAmount(event.cashOutTokensEvent.reclaimAmount, decimals)}{' '}
          {symbol}
        </span>
      </p>
    )
  } else {
    return null
  }

  return (
    <li className="flex items-start justify-between gap-4 py-3.5">
      <div className="min-w-0">{body}</div>
      <div className="shrink-0 text-right text-xs text-smoke-500">
        {link ? (
          <a
            href={link}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-ink hover:underline"
          >
            {formatDate(event.timestamp)}
          </a>
        ) : (
          formatDate(event.timestamp)
        )}
      </div>
    </li>
  )
}

export function ActivityList({
  events,
  decimals,
  symbol,
}: {
  events: BsActivityEvent[]
  decimals: number
  symbol: string
}) {
  const visible = events.filter(e => e.payEvent || e.cashOutTokensEvent)

  if (visible.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-smoke-300 p-6 text-sm text-smoke-700">
        No activity yet — be the first to pay this project.
      </p>
    )
  }

  return (
    <ul className="card divide-y divide-smoke-100 px-5 py-1">
      {visible.map(e => (
        <Row key={e.id} event={e} decimals={decimals} symbol={symbol} />
      ))}
    </ul>
  )
}
