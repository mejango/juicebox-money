'use client'

import {
  JBCoreContracts,
  RevnetCoreContracts,
  SPLITS_TOTAL_PERCENT,
  jbContractAddress,
  jbDirectoryAbi,
  jbProjectsAbi,
  jbSplitsAbi,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import {
  JBPermissionIdsV6,
  RESERVED_TOKEN_SPLIT_GROUP_ID,
  hasPermissions,
  getCurrentRuleset,
  type JBSplit,
} from '@bananapus/nana-sdk-core/v6'
import { useQuery } from '@tanstack/react-query'
import { FormFieldsSkeleton } from '@/components/LoadingSkeletons'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  zeroAddress,
  isAddress,
  type Address,
  type PublicClient,
} from 'viem'
import { usePublicClient, useReadContract } from 'wagmi'
import {
  SplitsEditor,
  newDraftSplit,
  splitOk,
  type DraftSplit,
} from '@/components/create/SplitsEditor'
import { TxConfirmDialog, type TxConfirmRow } from '@/components/ui/TxConfirmDialog'
import { TxError } from '@/components/ui/TxError'
import { useWallet } from '@/hooks/useWallet'
import { clientFor, runAuthorityCalls, safeOutcomeMessage, type AuthorityCall } from '@/lib/authority'
import { readAuthorityIdentity } from '@/lib/cross-chain-authority'
import { loadRelayrPendingSession, relayrCallsScope, resumeRelayrSession } from '@/lib/relayr'
import { relayrSupportsChain, relayrSupportsChains } from '@/lib/relayr-chains'
import { getRevnetOperator } from '@/lib/bendystraw'
import { resolvedAddress } from '@/lib/ens'
import {
  billionthsToPct,
  toLocalDateTimeInput,
  truncateAddress,
} from '@/lib/format'
import { lpSplitHookGeneration, requireLpSplitHook } from '@/lib/launch'
import { isKnownController } from '@/lib/manage'
import { fetchSafeInfo } from '@/lib/safe'
import type { RawSplit } from '@/lib/splits-types'
import { buildSplitGroupsAuthorityCall } from '@/lib/transaction-builders'
import { chainName } from '@/lib/urn'

/** A stable string of the on-chain splits, for fingerprint comparison. */
function fingerprint(splits: readonly RawSplit[]): string {
  return JSON.stringify(
    splits.map(s => [
      s.percent,
      s.projectId.toString(),
      s.beneficiary.toLowerCase(),
      s.preferAddToBalance,
      s.lockedUntil,
      s.hook.toLowerCase(),
    ]),
  )
}

/** One live split → an editable draft row (percents are 0-100 strings). The
 *  lock renders as LOCAL wall clock because `draftToSplit` parses it back as
 *  local — a UTC string here would re-encode the lock shifted by the viewer's
 *  offset. */
export function splitToDraft(sp: RawSplit): DraftSplit {
  const base = newDraftSplit()
  const value = billionthsToPct(sp.percent, 7)
  const lockedUntil =
    sp.lockedUntil > 0 ? toLocalDateTimeInput(sp.lockedUntil) : ''
  if (sp.hook !== zeroAddress) {
    return {
      ...base,
      value,
      kind: 'hook',
      // Both the current market hook and every superseded generation read as a market
      // split; the legacy kind re-encodes `hookAddress` verbatim so an existing split is
      // never silently migrated to a different hook by an unrelated edit.
      hookKind:
        lpSplitHookGeneration(sp.hook) === 'current'
          ? 'fundmarket'
          : lpSplitHookGeneration(sp.hook) === 'legacy'
            ? 'fundmarket-legacy'
            : 'custom',
      hookAddress: sp.hook,
      projectId: sp.projectId > 0n ? String(sp.projectId) : '',
      beneficiary: sp.beneficiary !== zeroAddress ? sp.beneficiary : '',
      lockedUntil,
    }
  }
  if (sp.projectId > 0n) {
    return {
      ...base,
      value,
      kind: 'project',
      projectId: String(sp.projectId),
      beneficiary: sp.beneficiary,
      preferAddToBalance: sp.preferAddToBalance,
      lockedUntil,
    }
  }
  return {
    ...base,
    value,
    kind: 'address',
    recipient: sp.beneficiary,
    lockedUntil,
  }
}

/** An editable draft row → a JBSplit (percent out of 1e9). Assumes the row
 *  passed `splitOk`, so every referenced address resolves. */
function draftToSplit(row: DraftSplit, chainId: number): JBSplit {
  const lockedUntil = row.lockedUntil
    ? Math.floor(new Date(row.lockedUntil).getTime() / 1000)
    : 0
  const percent = Math.round(Number(row.value) * 1e7)
  if (row.kind === 'hook') {
    const id = row.projectId.trim().replace('#', '')
    return {
      percent,
      projectId: id ? BigInt(id) : 0n,
      beneficiary: resolvedAddress(row.beneficiary) ?? zeroAddress,
      preferAddToBalance: false,
      lockedUntil,
      hook:
        row.hookKind === 'fundmarket'
          ? requireLpSplitHook(chainId)
          : resolvedAddress(row.hookAddress)!,
    }
  }
  if (row.kind === 'project') {
    return {
      percent,
      projectId: BigInt(row.projectId.trim().replace('#', '')),
      beneficiary: row.preferAddToBalance
        ? (resolvedAddress(row.beneficiary) ?? zeroAddress)
        : resolvedAddress(row.beneficiary)!,
      preferAddToBalance: row.preferAddToBalance,
      lockedUntil,
      hook: zeroAddress,
    }
  }
  return {
    percent,
    projectId: 0n,
    beneficiary: resolvedAddress(row.recipient)!,
    preferAddToBalance: false,
    lockedUntil,
    hook: zeroAddress,
  }
}

/** The ruleset JBSplits falls back to when a group is empty. */
const FALLBACK_RULESET_ID = 0n

/**
 * The project's ruleset-0 group for the group being edited. Clearing a group
 * is blocked unless the fallback is verified `empty`, since an unverified
 * fallback could reroute the whole share.
 */
export type FallbackSplits =
  | { status: 'empty' }
  | { status: 'nonEmpty'; count: number }
  | { status: 'checking' }
  | { status: 'unknown' }

/** Classify a ruleset-0 read. A missing result never reads as "empty". */
export function describeFallbackSplits(
  splits: readonly RawSplit[] | undefined | null,
): FallbackSplits {
  if (!splits) return { status: 'unknown' }
  return splits.length > 0
    ? { status: 'nonEmpty', count: splits.length }
    : { status: 'empty' }
}

/**
 * Why an empty group can't be saved, or `null` when clearing it really does
 * leave the group unallocated. `JBSplits.splitsOf` serves the ruleset-0 group
 * whenever the addressed group is empty, so an empty save only stops paying
 * the listed recipients — it does not stop paying.
 */
export function clearBlockReason(fallback: FallbackSplits): string | null {
  if (fallback.status === 'empty') return null
  if (fallback.status === 'nonEmpty') {
    return `Clearing this group would activate the project’s default splits (${fallback.count} recipient${fallback.count === 1 ? '' : 's'}), not send tokens to the owner. Keep at least one recipient here, or change the default splits first.`
  }
  if (fallback.status === 'checking') {
    return 'Checking the project’s default splits, which would take over an emptied group…'
  }
  return 'Couldn’t verify the project’s default splits, so clearing this group is blocked — an unread default group could take over the whole share. Close and try again.'
}

/** Shown when clearing the reserved group is verified safe. */
export const CLEARED_RESERVED_NOTE =
  'No reserved splits — this project has no default splits for this group, so saving clears the list and the reserved share accrues to the project owner. To stop reserving tokens entirely, change the reserved share in a new ruleset.'

/**
 * The exact `setSplitGroupsOf` splits for a save: locked rows re-submitted
 * verbatim (byte-exact, so the contract's locked-split check passes), then
 * the editable drafts rebuilt. An EMPTY result clears the group, which only
 * routes the share to the project owner when the ruleset-0 fallback group is
 * verified empty — otherwise `splitsOf` starts serving those default splits,
 * so the save is refused.
 */
export function assembleSplits(
  lockedRows: readonly RawSplit[],
  drafts: readonly DraftSplit[],
  fallback: FallbackSplits,
  chainId: number,
): { splits: JBSplit[] } | { error: string } {
  if (!drafts.every(s => splitOk(s, 'percent'))) {
    return { error: 'Fix the highlighted recipients before saving.' }
  }
  let editable: JBSplit[]
  try {
    editable = drafts.map(row => draftToSplit(row, chainId))
  } catch (err) {
    return { error: (err as Error).message }
  }
  if (editable.some(s => s.percent <= 0)) {
    return { error: 'Every recipient needs a share above 0%.' }
  }
  if (lockedRows.length === 0 && editable.length === 0) {
    const blocked = clearBlockReason(fallback)
    if (blocked) return { error: blocked }
  }
  return {
    splits: [
      ...lockedRows.map(
        (s): JBSplit => ({
          percent: s.percent,
          projectId: s.projectId,
          beneficiary: s.beneficiary,
          preferAddToBalance: s.preferAddToBalance,
          lockedUntil: s.lockedUntil,
          hook: s.hook,
        }),
      ),
      ...editable,
    ],
  }
}

export type SplitSnapshot = {
  chainId: JBChainId
  projectId: number
  groupId: bigint
  rulesetId: bigint
  owner: Address
  controller: Address
  authority: Address
  currentSplits: readonly RawSplit[]
  fallbackSplits: readonly RawSplit[]
  relayable: boolean
}

export type SplitReview = {
  account: Address
  title: string
  destinations: (SplitSnapshot & { splits: JBSplit[] })[]
}

type SplitJournal = { scope: string; review: SplitReview }

/** Resolve this project's current group and permission from its own chain. */
export async function readSplitDestination({ chainId, projectId, groupId, account, rulesetId }: {
  chainId: JBChainId; projectId: number; groupId: bigint; account: Address; rulesetId?: bigint
}): Promise<SplitSnapshot> {
  const client = clientFor(chainId)
  const addresses = jbContractAddress['6']
  const [owner, controller, current] = await Promise.all([
    client.readContract({ address: addresses[JBCoreContracts.JBProjects][chainId], abi: jbProjectsAbi, functionName: 'ownerOf', args: [BigInt(projectId)] }),
    client.readContract({ address: addresses[JBCoreContracts.JBDirectory][chainId], abi: jbDirectoryAbi, functionName: 'controllerOf', args: [BigInt(projectId)] }),
    getCurrentRuleset(client, { chainId, projectId: BigInt(projectId) }),
  ])
  if (!isKnownController(chainId, controller)) throw new Error(`${chainName(chainId)} uses an unsupported controller.`)
  const currentId = BigInt(current.ruleset.id)
  if (rulesetId !== 0n && (currentId === 0n || (rulesetId !== undefined && rulesetId !== currentId))) {
    throw new Error(`The current ruleset changed on ${chainName(chainId)}. Reopen the split editor.`)
  }
  const targetRulesetId = rulesetId === 0n ? 0n : currentId
  const permitted = (operator: Address) => hasPermissions(client, {
    chainId, operator, account: owner, projectId: BigInt(projectId), permissionIds: [JBPermissionIdsV6.SET_SPLIT_GROUPS],
  })
  let authority: Address | null = null
  const ownerIdentity = await readAuthorityIdentity(client, owner)
  if (account.toLowerCase() === owner.toLowerCase() || (ownerIdentity?.kind === 'safe' && ownerIdentity.owners.some(signer => signer.toLowerCase() === account.toLowerCase()))) {
    authority = owner
  } else if (await permitted(account)) {
    authority = account
  } else {
    // A revnet operator may itself be a Safe. Its indexed address is only a
    // candidate: live Safe membership and the owner's permission must agree.
    const revOwner = addresses[RevnetCoreContracts.REVOwner][chainId]
    if (revOwner && owner.toLowerCase() === revOwner.toLowerCase()) {
      const operator = await getRevnetOperator(chainId, projectId)
      if (operator && isAddress(operator)) {
        const identity = await readAuthorityIdentity(client, operator)
        if (identity?.kind === 'safe' && identity.owners.some(signer => signer.toLowerCase() === account.toLowerCase()) && await permitted(operator)) authority = operator
      }
    }
  }
  if (!authority) throw new Error(`This wallet cannot edit splits on ${chainName(chainId)}.`)
  const identity = await readAuthorityIdentity(client, authority)
  const [currentSplits, fallbackSplits] = await Promise.all([
    client.readContract({ address: addresses[JBCoreContracts.JBSplits][chainId], abi: jbSplitsAbi, functionName: 'splitsOf', args: [BigInt(projectId), targetRulesetId, groupId] }),
    targetRulesetId === 0n ? Promise.resolve([]) : client.readContract({ address: addresses[JBCoreContracts.JBSplits][chainId], abi: jbSplitsAbi, functionName: 'splitsOf', args: [BigInt(projectId), 0n, groupId] }),
  ])
  return { chainId, projectId, groupId, rulesetId: targetRulesetId, owner, controller, authority,
    currentSplits, fallbackSplits,
    relayable: relayrSupportsChain(chainId) && authority.toLowerCase() === account.toLowerCase() && (identity?.kind === 'eoa' || identity?.kind === 'delegated-eoa'),
  }
}

function addressOnlySplits(rows: readonly RawSplit[], now: number): boolean {
  return rows.every(split => split.lockedUntil > now || (split.projectId === 0n && split.hook.toLowerCase() === zeroAddress))
}

function sharedAddressDrafts(drafts: readonly DraftSplit[]): boolean {
  return drafts.every(draft => draft.kind === 'address' &&
    [draft.perChain, draft.perChainBeneficiary, draft.perChainAmount].every(overrides => Object.values(overrides).every(value => !value.trim())))
}

/** Peer locked rows stay byte-exact; only verified address recipients are shared. */
export function assembleReservedDestination(snapshot: SplitSnapshot, drafts: readonly DraftSplit[], now = Math.floor(Date.now() / 1000)): JBSplit[] {
  if (snapshot.groupId !== RESERVED_TOKEN_SPLIT_GROUP_ID || snapshot.rulesetId === 0n) throw new Error('Only current reserved recipients can be edited across chains.')
  if (!sharedAddressDrafts(drafts) || !addressOnlySplits(snapshot.currentSplits, now)) {
    throw new Error(`${chainName(snapshot.chainId)} has project or hook recipients, or chain-specific overrides. Edit this chain separately.`)
  }
  const assembled = assembleSplits(snapshot.currentSplits.filter(split => split.lockedUntil > now), drafts, describeFallbackSplits(snapshot.fallbackSplits), snapshot.chainId)
  if ('error' in assembled) throw new Error(`${chainName(snapshot.chainId)}: ${assembled.error}`)
  if (assembled.splits.reduce((total, split) => total + split.percent, 0) > SPLITS_TOTAL_PERCENT) throw new Error(`${chainName(snapshot.chainId)}'s locked and new recipients exceed 100%.`)
  return assembled.splits
}

export function splitSnapshotFingerprint(snapshot: SplitSnapshot): string {
  return JSON.stringify([snapshot.chainId, snapshot.projectId, snapshot.rulesetId.toString(), snapshot.groupId.toString(),
    snapshot.owner.toLowerCase(), snapshot.authority.toLowerCase(), snapshot.controller.toLowerCase(),
    fingerprint(snapshot.currentSplits), fingerprint(snapshot.fallbackSplits)])
}

export function reviewedSplitCalls(review: SplitReview): AuthorityCall[] {
  return review.destinations.map(destination => ({
    ...buildSplitGroupsAuthorityCall({ chainId: destination.chainId, projectId: BigInt(destination.projectId), authority: destination.authority, controller: destination.controller,
      rulesetId: destination.rulesetId, splitGroups: [{ groupId: destination.groupId, splits: destination.splits }], label: `Edit ${review.title}` }),
    reverifyAuthority: async () => {
      const current = await readSplitDestination({ ...destination, account: review.account })
      if (splitSnapshotFingerprint(current) !== splitSnapshotFingerprint(destination)) {
        throw new Error(`The authority, current ruleset, or split recipients changed on ${chainName(destination.chainId)}. Reopen and review the live splits.`)
      }
      if (review.destinations.length > 1) {
        if (!relayrSupportsChains(review.destinations.map(item => item.chainId))) throw new Error('Choose supported chains from the same network family: all mainnets or all testnets.')
        if (!current.relayable) throw new Error('Edit Safe accounts and different authorities separately.')
      }
      if (destination.splits.length === 0) {
        const blocked = clearBlockReason(describeFallbackSplits(current.fallbackSplits))
        if (blocked) throw new Error(blocked)
      }
    },
  }))
}

function splitJournalKey(chainId: number, projectId: number, groupId: bigint): string {
  return `jbm:edit-splits:${chainId}:${projectId}:${groupId}`
}

export function readSplitJournal(key: string): SplitJournal | null {
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return null
    const journal = JSON.parse(raw, (_key, value) => value && typeof value === 'object' && Object.keys(value).length === 1 && typeof value.bigint === 'string' ? BigInt(value.bigint) : value) as SplitJournal
    if (!journal.review?.destinations?.length || journal.scope !== relayrCallsScope(reviewedSplitCalls(journal.review))) return null
    return journal
  } catch { return null }
}

function pendingSplitJournal(key: string): SplitJournal | null {
  const journal = readSplitJournal(key)
  return journal && loadRelayrPendingSession(journal.scope) ? journal : null
}

export function saveSplitJournal(journal: SplitJournal): void {
  const encoded = JSON.stringify(journal, (_key, value) => typeof value === 'bigint' ? { bigint: value.toString() } : value)
  for (const destination of journal.review.destinations) {
    const key = splitJournalKey(destination.chainId, destination.projectId, destination.groupId)
    const pending = pendingSplitJournal(key)
    if (pending && pending.scope !== journal.scope) throw new Error(`Resume the pending splits on ${chainName(destination.chainId)} first.`)
    window.localStorage.setItem(key, encoded)
    if (window.localStorage.getItem(key) !== encoded) throw new Error('Allow browser storage before editing splits on multiple chains.')
  }
}

function clearSplitJournal(journal: SplitJournal): void {
  for (const destination of journal.review.destinations) {
    const key = splitJournalKey(destination.chainId, destination.projectId, destination.groupId)
    if (readSplitJournal(key)?.scope === journal.scope) window.localStorage.removeItem(key)
  }
}

async function withSplitLocks<T>(destinations: SplitReview['destinations'], run: () => Promise<T>): Promise<T> {
  if (typeof navigator === 'undefined' || !navigator.locks) {
    if (destinations.length === 1) return run()
    throw new Error('Use a browser with Web Locks support to edit splits on multiple chains.')
  }
  const keys = destinations.map(destination => splitJournalKey(destination.chainId, destination.projectId, destination.groupId)).sort()
  const next = async (index: number): Promise<T> => index === keys.length ? run() : await navigator.locks.request(keys[index], { ifAvailable: true }, async lock => {
    if (!lock) throw new Error('These split recipients are being edited in another tab.')
    return next(index + 1)
  })
  return next(0)
}

export function SplitRecovery({ journal, onComplete }: { journal: SplitJournal; onComplete: () => void }) {
  const { address } = useWallet()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState('A split update is saved. Resume it before editing these recipients again.')
  return <div className="mt-3 space-y-3 rounded-xl border border-smoke-200 p-4">
    <p className="text-sm text-smoke-700">{status}</p>
    <TxError error={error} />
    <button className="btn-primary min-h-[44px] px-5 text-sm" disabled={busy || !address} onClick={async () => {
      if (!address) return
      setBusy(true); setError(null)
      try {
        if (address.toLowerCase() !== journal.review.account.toLowerCase()) throw new Error('Connect the wallet that reviewed this split update.')
        await withSplitLocks(journal.review.destinations, async () => {
          for (const destination of journal.review.destinations) {
            const alias = readSplitJournal(splitJournalKey(destination.chainId, destination.projectId, destination.groupId))
            if (alias?.scope !== journal.scope || alias.review.account.toLowerCase() !== journal.review.account.toLowerCase()) throw new Error('The saved split review changed. Reopen its original action.')
          }
          const saved = loadRelayrPendingSession(journal.scope)
          if (!saved) throw new Error('This saved bundle is no longer pending. Reload to read the current recipients.')
          if (saved.paymentStatus === 'unpaid') {
            await runAuthorityCalls({ calls: reviewedSplitCalls(journal.review), onProgress: progress => setStatus(progress.message) })
          } else await resumeRelayrSession({ scope: journal.scope, account: address, onProgress: progress => setStatus(progress.phase === 'executing'
            ? `Relayr reports ${progress.done}/${progress.total} complete. Verifying the original transactions…`
            : 'Checking the saved payment and destination transactions…') })
          clearSplitJournal(journal)
        })
        onComplete()
      } catch (err) { setError(err instanceof Error ? err.message : 'Could not resume the split update.') }
      finally { setBusy(false) }
    }}>{busy ? 'Checking saved update…' : 'Resume split update'}</button>
  </div>
}

/**
 * Edit current reserved recipients across verified peer projects, or edit a
 * payout/project/hook group on one chain. The owner/operator modal reuses the
 * create-flow SplitsEditor.
 *
 * Locked splits (a lockedUntil in the future) can't be removed or reduced, so
 * they're held OUT of the editable list — shown read-only and re-submitted
 * byte-for-byte — which is also what the JBSplits contract requires. Live
 * splits are fingerprinted at open and re-read around review, signatures,
 * and payment: a changed source must be reviewed again before replacing it. setSplitGroupsOf goes to the project's resolved
 * controller through the same simulation-first Safe/Relayr authority router
 * used by the Owner/Operator tab.
 */
export function EditSplitsFlow({
  chainId,
  projectId,
  groupId,
  title,
  rulesetId,
  isRevnet = false,
  chains = [],
}: {
  chainId: JBChainId
  projectId: number
  groupId: bigint
  title: string
  rulesetId: bigint
  isRevnet?: boolean
  chains?: readonly (readonly [number, number])[]
}) {
  const { isConnected, address } = useWallet()

  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  const publicClient = usePublicClient({ chainId }) as PublicClient | undefined

  const { data: owner } = useReadContract({
    abi: jbProjectsAbi,
    address: jbContractAddress['6'][JBCoreContracts.JBProjects][chainId],
    functionName: 'ownerOf',
    args: [BigInt(projectId)],
    chainId,
    query: { enabled: mounted && isConnected && !!address, staleTime: 60_000 },
  })

  const isOwner =
    mounted &&
    isConnected &&
    !!address &&
    !!owner &&
    owner.toLowerCase() === address.toLowerCase()

  const { data: revnetOperator } = useQuery({
    queryKey: ['editSplitsRevnetOperator', chainId, projectId],
    enabled: mounted && isRevnet,
    staleTime: 30_000,
    queryFn: () => getRevnetOperator(chainId, projectId),
  })
  const projectAuthority = (isRevnet ? revnetOperator : owner) as
    | Address
    | null
    | undefined
  const { data: authoritySafe } = useQuery({
    queryKey: ['editSplitsAuthoritySafe', chainId, projectAuthority],
    enabled: mounted && !!projectAuthority,
    staleTime: 30_000,
    queryFn: () => fetchSafeInfo(chainId, projectAuthority!),
  })
  const isDirectAuthority =
    !!address &&
    !!projectAuthority &&
    address.toLowerCase() === projectAuthority.toLowerCase()
  const isAuthoritySafeSigner =
    !!address &&
    !!authoritySafe?.owners.some(
      signer => signer.toLowerCase() === address.toLowerCase(),
    )

  // A revnet's owner is the REVOwner contract, so the human editing splits is
  // an operator holding SET_SPLIT_GROUPS granted FROM the owner (matching the
  // contract's _requirePermissionFrom(owner, …) check) — not the owner NFT.
  const { data: canOperate } = useQuery({
    queryKey: ['editSplitsPerm', chainId, projectId, address, owner],
    enabled:
      mounted &&
      isConnected &&
      !!address &&
      !!owner &&
      !isOwner &&
      !isDirectAuthority &&
      !isAuthoritySafeSigner &&
      !!publicClient,
    staleTime: 60_000,
    queryFn: () =>
      hasPermissions(publicClient!, {
        chainId,
        operator: address!,
        account: owner!,
        projectId: BigInt(projectId),
        permissionIds: [JBPermissionIdsV6.SET_SPLIT_GROUPS],
      }),
  })

  const canEdit =
    isOwner ||
    isDirectAuthority ||
    isAuthoritySafeSigner ||
    canOperate === true
  const actionAuthority =
    isDirectAuthority || isAuthoritySafeSigner || isOwner
      ? projectAuthority
      : canOperate === true
        ? address
        : null

  const { data: controller } = useReadContract({
    abi: jbDirectoryAbi,
    address: jbContractAddress['6'][JBCoreContracts.JBDirectory][chainId],
    functionName: 'controllerOf',
    args: [BigInt(projectId)],
    chainId,
    query: { enabled: canEdit, staleTime: 60_000 },
  })

  const { data: pending, refetch: refreshPending } = useQuery({
    queryKey: ['editSplitsRecovery', chainId, projectId, groupId.toString(), address],
    enabled: mounted && !!address,
    staleTime: 0,
    queryFn: () => pendingSplitJournal(splitJournalKey(chainId, projectId, groupId)),
  })
  const [recovered, setRecovered] = useState(false)
  if (pending) return <SplitRecovery journal={pending} onComplete={() => { setRecovered(true); void refreshPending() }} />
  if (recovered) return <p className="mt-3 text-sm text-smoke-700">The saved split update is confirmed on every destination. Reload to see the recipients.</p>

  if (
    !canEdit ||
    !actionAuthority ||
    !isKnownController(chainId, controller)
  ) {
    return null
  }

  return (
    <EditSplitsModal
      chainId={chainId}
      projectId={projectId}
      groupId={groupId}
      title={title}
      rulesetId={rulesetId}
      controller={controller!}
      authority={actionAuthority}
      chains={chains}
      onPending={() => void refreshPending()}
    />
  )
}

function EditSplitsModal({
  chainId,
  projectId,
  groupId,
  title,
  rulesetId,
  controller,
  authority,
  chains,
  onPending,
}: {
  chainId: JBChainId
  projectId: number
  groupId: bigint
  title: string
  rulesetId: bigint
  controller: Address
  authority: Address
  chains: readonly (readonly [number, number])[]
  onPending: () => void
}) {
  const publicClient = usePublicClient({ chainId }) as PublicClient | undefined

  const [open, setOpen] = useState(false)
  const [drafts, setDrafts] = useState<DraftSplit[]>([])
  const [lockedRows, setLockedRows] = useState<RawSplit[]>([])
  const [baseline, setBaseline] = useState<string | null>(null)
  const [flowError, setFlowError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  // The exact splits frozen at review, so what's confirmed is what's sent.
  const [plan, setPlan] = useState<SplitReview | null>(null)
  const initialized = useRef(false)
  const initialFallback = useRef<string | null>(null)
  const [lockSnapshotAt, setLockSnapshotAt] = useState<number | null>(null)
  const { address } = useWallet()
  const [selectedChains, setSelectedChains] = useState<Set<number>>(() => new Set([chainId]))
  const projectScope = useMemo(() => {
    const destinations = new Map<number, readonly [JBChainId, number]>([[chainId, [chainId, projectId]]])
    let error: string | null = null
    for (const [id, pid] of chains) {
      const existing = destinations.get(id)
      if (existing && existing[1] !== pid) error = `The linked project IDs conflict on ${chainName(id)}. Reload before editing these recipients.`
      else destinations.set(id, [id as JBChainId, pid])
    }
    return { chains: Array.from(destinations.values()), error }
  }, [chainId, projectId, chains])
  const projectChains = projectScope.chains

  const splitsAddr = jbContractAddress['6'][JBCoreContracts.JBSplits][
    chainId
  ] as Address
  const isReserved = groupId === RESERVED_TOKEN_SPLIT_GROUP_ID

  const destinationsQuery = useQuery({
    queryKey: ['editSplitsDestinations', projectChains.map(([id, pid]) => `${id}:${pid}`).join('|'), rulesetId.toString(), groupId.toString(), address],
    enabled: open && isReserved && !!address && projectChains.length > 1,
    staleTime: 0,
    queryFn: () => Promise.all(projectChains.map(async ([id, pid]) => {
      try {
        const snapshot = await readSplitDestination({ chainId: id, projectId: pid, groupId, account: address!, ...(id === chainId ? { rulesetId } : {}) })
        return { chainId: id, snapshot, error: null }
      } catch (err) {
        return { chainId: id, snapshot: null, error: err instanceof Error ? err.message : 'Could not verify this chain.' }
      }
    })),
  })
  const primarySnapshot = destinationsQuery.data?.find(row => row.chainId === chainId)?.snapshot
  const primaryRelayable = !!primarySnapshot?.relayable && addressOnlySplits(primarySnapshot.currentSplits, lockSnapshotAt ?? Math.floor(Date.now() / 1000))
  const multiBlocked = selectedChains.size > 1 && !sharedAddressDrafts(drafts)
    ? 'Project and hook recipients must be edited separately. Deselect other chains to continue.'
    : null

  const {
    data: live,
    isLoading,
    isFetching: liveFetching,
    isError,
  } = useQuery({
    queryKey: ['editSplitsLive', chainId, projectId, rulesetId.toString(), groupId.toString()],
    enabled: open && !!publicClient,
    staleTime: 0,
    retry: 1,
    queryFn: async () =>
      (await publicClient!.readContract({
        address: splitsAddr,
        abi: jbSplitsAbi,
        functionName: 'splitsOf',
        args: [BigInt(projectId), rulesetId, groupId],
      })) as readonly RawSplit[],
  })

  // The ruleset-0 group JBSplits serves whenever this group is empty. Editing
  // ruleset 0 itself IS the fallback, so there's nothing behind it.
  const { data: fallbackRows, isFetching: fallbackFetching } = useQuery({
    queryKey: ['editSplitsFallback', chainId, projectId, groupId.toString()],
    enabled: open && !!publicClient && rulesetId !== FALLBACK_RULESET_ID,
    staleTime: 0,
    retry: 1,
    queryFn: async () =>
      (await publicClient!.readContract({
        address: splitsAddr,
        abi: jbSplitsAbi,
        functionName: 'splitsOf',
        args: [BigInt(projectId), FALLBACK_RULESET_ID, groupId],
      })) as readonly RawSplit[],
  })
  const fallback: FallbackSplits =
    rulesetId === FALLBACK_RULESET_ID
      ? { status: 'empty' }
      : !fallbackRows && fallbackFetching
        ? { status: 'checking' }
        : describeFallbackSplits(fallbackRows)

  useEffect(() => {
    if (open && !fallbackFetching && fallbackRows && initialFallback.current === null) initialFallback.current = fingerprint(fallbackRows)
  }, [open, fallbackFetching, fallbackRows])

  // Initialize the editor once, from the freshly loaded live splits, and
  // capture the fingerprint that the submit-time re-read is checked against.
  useEffect(() => {
    if (!open || !live || liveFetching || fallbackFetching || initialized.current) return
    const now = Math.floor(Date.now() / 1000)
    setLockSnapshotAt(now)
    setLockedRows(live.filter(s => s.lockedUntil > now).map(s => ({ ...s })))
    setDrafts(live.filter(s => s.lockedUntil <= now).map(splitToDraft))
    setBaseline(fingerprint(live))
    initialized.current = true
  }, [open, live, liveFetching, fallbackFetching])

  const lockedPercent = useMemo(
    () => lockedRows.reduce((sum, s) => sum + s.percent, 0),
    [lockedRows],
  )
  const editablePercent = useMemo(
    () =>
      drafts.reduce(
        (sum, s) => sum + (splitOk(s, 'percent') ? Math.round(Number(s.value) * 1e7) : 0),
        0,
      ),
    [drafts],
  )
  const totalPercent = lockedPercent + editablePercent
  const overAllocated = totalPercent > SPLITS_TOTAL_PERCENT
  const rowsValid = drafts.every(s => splitOk(s, 'percent'))
  const clearsGroup = drafts.length === 0 && lockedRows.length === 0
  const clearBlocked = clearsGroup ? clearBlockReason(fallback) : null

  const close = () => {
    setOpen(false)
    setDrafts([])
    setLockedRows([])
    setBaseline(null)
    setFlowError(null)
    setStatus(null)
    setSuccess(false)
    setPlan(null)
    initialized.current = false
    initialFallback.current = null
    setLockSnapshotAt(null)
    setSelectedChains(new Set([chainId]))
  }

  const review = async () => {
    if (busy || !publicClient || !address) return
    setFlowError(null)
    if (!rowsValid || overAllocated || multiBlocked || projectScope.error) {
      setFlowError(projectScope.error ?? multiBlocked ?? (overAllocated ? 'The shares add up to more than 100%.' : 'Fix the highlighted recipients before saving.'))
      return
    }
    setBusy(true)
    try {
      const chosen = projectChains.filter(([id]) => selectedChains.has(id))
      if (chosen.length > 1 && !relayrSupportsChains(chosen.map(([id]) => id))) throw new Error('Choose supported chains from the same network family: all mainnets or all testnets.')
      for (const [id, pid] of chosen) {
        if (pendingSplitJournal(splitJournalKey(id, pid, groupId))) {
          onPending()
          throw new Error(`Resume the pending split update on ${chainName(id)} first.`)
        }
      }
      const snapshots = await Promise.all(chosen.map(([id, pid]) => readSplitDestination({ chainId: id, projectId: pid, groupId, account: address, ...(id === chainId ? { rulesetId } : {}) })))
      const home = snapshots.find(snapshot => snapshot.chainId === chainId)!
      if (!home || fingerprint(home.currentSplits) !== baseline || home.controller.toLowerCase() !== controller.toLowerCase() || home.authority.toLowerCase() !== authority.toLowerCase() || (initialFallback.current !== null && fingerprint(home.fallbackSplits) !== initialFallback.current)) {
        throw new Error('The authority, current ruleset, or splits changed while you were editing. Reopen to review the current recipients.')
      }
      // Rows presented as locked stay in this review even if their lock expires
      // while the form is open. Reopening permits explicitly editing them.
      const now = lockSnapshotAt ?? Math.floor(Date.now() / 1000)
      const destinations = snapshots.map(snapshot => {
        if (snapshots.length > 1) {
          if (!snapshot.relayable) throw new Error('Edit Safe accounts and different authorities separately.')
          const baselineSnapshot = destinationsQuery.data?.find(row => row.chainId === snapshot.chainId)?.snapshot
          if (!baselineSnapshot || splitSnapshotFingerprint(baselineSnapshot) !== splitSnapshotFingerprint(snapshot)) throw new Error(`The split settings changed on ${chainName(snapshot.chainId)}. Reopen to review the live recipients.`)
          return { ...snapshot, splits: assembleReservedDestination(snapshot, drafts, now) }
        }
        const assembled = assembleSplits(lockedRows, drafts, describeFallbackSplits(snapshot.fallbackSplits), snapshot.chainId)
        if ('error' in assembled) throw new Error(assembled.error)
        return { ...snapshot, splits: assembled.splits }
      })
      setPlan({ account: address, title, destinations })
    } catch (err) {
      setFlowError(err instanceof Error ? err.message : 'Could not review the split recipients.')
    } finally { setBusy(false) }
  }

  const submit = async () => {
    if (busy || !plan) return
    if (address?.toLowerCase() !== plan.account.toLowerCase()) {
      setPlan(null); setFlowError('Your connected account changed. Review these recipients again.'); return
    }
    setFlowError(null); setBusy(true); setStatus('Rechecking the split recipients…')
    const journal = { scope: relayrCallsScope(reviewedSplitCalls(plan)), review: plan }
    try {
      const result = await withSplitLocks(plan.destinations, async () => {
        for (const destination of plan.destinations) {
          if (pendingSplitJournal(splitJournalKey(destination.chainId, destination.projectId, destination.groupId))) throw new Error(`Resume the pending split update on ${chainName(destination.chainId)} first.`)
        }
        if (plan.destinations.length > 1) saveSplitJournal(journal)
        const result = await runAuthorityCalls({ calls: reviewedSplitCalls(plan), onProgress: progress => setStatus(progress.message) })
        clearSplitJournal(journal)
        return result
      })
      setStatus(safeOutcomeMessage(result, `${title} updated. This page picks it up in about a minute.`))
      setSuccess(true)
    } catch (err) {
      setFlowError(err instanceof Error ? err.message : 'Could not save the splits.')
      if (pendingSplitJournal(splitJournalKey(chainId, projectId, groupId))) onPending()
    } finally { setBusy(false) }
  }

  const reviewRows: TxConfirmRow[] = plan ? plan.destinations.flatMap(destination => {
    const allocated = destination.splits.reduce((total, split) => total + split.percent, 0)
    const previousAllocated = destination.currentSplits.reduce((total, split) => total + split.percent, 0)
    const recipientRows = (splits: readonly RawSplit[]) => splits.length ? splits.map(split => `${lockedRecipientLabel(split)} ${billionthsToPct(split.percent, 7)}%${split.lockedUntil > Math.floor(Date.now() / 1000) ? ' (locked)' : ''}`).join('; ') : 'None'
    return [
      { label: chainName(destination.chainId), value: `Project #${destination.projectId}, current ruleset ${destination.rulesetId}` },
      { label: 'Previous recipients', value: recipientRows(destination.currentSplits) },
      { label: 'New recipients', value: recipientRows(destination.splits) },
      { label: 'Owner remainder', value: `${billionthsToPct(SPLITS_TOTAL_PERCENT - previousAllocated, 7)}% → ${billionthsToPct(SPLITS_TOTAL_PERCENT - allocated, 7)}%` },
    ]
  }) : []

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="btn-secondary min-h-[36px] px-4 text-xs"
      >
        Edit {title}
      </button>
    )
  }

  return (
    <div className="mt-3 rounded-xl border border-smoke-200 p-4">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium text-ink">Edit {title}</span>
        <button
          onClick={close}
          disabled={busy}
          className="text-xs font-medium text-smoke-700 hover:text-ink disabled:opacity-50"
        >
          {success ? 'Done' : 'Cancel'}
        </button>
      </div>

      {success && !plan ? (
        <div className="mt-3">
          <p className="text-sm font-medium text-ink">
            {status}
          </p>
        </div>
      ) : isLoading || (!baseline && !isError) ? (
        <FormFieldsSkeleton rows={4} label="Loading split recipients" />
      ) : isError ? (
        <p className="mt-3 text-sm text-smoke-700">
          Couldn&apos;t load the current splits. Close and try again.
        </p>
      ) : (
        <div className="mt-3">
          {lockedRows.length > 0 ? (
            <div className="callout callout-warning mb-3 text-xs">
              <p className="font-medium">
                Locked recipients (kept as-is until their lock passes):
              </p>
              <ul className="mt-1.5 space-y-1">
                {lockedRows.map((s, i) => (
                  <li key={i} className="flex justify-between gap-3">
                    <span>{lockedRecipientLabel(s)}</span>
                    <span className="tabular-nums">
                      {billionthsToPct(s.percent, 6)}%
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-1.5 text-smoke-700">
                They take {billionthsToPct(lockedPercent, 6)}% — you can
                allocate the remaining{' '}
                {billionthsToPct(SPLITS_TOTAL_PERCENT - lockedPercent, 6)}%.
              </p>
            </div>
          ) : null}

          {projectScope.error ? <p className="mb-3 text-xs font-medium text-red-700">{projectScope.error}</p> : null}
          {isReserved && projectChains.length > 1 ? <fieldset className="mb-4 space-y-2">
            <legend className="field-label">Apply reserved recipients on</legend>
            {projectChains.map(([id]) => {
              const row = destinationsQuery.data?.find(item => item.chainId === id)
              const selected = selectedChains.has(id)
              const eligible = primaryRelayable && relayrSupportsChains(id === chainId ? [chainId] : [chainId, id]) && row?.snapshot?.relayable && addressOnlySplits(row.snapshot.currentSplits, lockSnapshotAt ?? Math.floor(Date.now() / 1000))
              return <label key={id} className="flex items-start gap-2 text-sm text-smoke-700">
                <input type="checkbox" className="mt-1" checked={selected} disabled={busy || plan !== null || id === chainId || (!eligible && !selected)} onChange={() => {
                  setSelectedChains(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next })
                  setPlan(null); setFlowError(null)
                }} />
                <span>{chainName(id)}{id === chainId ? ' (shown here)' : !row ? ' — checking…' : row.error ? ` — ${row.error}` : !eligible ? ' — edit this chain separately' : ''}</span>
              </label>
            })}
            <p className="text-xs text-smoke-600">The selected chains share the address recipients below. Choose all mainnets or all testnets; each chain keeps its own locked recipients. Project recipients, hooks, and Safe accounts are edited separately.</p>
          </fieldset> : <p className="mb-3 text-xs text-smoke-600">These recipients apply on {chainName(chainId)}. {isReserved ? '' : 'Payout token groups are edited separately on each chain.'}</p>}
          {multiBlocked ? <p className="mb-3 text-xs font-medium text-red-700">{multiBlocked}</p> : null}

          <SplitsEditor
            splits={drafts}
            onChange={next => {
              setDrafts(next)
              setPlan(null)
              setFlowError(null)
            }}
            disabled={busy || plan !== null}
            bucketLabel={isReserved ? 'reserved tokens' : 'payouts'}
            remainderNote="go to the project owner"
            chainIds={[chainId]}
            addLabel="Add a recipient"
            allowHook
            allowFundMarket={isReserved}
            showRouting={!isReserved}
            allowLock
          />

          {clearsGroup && clearBlocked ? (
            <p className="callout callout-warning mt-2 text-xs leading-relaxed">
              {clearBlocked}
            </p>
          ) : clearsGroup && isReserved ? (
            <p className="callout callout-info mt-2 text-xs leading-relaxed">
              {CLEARED_RESERVED_NOTE}
            </p>
          ) : null}

          {overAllocated ? (
            <p className="mt-2 text-xs font-medium text-red-600">
              Locked plus new shares add up to{' '}
              {billionthsToPct(totalPercent, 6)}% — over 100%.
            </p>
          ) : null}

          <button
            onClick={review}
            disabled={busy || !rowsValid || overAllocated || !!clearBlocked || !!multiBlocked || !!projectScope.error}
            className="btn-primary mt-3 min-h-[44px] w-full text-sm"
          >
            Save splits
          </button>

          {plan ? null : (
            <TxError
              error={flowError}
              className="mt-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700"
            />
          )}

          {plan || busy ? (
            <TxConfirmDialog
              open
              preparing={!plan}
              title={success ? 'Splits saved' : 'Confirm splits'}
              rows={reviewRows}
              steps={[{ title: `Edit ${title}` }]}
              activeIndex={busy ? 0 : -1}
              status={!plan ? 'Reading the live splits…' : status}
              error={flowError}
              busy={busy}
              complete={success}
              action={flowError ? 'Retry' : 'Confirm and save'}
              onConfirm={() => void submit()}
              onClose={() => {
                if (busy) return
                setPlan(null)
                setFlowError(null)
              }}
            />
          ) : null}
        </div>
      )}
    </div>
  )
}

function lockedRecipientLabel(s: RawSplit): string {
  if (s.hook !== zeroAddress) return `Hook ${truncateAddress(s.hook)}`
  if (s.projectId > 0n) return `Project #${s.projectId}`
  return truncateAddress(s.beneficiary)
}
