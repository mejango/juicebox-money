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
import { chainName } from '@/lib/urn'
import { ActorLink } from './ActorLink'
import { ActivityAmountLine, type ActivityAmountToken } from './ActivityMeta'
import { ProjectTabIcon } from './project/ProjectTabIcon'

const ACTIVITY_POLL_MS = 15_000
/** Rows per page. The server renders the first one; "Load more" appends the rest. */
const ACTIVITY_PAGE = 250

export type ActivityCategory =
  | 'pay'
  | 'cashOut'
  | 'tokenMint'
  | 'payout'
  | 'reserved'
  | 'autoIssue'
  | 'borrowLoan'
  | 'repayLoan'
  | 'liquidateLoan'
  | 'nftMint'
  | 'tokenDeploy'
  | 'projectCreate'
  | 'reconfigure'
  | 'addToBalance'
  | 'infoUpdate'
  | 'ownershipTransfer'
  | 'addShopItem'
  | 'removeShopItem'
  | 'buybackSwap'
  | 'buybackPool'
  | 'bridgeClaim'

const ACTIVITY_CATEGORY_LABELS: Record<ActivityCategory, string> = {
  pay: 'Payments',
  cashOut: 'Cash outs',
  tokenMint: 'Token mints',
  payout: 'Payouts',
  reserved: 'Reserved distributions',
  autoIssue: 'Auto-issuance',
  borrowLoan: 'Loans',
  repayLoan: 'Loan repayments',
  liquidateLoan: 'Liquidations',
  nftMint: 'NFT mints',
  tokenDeploy: 'Token deploys',
  projectCreate: 'Project creation',
  reconfigure: 'Reconfigurations',
  addToBalance: 'Add to balance',
  infoUpdate: 'Info updates',
  ownershipTransfer: 'Ownership transfers',
  addShopItem: 'Shop items added',
  removeShopItem: 'Shop items removed',
  buybackSwap: 'Buyback swaps',
  buybackPool: 'Buyback pools',
  bridgeClaim: 'Bridge claims',
}

export function activityCategory(event: BsActivityEvent): ActivityCategory | null {
  if (event.payEvent) return 'pay'
  if (event.cashOutTokensEvent) return 'cashOut'
  if (event.addToBalanceEvent) return 'addToBalance'
  if (event.mintTokensEvent) return 'tokenMint'
  if (event.sendPayoutsEvent) return 'payout'
  if (event.sendReservedTokensToSplitsEvent) return 'reserved'
  if (event.autoIssueEvent) return 'autoIssue'
  if (event.borrowLoanEvent) return 'borrowLoan'
  if (event.repayLoanEvent) return 'repayLoan'
  if (event.liquidateLoanEvent) return 'liquidateLoan'
  if (event.mintNftEvent) return 'nftMint'
  if (event.deployErc20Event) return 'tokenDeploy'
  if (event.projectCreateEvent) return 'projectCreate'
  if (event.rulesetQueuedEvent) return 'reconfigure'
  if (event.setUriEvent) return 'infoUpdate'
  if (event.projectTransferEvent) return 'ownershipTransfer'
  if (event.addNftTierEvent) return 'addShopItem'
  if (event.removeNftTierEvent) return 'removeShopItem'
  if (event.swapEvent) return 'buybackSwap'
  if (event.buybackPoolEvent) return 'buybackPool'
  if (event.bridgeClaimEvent) return 'bridgeClaim'
  return null
}

function ActivityTypeFilter({
  categories,
  selected,
  onChange,
}: {
  categories: ActivityCategory[]
  selected: Set<ActivityCategory> | null
  onChange: (next: Set<ActivityCategory> | null) => void
}) {
  if (categories.length < 2) return null
  const selectedLabel =
    selected === null
      ? 'All'
      : selected.size === 1
        ? ACTIVITY_CATEGORY_LABELS[[...selected][0]]
        : `${selected.size} events`

  const toggle = (category: ActivityCategory) => {
    const next = selected === null ? new Set(categories) : new Set(selected)
    if (next.has(category)) next.delete(category)
    else next.add(category)
    onChange(next.size === categories.length ? null : next)
  }

  return (
    <details className="group relative z-20">
      <summary className="flex min-h-11 cursor-pointer list-none select-none items-center justify-between gap-2 rounded-lg border border-smoke-300 bg-bone px-3 text-sm text-smoke-700 transition-colors hover:border-smoke-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bluebs-400 [&::-webkit-details-marker]:hidden">
        <span>{selectedLabel}</span>
        <svg
          aria-hidden="true"
          viewBox="0 0 20 20"
          className="h-4 w-4 shrink-0 transition-transform group-open:rotate-180"
          fill="none"
        >
          <path
            d="m6 8 4 4 4-4"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </summary>
      <div className="absolute right-0 top-full mt-1 min-w-56 border border-smoke-400 bg-bone p-2 shadow-lg">
        <label className="flex cursor-pointer items-center gap-2 border-b border-smoke-200 px-1 py-2 text-sm text-smoke-700">
          <input
            type="checkbox"
            checked={selected === null}
            onChange={() => onChange(selected === null ? new Set() : null)}
          />
          All
        </label>
        {categories.map(category => (
          <label
            key={category}
            className="flex cursor-pointer items-center gap-2 px-1 py-2 text-sm text-smoke-700"
          >
            <input
              type="checkbox"
              checked={selected === null || selected.has(category)}
              onChange={() => toggle(category)}
            />
            {ACTIVITY_CATEGORY_LABELS[category]}
          </label>
        ))}
      </div>
    </details>
  )
}

/**
 * Merge a fetched page into the feed, deduped by id and re-sorted newest-first.
 *
 * Incoming rows are NOT simply prepended: the same merge serves both the poll (newer
 * rows, which belong at the top) and "load more" (an older page, which belongs at the
 * bottom). Sorting on the server's own ordering key is the only thing that keeps both
 * correct, with the id as a stable tiebreak for same-timestamp rows.
 */
export function mergeActivityEvents<T extends BsActivityEvent>(
  current: T[],
  incoming: T[],
): T[] {
  const incomingIds = new Set(incoming.map(event => event.id))
  return [...incoming, ...current.filter(event => !incomingIds.has(event.id))].sort(
    (a, b) => b.timestamp - a.timestamp || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
  )
}

/** Holder permission grants are useful in account history, not project feeds. */
export function isProjectFeedActivity(event: BsActivityEvent): boolean {
  return (
    !event.operatorPermissionsSetEvent &&
    !!(
      event.payEvent ||
      event.cashOutTokensEvent ||
      event.projectCreateEvent ||
      event.addToBalanceEvent ||
      event.mintTokensEvent ||
      event.deployErc20Event ||
      event.sendPayoutsEvent ||
      event.sendReservedTokensToSplitsEvent ||
      event.autoIssueEvent ||
      event.borrowLoanEvent ||
      event.repayLoanEvent ||
      event.liquidateLoanEvent ||
      event.mintNftEvent ||
      event.setUriEvent ||
      event.projectTransferEvent ||
      event.addNftTierEvent ||
      event.removeNftTierEvent ||
      event.swapEvent ||
      event.buybackPoolEvent ||
      event.bridgeClaimEvent
    )
  )
}

/**
 * Reading order for a same-tx group's action fragments — the primary event
 * (first present) also supplies the row's actor, amount, direction, and memo.
 * A buyback pay reads "paid into the project, bought … via the buyback pool,
 * and minted …" instead of three separate rows.
 */
const GROUP_ORDER: ActivityCategory[] = [
  'projectCreate',
  'pay',
  'addToBalance',
  'nftMint',
  'cashOut',
  'buybackSwap',
  'tokenMint',
  'autoIssue',
  'bridgeClaim',
]

function groupRank(event: BsActivityEvent): number {
  const category = activityCategory(event)
  const rank = category ? GROUP_ORDER.indexOf(category) : -1
  return rank === -1 ? GROUP_ORDER.length : rank
}

/**
 * Collapse events that belong to one transaction (on one chain, for one
 * project) into a single feed line item. Order is preserved: a group sits
 * where its newest member sat.
 */
export function groupSameTxEvents<T extends BsActivityEvent>(events: T[]): T[][] {
  const groups = new Map<string, T[]>()
  const order: T[][] = []
  for (const event of events) {
    // Account-history rows span protocol versions; a V4 row must never fold
    // into a V6 group even when the tx and project id line up.
    const version = (event as { version?: number }).version ?? ''
    const key = `${event.chainId}:${event.projectId}:${version}:${event.txHash}`
    const group = groups.get(key)
    if (group) group.push(event)
    else {
      const fresh = [event]
      groups.set(key, fresh)
      order.push(fresh)
    }
  }
  return order
}

function joinActionNodes(actions: ReactNode[]): ReactNode {
  if (actions.length === 1) return actions[0]
  return actions.map((action, index) => (
    <span key={index}>
      {index === 0 ? null : index === actions.length - 1 ? (
        actions.length === 2 ? ' and ' : ', and '
      ) : (
        ', '
      )}
      {action}
    </span>
  ))
}

/**
 * "40" or "12.5" when the mint count reads as the reserved-rate remint of the
 * swap output (0 < mint < swap); null when the pair doesn't fit that shape.
 */
function reservePercentLabel(
  swapRaw: string,
  mintRaw: string,
): string | null {
  try {
    const swap = BigInt(swapRaw)
    const mint = BigInt(mintRaw)
    if (swap <= 0n || mint <= 0n || mint >= swap) return null
    const tenths = Number(((swap - mint) * 1000n) / swap)
    return tenths % 10 === 0 ? String(tenths / 10) : (tenths / 10).toFixed(1)
  } catch {
    return null
  }
}

/**
 * activityParts over a same-tx group: the primary event's parts, with every
 * event's action in `actions` (for bulleted rendering) and joined into one
 * sentence in `action` (for compact surfaces like the home rail).
 */
export function combinedActivityParts(
  group: BsActivityEvent[],
  tokenUnit: string,
): ReturnType<typeof activityParts> & { actions: ReactNode[] } {
  const sorted = [...group].sort((a, b) => groupRank(a) - groupRank(b))
  // An issuance-route pay already reports its tokens ("got X") — the tx's
  // mintTokensEvent is that same issuance's mint record, not a second grant.
  // Only a zero-issuance pay (the buyback shape) keeps its mint: the remint.
  const payIssuedTokens = sorted.some(entry => {
    try {
      return BigInt(entry.payEvent?.newlyIssuedTokenCount ?? '0') > 0n
    } catch {
      return false
    }
  })
  const ordered = payIssuedTokens
    ? sorted.filter(entry => !entry.mintTokensEvent)
    : sorted
  const parts = ordered.map(event => activityParts(event, tokenUnit))
  const primary = parts[0]

  // A buyback pay pairs the pool swap (gross output) with the reserved-rate
  // remint (the payer's net). Say what the mint IS instead of a bare "minted X".
  const swapEvent = ordered.find(
    entry => entry.swapEvent && entry.swapEvent.direction.toLowerCase() !== 'sell',
  )?.swapEvent
  const mints = ordered.filter(entry => entry.mintTokensEvent)
  if (swapEvent && mints.length === 1) {
    const mintIndex = ordered.indexOf(mints[0])
    const mint = mints[0].mintTokensEvent!
    const reservePercent = reservePercentLabel(
      swapEvent.projectTokenAmount,
      mint.beneficiaryTokenCount,
    )
    if (reservePercent) {
      parts[mintIndex] = {
        ...parts[mintIndex],
        action: (
          <>
            received{' '}
            <span className="font-medium text-bluebs-600">
              {formatCompactTokenAmount(mint.beneficiaryTokenCount)} {tokenUnit}
            </span>{' '}
            after the {reservePercent}% reserve
          </>
        ),
      }
    }
  }
  // A zero-issuance pay's "paid into the project" adds nothing next to the
  // row's amount and "in" tag — drop its fragment when other actions exist.
  // The pay still anchors the row's actor, amount, direction, and memo.
  const withFragments =
    ordered.length > 1
      ? ordered.filter(entry => {
          if (!entry.payEvent) return true
          try {
            return BigInt(entry.payEvent.newlyIssuedTokenCount) > 0n
          } catch {
            return true
          }
        })
      : ordered
  const actions = (withFragments.length ? withFragments : ordered).map(
    entry => parts[ordered.indexOf(entry)].action,
  )
  return {
    ...primary,
    action: joinActionNodes(actions),
    actions,
    memo: parts.find(part => part.memo)?.memo ?? null,
    amountUsd: parts.find(part => part.amountUsd != null)?.amountUsd,
    amountRaw: parts.find(part => part.amountRaw != null)?.amountRaw,
    direction: parts.find(part => part.direction != null)?.direction ?? null,
  }
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
  const swap = event.swapEvent
  const swapIsSell = swap?.direction.toLowerCase() === 'sell'
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
    event.rulesetQueuedEvent?.caller ??
    event.addNftTierEvent?.caller ??
    event.removeNftTierEvent?.caller ??
    // PoolManager emits the swap, so `caller` is infrastructure. Bendystraw's
    // swap `from` is the transaction origin/payer and is the human actor the
    // activity row must attribute.
    event.swapEvent?.from ??
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
          (swap && !swapIsSell) ||
            event.bridgeClaimEvent ||
            event.sendPayoutToSplitEvent ||
            event.sendReservedTokensToSplitEvent
          ? 'in'
          : swapIsSell
            ? 'out'
          : null

  const action = pay ? (
    issuedTokens ? (
      // Same shape as the buyback fragment ("bought X via the buyback pool"):
      // acquisitions always read "bought <amount> <token> <source>".
      <>
        bought{' '}
        <span className="font-medium text-bluebs-600">
          {tokenCount} {tokenUnit}
        </span>{' '}
        from issuance
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
  ) : event.rulesetQueuedEvent ? (
    <>reconfigured the project</>
  ) : event.addNftTierEvent ? (
    <>added shop item #{event.addNftTierEvent.tierId}</>
  ) : event.removeNftTierEvent ? (
    <>removed shop item #{event.removeNftTierEvent.tierId}</>
  ) : swap ? (
    <>
      {swapIsSell ? 'sold' : 'bought'}{' '}
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
      event.sendPayoutToSplitEvent?.amount ??
      swap?.terminalTokenAmount,
  }
}

function Row({
  group,
  tokenUnit,
  accountingToken,
}: {
  group: BsActivityEvent[]
  tokenUnit: string
  accountingToken?: Omit<ActivityAmountToken, 'raw'> | null
}) {
  const event = group[0]
  const { actor, actions, direction, memo, amountUsd, amountRaw } =
    combinedActivityParts(group, tokenUnit)
  const actorLink = actor ? addressUrl(event.chainId, actor) : null
  const link = txUrl(event.chainId, event.txHash)
  const relativeTime = timeAgo(event.timestamp)
  const actorNode = <ActorLink href={actorLink} actor={actor} />

  return (
    <li className="flex gap-3 py-3.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2 text-xs text-smoke-500">
          {/* One shape for every row: actor left, time right, then the flow
              line ("20 USDC [in] on <chain>"), the memo headline, and the
              actions as fine-print bullets. */}
          <span className="min-w-0 truncate">{actorNode}</span>
          {link ? (
            <a
              href={link}
              target="_blank"
              rel="noopener noreferrer"
              title={formatDate(event.timestamp)}
              className="shrink-0 hover:text-ink hover:underline"
              suppressHydrationWarning
            >
              {relativeTime === 'now' ? 'now' : `${relativeTime} ago`}
            </a>
          ) : (
            <span
              className="shrink-0"
              title={formatDate(event.timestamp)}
              suppressHydrationWarning
            >
              {relativeTime === 'now' ? 'now' : `${relativeTime} ago`}
            </span>
          )}
        </div>
        <ActivityAmountLine
          chainId={event.chainId}
          txHash={event.txHash}
          amountUsd={amountUsd}
          amountToken={
            accountingToken ? { raw: amountRaw, ...accountingToken } : null
          }
          direction={direction}
        />
        {memo ? (
          <p className="mt-0.5 break-words text-sm leading-relaxed text-ink">
            “{memo}”
          </p>
        ) : null}
        <ul className="mt-0.5 space-y-0.5 text-xs text-smoke-500">
          {/* Hand-rolled markers: the dot sits flush left while wrapped
              lines keep hanging-indent alignment with the first line's text. */}
          {actions.map((action, index) => (
            <li
              key={index}
              className="relative break-words pl-3.5 before:absolute before:left-0 before:text-smoke-300 before:content-['•']"
            >
              {action}
            </li>
          ))}
        </ul>
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
  total,
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
  /** Rows matching the feed's filter, of which `events` is the newest page. Category filters
   *  apply only to what is LOADED, so without this a populated category renders as empty. */
  total?: number
}) {
  const [liveEvents, setLiveEvents] = useState(events)
  const [liveError, setLiveError] = useState(error)
  const [liveTotal, setLiveTotal] = useState(total ?? events.length)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null)
  const [selectedCategories, setSelectedCategories] =
    useState<Set<ActivityCategory> | null>(null)

  useEffect(() => {
    setLiveEvents(events)
    setLiveError(error)
    setLiveTotal(total ?? events.length)
  }, [error, events, total])

  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return
    let stopped = false

    const refresh = async () => {
      if (document.visibilityState === 'hidden') return
      try {
        const incoming = await (suckerGroupId
          ? getProjectActivity(suckerGroupId, ACTIVITY_PAGE, chainId)
          : getProjectActivityByProject(chainId, projectId, ACTIVITY_PAGE))
        if (stopped) return
        // Poll the newest page only; merging keeps whatever "Load more" has already pulled in.
        setLiveEvents(current => mergeActivityEvents(current, incoming.items))
        setLiveTotal(incoming.totalCount)
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

  const loadMore = async () => {
    setLoadingMore(true)
    setLoadMoreError(null)
    try {
      const page = await (suckerGroupId
        ? getProjectActivity(suckerGroupId, ACTIVITY_PAGE, chainId, liveEvents.length)
        : getProjectActivityByProject(
            chainId,
            projectId,
            ACTIVITY_PAGE,
            liveEvents.length,
          ))
      setLiveEvents(current => mergeActivityEvents(current, page.items))
      setLiveTotal(page.totalCount)
    } catch {
      setLoadMoreError('Could not load more activity. Try again.')
    } finally {
      setLoadingMore(false)
    }
  }

  const projectEvents = liveEvents.filter(isProjectFeedActivity)
  const categories: ActivityCategory[] = []
  projectEvents.forEach(event => {
    const category = activityCategory(event)
    if (category && !categories.includes(category)) categories.push(category)
  })
  const visible = projectEvents.filter(event => {
    const category = activityCategory(event)
    return selectedCategories === null || (!!category && selectedCategories.has(category))
  })
  const tokenUnit = useProjectTokenUnit(chainId, projectId)
  const header = (
    <div className="mb-3 flex items-center justify-between gap-3">
      {/* Same voice as the project tabs — the icon and type the Activity tab
          uses when the feed collapses into the tab bar. */}
      <h2 className="flex items-center gap-2 font-agrandir text-sm font-medium text-ink">
        <ProjectTabIcon label="Activity" />
        Latest
      </h2>
      <ActivityTypeFilter
        categories={categories}
        selected={selectedCategories}
        onChange={setSelectedCategories}
      />
    </div>
  )

  if (projectEvents.length === 0) {
    if (liveError) {
      return (
        <div>
          {header}
          <div className="flex min-h-[180px] items-center justify-center rounded-xl border border-dashed border-red-300 p-5 text-sm text-red-700">
            Activity is temporarily unavailable. No events are being hidden as
            an empty history.
          </div>
        </div>
      )
    }
    return (
      <div>
        {header}
        <div className="flex min-h-[180px] items-center justify-center rounded-xl border border-dashed border-smoke-300 p-5">
          <Image
            src={quietIllustration}
            alt=""
            sizes="128px"
            className="h-32 w-32 object-contain"
            aria-hidden
          />
        </div>
      </div>
    )
  }

  return (
    <div>
      {header}
      {visible.length ? (
        <ul className="card max-h-[70dvh] divide-y divide-smoke-100 overflow-y-auto px-4 py-1 min-[801px]:max-h-[max(780px,82vh)]">
          {groupSameTxEvents(visible).map(group => (
            <Row
              key={group[0].id}
              group={group}
              tokenUnit={tokenUnit}
              accountingToken={accountingToken}
            />
          ))}
        </ul>
      ) : (
        <div className="card flex min-h-[180px] items-center justify-center p-5 text-sm text-smoke-500">
          {liveEvents.length < liveTotal
            ? 'No activity matches this filter in the rows loaded so far.'
            : 'No activity matches this filter.'}
        </div>
      )}
      {liveEvents.length < liveTotal ? (
        <div className="mt-4 flex flex-col items-center gap-2">
          <button
            onClick={() => void loadMore()}
            disabled={loadingMore}
            className="btn-secondary min-h-[40px] px-5 text-sm"
          >
            {loadingMore
              ? 'Loading…'
              : `Load more (${liveEvents.length} of ${liveTotal})`}
          </button>
          {loadMoreError ? (
            <p className="text-xs text-crush-600">{loadMoreError}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
