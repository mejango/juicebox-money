'use client'

import {
  JBCoreContracts,
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
  type JBSplit,
} from '@bananapus/nana-sdk-core/v6'
import { useQuery } from '@tanstack/react-query'
import { FormFieldsSkeleton } from '@/components/LoadingSkeletons'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  zeroAddress,
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
import { TxConfirmDialog } from '@/components/ui/TxConfirmDialog'
import { TxError } from '@/components/ui/TxError'
import { useWallet } from '@/hooks/useWallet'
import { runAuthorityCalls } from '@/lib/authority'
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
  const value = billionthsToPct(sp.percent, 6)
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

/**
 * Edit one split group (reserved tokens, or a token's payouts) for a CUSTOM
 * project's current ruleset. Owner-gated button + modal that reuses the
 * create-flow SplitsEditor.
 *
 * Locked splits (a lockedUntil in the future) can't be removed or reduced, so
 * they're held OUT of the editable list — shown read-only and re-submitted
 * byte-for-byte — which is also what the JBSplits contract requires. Live
 * splits are fingerprinted at open and re-read at review: if they changed
 * onchain in the meantime the save is refused, since a stale prefill could
 * silently clear a recipient. setSplitGroupsOf goes to the project's resolved
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
}: {
  chainId: JBChainId
  projectId: number
  groupId: bigint
  title: string
  rulesetId: bigint
  isRevnet?: boolean
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
}: {
  chainId: JBChainId
  projectId: number
  groupId: bigint
  title: string
  rulesetId: bigint
  controller: Address
  authority: Address
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
  const [plan, setPlan] = useState<JBSplit[] | null>(null)
  const initialized = useRef(false)

  const splitsAddr = jbContractAddress['6'][JBCoreContracts.JBSplits][
    chainId
  ] as Address
  const isReserved = groupId === RESERVED_TOKEN_SPLIT_GROUP_ID

  const {
    data: live,
    isLoading,
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

  // Initialize the editor once, from the freshly loaded live splits, and
  // capture the fingerprint that the submit-time re-read is checked against.
  useEffect(() => {
    if (!open || !live || initialized.current) return
    const now = Math.floor(Date.now() / 1000)
    setLockedRows(live.filter(s => s.lockedUntil > now).map(s => ({ ...s })))
    setDrafts(live.filter(s => s.lockedUntil <= now).map(splitToDraft))
    setBaseline(fingerprint(live))
    initialized.current = true
  }, [open, live])

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
  }

  const review = async () => {
    if (busy || !publicClient) return
    setFlowError(null)
    if (!rowsValid) {
      setFlowError('Fix the highlighted recipients before saving.')
      return
    }
    if (overAllocated) {
      setFlowError('The shares add up to more than 100%.')
      return
    }

    setBusy(true)
    try {
      // Fingerprint recheck: a stale prefill could clear a recipient that
      // changed onchain while the modal was open.
      let fresh: readonly RawSplit[]
      try {
        fresh = (await publicClient.readContract({
          address: splitsAddr,
          abi: jbSplitsAbi,
          functionName: 'splitsOf',
          args: [BigInt(projectId), rulesetId, groupId],
        })) as readonly RawSplit[]
      } catch {
        setFlowError('Couldn’t re-check the current splits. Try again.')
        return
      }
      if (baseline !== null && fingerprint(fresh) !== baseline) {
        setFlowError(
          'Splits changed onchain while you were editing — reopen to start from the current splits.',
        )
        return
      }

      // Re-read the fallback too: an empty save is only safe against the
      // ruleset-0 group as it stands at send time. A failed read stays
      // `unknown`, which blocks the clear but leaves other saves alone.
      let freshFallback: FallbackSplits = { status: 'unknown' }
      if (rulesetId === FALLBACK_RULESET_ID) {
        freshFallback = { status: 'empty' }
      } else {
        try {
          freshFallback = describeFallbackSplits(
            (await publicClient.readContract({
              address: splitsAddr,
              abi: jbSplitsAbi,
              functionName: 'splitsOf',
              args: [BigInt(projectId), FALLBACK_RULESET_ID, groupId],
            })) as readonly RawSplit[],
          )
        } catch {
          freshFallback = { status: 'unknown' }
        }
      }

      const assembled = assembleSplits(
        lockedRows,
        drafts,
        freshFallback,
        chainId,
      )
      if ('error' in assembled) {
        setFlowError(assembled.error)
        return
      }
      setPlan(assembled.splits)
    } finally {
      setBusy(false)
    }
  }

  const submit = async () => {
    if (busy || !plan) return
    setFlowError(null)
    const splits = plan

    const call = buildSplitGroupsAuthorityCall({
      chainId,
      authority,
      controller,
      projectId: BigInt(projectId),
      rulesetId,
      splitGroups: [{ groupId, splits }],
      label: `Edit ${title}`,
    })
    setBusy(true)
    setStatus('Reviewing the split replacement…')
    try {
      const result = await runAuthorityCalls({
        calls: [call],
        onProgress: progress => setStatus(progress.message),
      })
      const queued = result.safeResults.filter(row => row.status === 'queued')
        .length
      const waiting = result.safeResults.filter(row => row.status === 'waiting')
        .length
      setStatus(
        queued || waiting
          ? `Safe action recorded${queued ? '; queued for co-signing' : ''}${
              waiting ? '; waiting for more onchain approvals' : ''
            }.`
          : `${title} updated. This page picks it up in about a minute.`,
      )
      setSuccess(true)
    } catch (submitError) {
      setFlowError(
        submitError instanceof Error
          ? submitError.message
          : 'Could not save the splits.',
      )
    } finally {
      setBusy(false)
    }
  }

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

          <SplitsEditor
            splits={drafts}
            onChange={next => {
              setDrafts(next)
              setFlowError(null)
            }}
            disabled={busy}
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
            disabled={busy || !rowsValid || overAllocated || !!clearBlocked}
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
              rows={
                plan
                  ? [
                      { label: 'Group', value: title },
                      {
                        label: 'Recipients',
                        value:
                          live && live.length !== plan.length
                            ? `${live.length} → ${plan.length}`
                            : String(plan.length),
                      },
                      {
                        label: 'Allocated',
                        value: `${billionthsToPct(totalPercent, 6)}% (${billionthsToPct(SPLITS_TOTAL_PERCENT - totalPercent, 6)}% to the project owner)`,
                      },
                      { label: 'On', value: chainName(chainId) },
                    ]
                  : []
              }
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
