'use client'

import type { JBChainId } from '@bananapus/nana-sdk-core'
import { useEffect, useState, type ReactNode } from 'react'
import Image from 'next/image'
import quietIllustration from '@/assets/illustrations/quiet.png'
import { AddressLabel } from '@/components/ui/AddressLabel'
import { useProjectTokenUnit } from '@/hooks/useProjectTokenUnit'
import {
  getProjectActivity,
  getProjectActivityByProject,
  type BsActivityEvent,
} from '@/lib/bendystraw'
import { explorerHostname } from '@/lib/chainDisplay'
import {
  formatCompactTokenAmount,
  formatDate,
  timeAgo,
} from '@/lib/format'
import { identityGradient } from '@/lib/identityGradient'
import { chainName } from '@/lib/urn'
import { ActorLink } from './ActorLink'
import { ActivityMeta, type ActivityAmountToken } from './ActivityMeta'

const ACTIVITY_POLL_MS = 15_000

export function mergeActivityEvents<T extends BsActivityEvent>(
  current: T[],
  incoming: T[],
): T[] {
  const incomingIds = new Set(incoming.map(event => event.id))
  return [
    ...incoming,
    ...current.filter(event => !incomingIds.has(event.id)),
  ]
}

function txUrl(chainId: number, txHash: string): string | null {
  const host = explorerHostname(chainId)
  return host ? `https://${host}/tx/${txHash}` : null
}

function addressUrl(chainId: number, address: string): string | null {
  const host = explorerHostname(chainId)
  return host ? `https://${host}/address/${address}` : null
}

/**
 * Interpret one indexed event as feed-row parts: who acted, what they did,
 * the flow direction, and any memo — shared by the project feed and the
 * account view.
 */
export function activityParts(
  event: BsActivityEvent,
  tokenUnit: string,
): {
  actor: string
  action: ReactNode
  direction: 'in' | 'out' | null
  memo: string | null
  amountUsd: string | null | undefined
  amountRaw: string | null | undefined
} {
  const pay = event.payEvent
  const cashOut = event.cashOutTokensEvent
  const mint = event.mintTokensEvent
  const loan = event.borrowLoanEvent
  const actor =
    pay?.beneficiary ??
    cashOut?.beneficiary ??
    mint?.beneficiary ??
    event.autoIssueEvent?.beneficiary ??
    loan?.beneficiary ??
    event.mintNftEvent?.beneficiary ??
    event.bridgeClaimEvent?.beneficiary ??
    event.sendPayoutToSplitEvent?.beneficiary ??
    event.sendReservedTokensToSplitEvent?.beneficiary ??
    event.projectCreateEvent?.from ??
    event.addToBalanceEvent?.from ??
    event.deployErc20Event?.from ??
    event.sendPayoutsEvent?.from ??
    event.sendReservedTokensToSplitsEvent?.from ??
    event.repayLoanEvent?.from ??
    event.liquidateLoanEvent?.from ??
    event.setUriEvent?.caller ??
    event.projectTransferEvent?.previousOwner ??
    event.operatorPermissionsSetEvent?.caller ??
    event.addNftTierEvent?.caller ??
    event.removeNftTierEvent?.caller ??
    event.swapEvent?.caller ??
    event.buybackPoolEvent?.caller ??
    event.from
  const rawTokenCount =
    pay?.newlyIssuedTokenCount ??
    cashOut?.cashOutCount ??
    mint?.beneficiaryTokenCount ??
    event.autoIssueEvent?.count ??
    event.sendReservedTokensToSplitsEvent?.tokenCount ??
    event.sendReservedTokensToSplitEvent?.tokenCount ??
    event.swapEvent?.projectTokenAmount ??
    event.bridgeClaimEvent?.projectTokenCount ??
    '0'
  const tokenCount = formatCompactTokenAmount(rawTokenCount)
  const issuedTokens = (() => {
    try {
      return BigInt(rawTokenCount) > 0n
    } catch {
      return false
    }
  })()
  const direction =
    pay || event.addToBalanceEvent
      ? 'in'
      : cashOut ||
          event.sendPayoutsEvent ||
          event.borrowLoanEvent ||
          event.liquidateLoanEvent
        ? 'out'
        : event.repayLoanEvent ||
            event.mintNftEvent ||
            event.swapEvent ||
            event.bridgeClaimEvent ||
            event.sendPayoutToSplitEvent ||
            event.sendReservedTokensToSplitEvent
          ? 'in'
          : null

  const action = pay ? (
    issuedTokens ? (
      <>
        got{' '}
        <span className="font-medium text-bluebs-600">
          {tokenCount} {tokenUnit}
        </span>
      </>
    ) : (
      <>paid into the project</>
    )
  ) : cashOut ? (
    <>
      cashed out{' '}
      <span className="font-medium text-bluebs-600">
        {tokenCount} {tokenUnit}
      </span>
    </>
  ) : mint ? (
    <>
      minted{' '}
      <span className="font-medium text-bluebs-600">
        {tokenCount} {tokenUnit}
      </span>
    </>
  ) : event.projectCreateEvent ? (
    <>created the project</>
  ) : event.addToBalanceEvent ? (
    <>added to balance</>
  ) : event.deployErc20Event ? (
    <>
      deployed token{' '}
      {event.deployErc20Event.symbol
        ? `$${event.deployErc20Event.symbol}`
        : ''}
    </>
  ) : event.sendPayoutsEvent ? (
    <>paid out</>
  ) : event.sendReservedTokensToSplitsEvent ? (
    <>
      distributed reserved{' '}
      <span className="font-medium text-bluebs-600">
        {tokenCount} {tokenUnit}
      </span>
    </>
  ) : event.autoIssueEvent ? (
    <>
      auto-issued{' '}
      <span className="font-medium text-bluebs-600">
        {tokenCount} {tokenUnit}
      </span>
    </>
  ) : loan ? (
    <>
      borrowed against {formatCompactTokenAmount(loan.collateral)} {tokenUnit}
    </>
  ) : event.repayLoanEvent ? (
    <>repaid a loan</>
  ) : event.liquidateLoanEvent ? (
    <>liquidated a loan</>
  ) : event.mintNftEvent ? (
    <>minted shop item #{event.mintNftEvent.tierId}</>
  ) : event.setUriEvent ? (
    <>updated project info</>
  ) : event.projectTransferEvent ? (
    <>
      transferred ownership to{' '}
      <AddressLabel address={event.projectTransferEvent.owner} />
    </>
  ) : event.operatorPermissionsSetEvent ? (
    <>
      set{' '}
      {event.operatorPermissionsSetEvent.isRevnetOperator
        ? 'revnet operator'
        : 'operator'}{' '}
      permissions for{' '}
      <AddressLabel address={event.operatorPermissionsSetEvent.operator} />
    </>
  ) : event.addNftTierEvent ? (
    <>added shop item #{event.addNftTierEvent.tierId}</>
  ) : event.removeNftTierEvent ? (
    <>removed shop item #{event.removeNftTierEvent.tierId}</>
  ) : event.swapEvent ? (
    <>
      bought{' '}
      <span className="font-medium text-bluebs-600">
        {tokenCount} {tokenUnit}
      </span>{' '}
      via the buyback pool
    </>
  ) : event.buybackPoolEvent ? (
    <>set up a buyback pool</>
  ) : event.bridgeClaimEvent ? (
    <>
      claimed{' '}
      <span className="font-medium text-bluebs-600">
        {tokenCount} {tokenUnit}
      </span>{' '}
      from {chainName(event.bridgeClaimEvent.peerChainId)}
    </>
  ) : event.sendPayoutToSplitEvent ? (
    <>received a payout split</>
  ) : event.sendReservedTokensToSplitEvent ? (
    <>
      received{' '}
      <span className="font-medium text-bluebs-600">
        {tokenCount} {tokenUnit}
      </span>{' '}
      from a reserved split
    </>
  ) : (
    <>updated the project</>
  )
  const memo = pay?.memo ?? event.addToBalanceEvent?.memo ?? null

  return {
    actor,
    action,
    direction,
    memo,
    amountUsd:
      pay?.amountUsd ??
      cashOut?.reclaimAmountUsd ??
      event.sendPayoutsEvent?.amountPaidOutUsd ??
      event.sendPayoutToSplitEvent?.amountUsd,
    amountRaw:
      pay?.amount ??
      cashOut?.reclaimAmount ??
      event.addToBalanceEvent?.amount ??
      event.sendPayoutsEvent?.amountPaidOut ??
      event.sendPayoutToSplitEvent?.amount,
  }
}

function Row({
  event,
  tokenUnit,
  accountingToken,
}: {
  event: BsActivityEvent
  tokenUnit: string
  accountingToken?: Omit<ActivityAmountToken, 'raw'> | null
}) {
  const { actor, action, direction, memo, amountUsd, amountRaw } =
    activityParts(event, tokenUnit)
  const actorLink = actor ? addressUrl(event.chainId, actor) : null
  const link = txUrl(event.chainId, event.txHash)
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
            amountUsd={amountUsd}
            amountToken={
              accountingToken ? { raw: amountRaw, ...accountingToken } : null
            }
            direction={direction}
          />
        </div>
        <p className="mt-1 break-words text-sm leading-relaxed text-ink">
          {actorNode} {action}
        </p>
        {memo ? (
          <p className="mt-0.5 break-words text-xs italic text-smoke-500">
            “{memo}”
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
  suckerGroupId,
  accountingToken,
  error = false,
}: {
  events: BsActivityEvent[]
  chainId: JBChainId
  projectId: number
  suckerGroupId?: string | null
  /**
   * Set when the project's verified deployments agree on one accounting-token
   * kind — rows then show raw token amounts instead of indexed USD.
   */
  accountingToken?: Omit<ActivityAmountToken, 'raw'> | null
  error?: boolean
}) {
  const [liveEvents, setLiveEvents] = useState(events)
  const [liveError, setLiveError] = useState(error)

  useEffect(() => {
    setLiveEvents(events)
    setLiveError(error)
  }, [error, events])

  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return
    let stopped = false

    const refresh = async () => {
      if (document.visibilityState === 'hidden') return
      try {
        const incoming = await (suckerGroupId
          ? getProjectActivity(suckerGroupId, 250, chainId)
          : getProjectActivityByProject(chainId, projectId, 250))
        if (stopped) return
        setLiveEvents(current => mergeActivityEvents(current, incoming))
        setLiveError(false)
      } catch {
        // Keep the last known-good feed; the next poll retries.
      }
    }

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void refresh()
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), ACTIVITY_POLL_MS)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      stopped = true
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [chainId, projectId, suckerGroupId])

  const visible = liveEvents.filter(
    e =>
      e.payEvent ||
      e.cashOutTokensEvent ||
      e.projectCreateEvent ||
      e.addToBalanceEvent ||
      e.mintTokensEvent ||
      e.deployErc20Event ||
      e.sendPayoutsEvent ||
      e.sendReservedTokensToSplitsEvent ||
      e.autoIssueEvent ||
      e.borrowLoanEvent ||
      e.repayLoanEvent ||
      e.liquidateLoanEvent ||
      e.mintNftEvent ||
      e.setUriEvent ||
      e.projectTransferEvent ||
      e.operatorPermissionsSetEvent ||
      e.addNftTierEvent ||
      e.removeNftTierEvent ||
      e.swapEvent ||
      e.buybackPoolEvent ||
      e.bridgeClaimEvent,
  )
  const tokenUnit = useProjectTokenUnit(chainId, projectId)

  if (visible.length === 0) {
    if (liveError) {
      return (
        <div className="flex min-h-[180px] items-center justify-center rounded-xl border border-dashed border-red-300 p-5 text-sm text-red-700">
          Activity is temporarily unavailable. No events are being hidden as
          an empty history.
        </div>
      )
    }
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
        <Row
          key={event.id}
          event={event}
          tokenUnit={tokenUnit}
          accountingToken={accountingToken}
        />
      ))}
    </ul>
  )
}
