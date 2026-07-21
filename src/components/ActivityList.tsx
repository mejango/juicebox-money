'use client'

import { JB_CHAINS, type JBChainId } from '@bananapus/nana-sdk-core'
import Image from 'next/image'
import quietIllustration from '@/assets/illustrations/quiet.png'
import { useProjectTokenUnit } from '@/hooks/useProjectTokenUnit'
import { BsActivityEvent } from '@/lib/bendystraw'
import {
  formatCompactTokenAmount,
  formatDate,
  timeAgo,
  truncateAddress,
} from '@/lib/format'
import { ActivityMeta } from './ActivityMeta'

const IDENT_COLORS = [
  '#1A8A8A',
  '#3D7A5A',
  '#C43550',
  '#2C2018',
  '#B8602E',
  '#6EC4C4',
  '#82B89E',
]

function txUrl(chainId: number, txHash: string): string | null {
  const host = JB_CHAINS[chainId as JBChainId]?.etherscanHostname
  return host ? `https://${host}/tx/${txHash}` : null
}

function addressUrl(chainId: number, address: string): string | null {
  const host = JB_CHAINS[chainId as JBChainId]?.etherscanHostname
  return host ? `https://${host}/address/${address}` : null
}

/** The deterministic two-color identity bubbles used by website/'s feed. */
function identityGradient(seed: string): string {
  let hash = 0
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0
  }
  const a = IDENT_COLORS[Math.abs(hash) % IDENT_COLORS.length]
  const b = IDENT_COLORS[Math.abs(hash >> 3) % IDENT_COLORS.length]
  return `linear-gradient(135deg, ${a}, ${b})`
}

/** An activity row's actor: an explorer link when one resolves, else plain text. */
export function ActorLink({
  href,
  actor,
}: {
  href: string | null
  actor: string
}) {
  return href ? (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-smoke-700 hover:text-ink hover:underline"
    >
      {truncateAddress(actor)}
    </a>
  ) : (
    <span className="text-smoke-700">{truncateAddress(actor)}</span>
  )
}

function Row({
  event,
  tokenUnit,
}: {
  event: BsActivityEvent
  tokenUnit: string
}) {
  const pay = event.payEvent
  const cashOut = event.cashOutTokensEvent
  if (!pay && !cashOut) return null

  const isPay = !!pay
  const actor = pay?.beneficiary ?? cashOut?.beneficiary ?? ''
  const actorLink = actor ? addressUrl(event.chainId, actor) : null
  const link = txUrl(event.chainId, event.txHash)
  const rawTokenCount = pay?.newlyIssuedTokenCount ?? cashOut?.cashOutCount ?? '0'
  const tokenCount = formatCompactTokenAmount(rawTokenCount)
  const issuedTokens = BigInt(rawTokenCount) > 0n
  const relativeTime = timeAgo(event.timestamp)

  const actorNode = <ActorLink href={actorLink} actor={actor} />

  return (
    <li className="flex gap-3 py-3.5">
      <span
        aria-hidden="true"
        className="mt-0.5 h-6 w-6 shrink-0 rounded-full"
        style={{ background: identityGradient(actor || event.txHash) }}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2 text-xs text-smoke-500">
          {link ? (
            <a
              href={link}
              target="_blank"
              rel="noopener noreferrer"
              title={formatDate(event.timestamp)}
              className="hover:text-ink hover:underline"
              suppressHydrationWarning
            >
              {relativeTime === 'now' ? 'now' : `${relativeTime} ago`}
            </a>
          ) : (
            <span title={formatDate(event.timestamp)} suppressHydrationWarning>
              {relativeTime === 'now' ? 'now' : `${relativeTime} ago`}
            </span>
          )}
          <ActivityMeta
            chainId={event.chainId}
            txHash={event.txHash}
            amountUsd={pay?.amountUsd ?? cashOut?.reclaimAmountUsd}
            direction={isPay ? 'in' : 'out'}
          />
        </div>
        <p className="mt-1 break-words text-sm leading-relaxed text-ink">
          {actorNode}{' '}
          {isPay ? (
            issuedTokens ? (
              <>
                got{' '}
                <span className="font-medium text-bluebs-600">
                  {tokenCount} {tokenUnit}
                </span>
              </>
            ) : (
              <>paid into {tokenUnit}</>
            )
          ) : (
            <>
              cashed out{' '}
              <span className="font-medium text-bluebs-600">
                {tokenCount} {tokenUnit}
              </span>
            </>
          )}
        </p>
        {pay?.memo ? (
          <p className="mt-0.5 break-words text-xs italic text-smoke-500">
            “{pay.memo}”
          </p>
        ) : null}
      </div>
    </li>
  )
}

export function ActivityList({
  events,
  chainId,
  projectId,
}: {
  events: BsActivityEvent[]
  chainId: JBChainId
  projectId: number
}) {
  const visible = events.filter(e => e.payEvent || e.cashOutTokensEvent)
  const tokenUnit = useProjectTokenUnit(chainId, projectId)

  if (visible.length === 0) {
    return (
      <div className="flex min-h-[180px] items-center justify-center rounded-xl border border-dashed border-smoke-300 p-5">
        <Image
          src={quietIllustration}
          alt=""
          sizes="128px"
          className="h-32 w-32 object-contain"
          aria-hidden
        />
      </div>
    )
  }

  return (
    <ul className="card max-h-[70dvh] divide-y divide-smoke-100 overflow-y-auto px-4 py-1 min-[601px]:h-[max(780px,82vh)] min-[601px]:max-h-[max(780px,82vh)]">
      {visible.map(event => (
        <Row key={event.id} event={event} tokenUnit={tokenUnit} />
      ))}
    </ul>
  )
}
