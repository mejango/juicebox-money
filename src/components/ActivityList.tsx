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
import {
  ActivityAmountLine,
  activityAmountLabel,
  ActivityOnChain,
  actorPrefix,
  type ActivityAmountToken,
  type ActivityHeadline,
} from './ActivityMeta'
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
  if (event.sendReservedTokensToSplitEvent) return 'reserved'
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
      event.rulesetQueuedEvent ||
      event.addNftTierEvent ||
      event.removeNftTierEvent ||
      event.swapEvent ||
      event.buybackPoolEvent ||
      event.bridgeClaimEvent
    )
  )
}

function sameTxKey(event: BsActivityEvent): string {
  // Account-history rows span protocol versions; a V4 row must never fold
  // into a V6 group even when the tx and project id line up.
  const version = (event as { version?: number }).version ?? ''
  return `${event.chainId}:${event.projectId}:${version}:${event.txHash}`
}

/**
 * The project feed's rows: feed events plus the reserved-split receipts whose
 * distribution is loaded — they become that row's bullets. A receipt on its
 * own never makes a row here.
 */
export function projectFeedEvents<T extends BsActivityEvent>(events: T[]): T[] {
  const distributions = new Set(
    events.filter(event => event.sendReservedTokensToSplitsEvent).map(sameTxKey),
  )
  return events.filter(event =>
    event.sendReservedTokensToSplitEvent
      ? distributions.has(sameTxKey(event))
      : isProjectFeedActivity(event),
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
  // Reserved-split receipts follow the distribution they belong to.
  if (event.sendReservedTokensToSplitEvent) return GROUP_ORDER.length + 1
  const category = activityCategory(event)
  const rank = category ? GROUP_ORDER.indexOf(category) : -1
  return rank === -1 ? GROUP_ORDER.length : rank
}

function splitTokenCount(event: BsActivityEvent): bigint {
  try {
    return BigInt(event.sendReservedTokensToSplitEvent?.tokenCount ?? '0')
  } catch {
    return 0n
  }
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
    const key = sameTxKey(event)
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

/**
 * What each event's bullet actually says, per type — the fields the renderer
 * interpolates and nothing chain-local (pool ids, callers, tx hashes differ
 * per chain for the same relayed action and must not block a merge).
 */
function eventDisplaySignature(event: BsActivityEvent): string {
  if (event.payEvent)
    return `pay:${event.payEvent.amount}:${event.payEvent.beneficiary}:${event.payEvent.memo ?? ''}`
  if (event.cashOutTokensEvent)
    return `cashOut:${event.cashOutTokensEvent.cashOutCount}:${event.cashOutTokensEvent.beneficiary}`
  if (event.projectCreateEvent) return 'create'
  if (event.addToBalanceEvent)
    return `addToBalance:${event.addToBalanceEvent.amount}:${event.addToBalanceEvent.memo ?? ''}`
  if (event.mintTokensEvent)
    return `mint:${event.mintTokensEvent.beneficiaryTokenCount}:${event.mintTokensEvent.beneficiary}`
  if (event.sendPayoutsEvent) return `payouts:${event.sendPayoutsEvent.amountPaidOut}`
  if (event.sendReservedTokensToSplitsEvent)
    return `reserved:${event.sendReservedTokensToSplitsEvent.tokenCount}`
  if (event.sendReservedTokensToSplitEvent)
    return `reservedSplit:${event.sendReservedTokensToSplitEvent.tokenCount}:${event.sendReservedTokensToSplitEvent.beneficiary}:${event.sendReservedTokensToSplitEvent.splitProjectId}`
  if (event.autoIssueEvent)
    return `autoIssue:${event.autoIssueEvent.count}:${event.autoIssueEvent.beneficiary}`
  if (event.borrowLoanEvent)
    return `borrow:${event.borrowLoanEvent.collateral}:${event.borrowLoanEvent.borrowAmount}`
  if (event.repayLoanEvent) return `repay:${event.repayLoanEvent.repayBorrowAmount}`
  if (event.liquidateLoanEvent) return `liquidate:${event.liquidateLoanEvent.collateral}`
  if (event.mintNftEvent) return `mintNft:${event.mintNftEvent.tierId}`
  if (event.deployErc20Event) return `erc20:${event.deployErc20Event.symbol}`
  if (event.setUriEvent) return 'setUri'
  if (event.projectTransferEvent) return `transfer:${event.projectTransferEvent.owner}`
  if (event.operatorPermissionsSetEvent)
    return `permissions:${event.operatorPermissionsSetEvent.operator}:${event.operatorPermissionsSetEvent.isRevnetOperator}`
  if (event.rulesetQueuedEvent) return 'rulesetQueued'
  if (event.addNftTierEvent) return `addTier:${event.addNftTierEvent.tierId}`
  if (event.removeNftTierEvent) return `removeTier:${event.removeNftTierEvent.tierId}`
  if (event.swapEvent)
    return `swap:${event.swapEvent.direction}:${event.swapEvent.projectTokenAmount}`
  if (event.buybackPoolEvent) return 'buybackPool'
  if (event.bridgeClaimEvent)
    return `bridgeClaim:${event.bridgeClaimEvent.peerChainId}:${event.bridgeClaimEvent.projectTokenCount}`
  return 'other'
}

/** How far apart two chains' halves of one relayed action can land. */
const CROSS_CHAIN_MERGE_WINDOW = 6 * 3600

export type CrossChainGroup<T extends BsActivityEvent> = {
  group: T[]
  /** Every chain this action ran on; the first is the group's home chain. */
  chains: { chainId: number; txHash: string }[]
}

/**
 * Folds same-tx groups that say the same thing by the same actor on OTHER
 * chains into one item — a relayed deploy or setup runs once per chain and
 * should read as one action, the way it was authored.
 */
export function mergeCrossChainGroups<T extends BsActivityEvent>(
  groups: T[][],
): CrossChainGroup<T>[] {
  const merged: (CrossChainGroup<T> & { signature: string })[] = []
  for (const group of groups) {
    const signature = `${group[0].from}|${group
      .map(eventDisplaySignature)
      .sort()
      .join('||')}`
    const host = merged.find(
      entry =>
        entry.signature === signature &&
        Math.abs(entry.group[0].timestamp - group[0].timestamp) <=
          CROSS_CHAIN_MERGE_WINDOW &&
        !entry.chains.some(chain => chain.chainId === group[0].chainId),
    )
    if (host) {
      host.chains.push({ chainId: group[0].chainId, txHash: group[0].txHash })
    } else {
      merged.push({
        group,
        chains: [{ chainId: group[0].chainId, txHash: group[0].txHash }],
        signature,
      })
    }
  }
  return merged.map(({ group, chains }) => ({ group, chains }))
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
  const sorted = [...group].sort((a, b) => {
    const byRank = groupRank(a) - groupRank(b)
    if (byRank) return byRank
    // Reserved-split receipts read largest first.
    const left = splitTokenCount(a)
    const right = splitTokenCount(b)
    return left < right ? 1 : left > right ? -1 : 0
  })
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
  // Each buy swap pairs with its own remint in order: a tx with two buyback
  // pays has two swaps and two remints, and pairing every mint with one swap
  // (or refusing to pair at all) mislabels or drops the reserve.
  const swaps = ordered
    .filter(entry => entry.swapEvent && entry.swapEvent.direction.toLowerCase() !== 'sell')
    .map(entry => entry.swapEvent!)
  const mints = ordered.filter(entry => entry.mintTokensEvent)
  mints.forEach((entry, index) => {
    const swapEvent = swaps[index]
    if (!swapEvent) return
    const mintIndex = ordered.indexOf(entry)
    const mint = entry.mintTokensEvent!
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
            <span className="font-medium">
              {formatCompactTokenAmount(mint.beneficiaryTokenCount)} {tokenUnit}
            </span>{' '}
            after the {reservePercent}% reserve
          </>
        ),
      }
    }
  })
  // A reserved distribution's headline carries the total; its per-split
  // receipts become the bullets, each naming who got what.
  const distributed = ordered.some(entry => entry.sendReservedTokensToSplitsEvent)
  const hasReceipts = ordered.some(entry => entry.sendReservedTokensToSplitEvent)
  if (distributed) {
    ordered.forEach((entry, index) => {
      const receipt = entry.sendReservedTokensToSplitEvent
      if (!receipt) return
      parts[index] = {
        ...parts[index],
        action: (
          <>
            <span className="font-medium">
              {formatCompactTokenAmount(receipt.tokenCount)} {tokenUnit}
            </span>{' '}
            to{' '}
            {receipt.splitProjectId > 0 ? (
              <>project #{receipt.splitProjectId}</>
            ) : (
              <ActorLink
                href={addressUrl(entry.chainId, receipt.beneficiary)}
                actor={receipt.beneficiary}
              />
            )}
          </>
        ),
      }
    })
  }
  // A zero-issuance pay's "paid into the project" adds nothing next to the
  // row's amount and "in" tag — drop its fragment when other actions exist.
  // The pay still anchors the row's actor, amount, direction, and memo.
  const withFragments =
    ordered.length > 1
      ? ordered.filter(entry => {
          if (entry.sendReservedTokensToSplitsEvent) return !hasReceipts
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
    // A distribution is done "by" its caller; its receipts' inbound flow is
    // theirs, not the row's.
    direction: distributed
      ? primary.direction
      : (parts.find(part => part.direction != null)?.direction ?? null),
    kind: parts.find(part => part.kind)?.kind ?? null,
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
/** Event field → short label, first match wins. Only shown when a row has no value to lead with. */
const ACTIVITY_KINDS: [string, string][] = [
  ['payEvent', 'Payment'],
  ['addToBalanceEvent', 'Deposit'],
  ['cashOutTokensEvent', 'Cash out'],
  ['sendPayoutsEvent', 'Payout'],
  ['sendPayoutToSplitEvent', 'Payout'],
  ['useAllowanceEvent', 'Surplus used'],
  ['mintTokensEvent', 'Minted'],
  ['burnEvent', 'Burned'],
  ['mintNftEvent', 'Item minted'],
  ['swapEvent', 'Swap'],
  ['borrowLoanEvent', 'Loan'],
  ['repayLoanEvent', 'Loan repaid'],
  ['liquidateLoanEvent', 'Loan liquidated'],
  ['bridgeClaimEvent', 'Bridged in'],
  ['bridgeToRemoteEvent', 'Bridged out'],
  ['bridgeToOutboxEvent', 'Bridged out'],
  ['sendReservedTokensToSplitsEvent', 'Reserved tokens'],
  ['sendReservedTokensToSplitEvent', 'Reserved tokens'],
  ['rulesetQueuedEvent', 'Rules queued'],
  ['projectCreateEvent', 'Created'],
  ['projectTransferEvent', 'Ownership'],
  ['setUriEvent', 'Details updated'],
  ['addNftTierEvent', 'Item added'],
  ['removeNftTierEvent', 'Item removed'],
  ['operatorPermissionsSetEvent', 'Permissions'],
  ['buybackPoolEvent', 'Buyback pool'],
  ['autoIssueEvent', 'Auto issuance'],
]

function activityKind(event: BsActivityEvent): string | null {
  const fields = event as unknown as Record<string, unknown>
  return ACTIVITY_KINDS.find(([field]) => fields[field])?.[1] ?? null
}

export function activityParts(
  event: BsActivityEvent,
  tokenUnit: string,
): {
  actor: string
  action: ReactNode
  direction: 'in' | 'out' | null
  kind: string | null
  headline: ActivityHeadline | null
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
        <span className="font-medium">
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
      <span className="font-medium">
        {tokenCount} {tokenUnit}
      </span>
    </>
  ) : mint ? (
    <>
      minted{' '}
      <span className="font-medium">
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
      <span className="font-medium">
        {tokenCount} {tokenUnit}
      </span>
    </>
  ) : event.autoIssueEvent ? (
    <>
      auto-issued{' '}
      <span className="font-medium">
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
      <span className="font-medium">
        {tokenCount} {tokenUnit}
      </span>{' '}
      via the buyback pool
    </>
  ) : event.buybackPoolEvent ? (
    <>set up a buyback pool</>
  ) : event.bridgeClaimEvent ? (
    <>
      claimed{' '}
      <span className="font-medium">
        {tokenCount} {tokenUnit}
      </span>{' '}
      from {chainName(event.bridgeClaimEvent.peerChainId)}
    </>
  ) : event.sendPayoutToSplitEvent ? (
    <>received a payout split</>
  ) : event.sendReservedTokensToSplitEvent ? (
    <>
      received{' '}
      <span className="font-medium">
        {tokenCount} {tokenUnit}
      </span>{' '}
      from a reserved split
    </>
  ) : (
    <>updated the project</>
  )
  const memo = pay?.memo ?? event.addToBalanceEvent?.memo ?? null
  // A reserved distribution leads with the count the way value flows lead
  // with the amount: "3.6m ART" tagged "reserved distro".
  const headline: ActivityHeadline | null =
    issuedTokens && event.sendReservedTokensToSplitsEvent
      ? { amount: `${tokenCount} ${tokenUnit}`, tag: 'reserved distro' }
      : null

  return {
    actor,
    action,
    direction,
    kind: activityKind(event),
    headline,
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
  chains,
  tokenUnit,
  accountingToken,
}: {
  group: BsActivityEvent[]
  /** Every chain this action ran on; defaults to the group's own chain. */
  chains?: { chainId: number; txHash: string }[]
  tokenUnit: string
  accountingToken?: Omit<ActivityAmountToken, 'raw'> | null
}) {
  const event = group[0]
  const { actor, actions, direction, kind, headline, memo, amountUsd, amountRaw } =
    combinedActivityParts(group, tokenUnit)
  const actorLink = actor ? addressUrl(event.chainId, actor) : null
  const link = txUrl(event.chainId, event.txHash)
  const relativeTime = timeAgo(event.timestamp)
  const actorNode = <ActorLink href={actorLink} actor={actor} />
  const amountToken = accountingToken ? { raw: amountRaw, ...accountingToken } : null
  // No amount and no flow tag = nothing for the title slot; the actor takes
  // its place (bare, no "to/from/by") instead of leaving a blank line.
  const hasTitle =
    activityAmountLabel(amountUsd, amountToken) !== null || kind !== null
  const alsoOn = (chains ?? []).filter(chain => chain.chainId !== event.chainId)

  return (
    <li className="flex gap-3 py-3.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2 text-xs text-smoke-500">
          {/* One shape for every row: the flow cluster left with "time on
              <chain>" right, the prefixed actor below, then the memo headline
              and the actions as fine-print bullets. */}
          {hasTitle ? (
            <ActivityAmountLine
              amountUsd={amountUsd}
              amountToken={amountToken}
              direction={direction}
              kind={kind}
              headline={headline}
            />
          ) : (
            <span className="min-w-0 truncate">{actorNode}</span>
          )}
          <span className="flex shrink-0 items-center gap-1.5">
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
            <ActivityOnChain
              chainId={event.chainId}
              txHash={event.txHash}
              also={alsoOn}
            />
          </span>
        </div>
        {hasTitle ? (
          <p className="mt-1 flex min-w-0 items-center gap-1 text-xs text-smoke-500">
            {actorPrefix(direction)} <span className="min-w-0 truncate">{actorNode}</span>
          </p>
        ) : null}
        {memo ? (
          <p className="mt-3 break-words text-sm leading-relaxed text-ink">
            “{memo}”
          </p>
        ) : null}
        <ul className={`${memo ? 'mt-1' : 'mt-3'} space-y-0.5 text-xs text-smoke-500`}>
          {/* Hand-rolled markers: the dot sits flush left while wrapped
              lines keep hanging-indent alignment with the first line's text. */}
          {actions.map((action, index) => (
            <li
              key={index}
              className="relative break-words pl-3.5 before:absolute before:left-0 before:top-[5px] before:h-1.5 before:w-1.5 before:rounded-full before:bg-smoke-300 before:content-['']"
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

  const projectEvents = projectFeedEvents(liveEvents)
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
        <ul className="max-h-[70dvh] divide-y divide-smoke-100 overflow-y-auto py-1 min-[801px]:max-h-[max(780px,82vh)]">
          {mergeCrossChainGroups(groupSameTxEvents(visible)).map(({ group, chains }) => (
            <Row
              key={group[0].id}
              group={group}
              chains={chains}
              tokenUnit={tokenUnit}
              accountingToken={accountingToken}
            />
          ))}
        </ul>
      ) : (
        <div className="flex min-h-[180px] items-center justify-center rounded-xl border border-dashed border-smoke-300 p-5 text-sm text-smoke-500">
          {liveEvents.length < liveTotal
            ? 'No activity matches this filter in the rows loaded so far.'
            : 'No activity matches this filter.'}
        </div>
      )}
      {liveEvents.length < liveTotal ? (
        <div className="mt-3 flex flex-col items-start gap-2">
          <button
            onClick={() => void loadMore()}
            disabled={loadingMore}
            title={`${liveEvents.length} of ${liveTotal} loaded`}
            className="min-h-[32px] text-xs font-medium text-smoke-700 underline underline-offset-2 hover:text-ink disabled:opacity-60"
          >
            {loadingMore ? 'Loading…' : 'more'}
          </button>
          {loadMoreError ? (
            <p className="text-xs text-crush-600">{loadMoreError}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
