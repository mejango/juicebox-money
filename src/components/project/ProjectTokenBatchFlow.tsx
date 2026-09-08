'use client'

import { useQueryClient } from '@tanstack/react-query'
import type { JBChainId } from '@bananapus/nana-sdk-core'
import { useState } from 'react'
import { isAddressEqual, type Address } from 'viem'
import { ChainPicker } from '@/components/ui/ChainPicker'
import { TxConfirmDialog, type TxConfirmRow } from '@/components/ui/TxConfirmDialog'
import { TxError } from '@/components/ui/TxError'
import { useWallet } from '@/hooks/useWallet'
import { formatTokenAmount } from '@/lib/format'
import { chainName } from '@/lib/urn'
import { loadProjectBatch, projectBatchScope, runProjectBatch, type ProjectBatchCall } from '@/lib/project-batch'
import {
  readAutoIssueCalls, readAutoIssueAllocationCall, readClaimCalls, reverifyAutoIssueCall, reverifyClaimCall,
  type AutoIssueContext, type ClaimContext, type ProjectTokenDestination,
} from '@/lib/project-token-batch'

function reviewedCallsKey(calls: ProjectBatchCall[]): string {
  return JSON.stringify(calls.map(call => ({
    id: call.id, chainId: call.chainId, projectId: call.projectId,
    authority: call.authority.toLowerCase(), target: call.target.toLowerCase(),
    data: call.data.toLowerCase(), value: (call.value ?? 0n).toString(), context: call.context,
  })), (_key, value) => typeof value === 'bigint' ? value.toString() : value)
}

export function ClaimCreditsAcrossChains({ chains, holder, onDone }: {
  chains: readonly ProjectTokenDestination[]
  holder: Address
  onDone?: () => void
}) {
  return <ProjectTokenBatchFlow action="claim-credits" chains={chains} holder={holder} onDone={onDone} />
}

export function AutoIssueAcrossChains({ chains, onDone }: {
  chains: readonly ProjectTokenDestination[]
  onDone?: () => void
}) {
  return <ProjectTokenBatchFlow action="auto-issuance" chains={chains} onDone={onDone} />
}

export function AutoIssueAllocation({ chainId, projectId, stageId, beneficiary, onDone }: {
  chainId: JBChainId
  projectId: number
  stageId: string
  beneficiary: Address
  onDone?: () => void
}) {
  return <ProjectTokenBatchFlow action="auto-issuance" chains={[[chainId, projectId]]}
    allocation={{ stageId, beneficiary }} onDone={onDone} />
}

function ProjectTokenBatchFlow({ action, chains, holder, allocation, onDone }: {
  action: 'claim-credits' | 'auto-issuance'
  chains: readonly ProjectTokenDestination[]
  holder?: Address
  allocation?: { stageId: string; beneficiary: Address }
  onDone?: () => void
}) {
  const { address, openSignIn } = useWallet()
  const queryClient = useQueryClient()
  const scope = projectBatchScope(action, chains[0]?.[0] ?? 0, chains[0]?.[1] ?? 0)
  const [initial] = useState(() => {
    try { return { batch: loadProjectBatch(scope), error: null } }
    catch (failure) { return { batch: null, error: failure instanceof Error ? failure.message : 'Could not read the saved batch.' } }
  })
  const [review, setReview] = useState<ProjectBatchCall[] | null>(initial.batch?.calls ?? null)
  const [reviewBatchId, setReviewBatchId] = useState<string | undefined>(initial.batch?.id)
  const [open, setOpen] = useState(!!initial.batch && !allocation)
  const [selected, setSelected] = useState(() => new Set(chains.map(([chainId]) => chainId)))
  const [busy, setBusy] = useState(false)
  const [complete, setComplete] = useState(false)
  const [error, setError] = useState<string | null>(initial.error)
  const [status, setStatus] = useState<string | null>(null)
  const isClaim = action === 'claim-credits'
  const title = isClaim ? 'Claim credits as ERC-20' : allocation ? 'Distribute' : 'Distribute unlocked allocations'
  // Recovery read failures are surfaced by the handlers before any new review or write.
  let savedForDisplay = initial.batch
  try { savedForDisplay = loadProjectBatch(scope) } catch { /* Preserve the recovery warning. */ }

  const requireAccount = (): Address => {
    if (!address) throw new Error('Connect a wallet first.')
    if (holder && !isAddressEqual(holder, address)) throw new Error('Connect the holder’s wallet to claim these credits.')
    const saved = loadProjectBatch(scope)
    if (saved && !isAddressEqual(saved.account, address)) throw new Error('Connect the wallet that started this saved batch.')
    return address
  }

  const prepare = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    setStatus('Reading the selected chains…')
    try {
      const account = requireAccount()
      const saved = loadProjectBatch(scope)
      if (saved) { setReview(saved.calls); setReviewBatchId(saved.id); setStatus(null); return }
      const destinations = chains.filter(([chainId]) => selected.has(chainId))
      if (!destinations.length) throw new Error('Select at least one chain.')
      setReview(isClaim ? await readClaimCalls(destinations, holder!) : allocation
        ? [await readAutoIssueAllocationCall(destinations[0][0] as JBChainId, destinations[0][1], allocation.stageId, allocation.beneficiary, account)]
        : await readAutoIssueCalls(destinations, account))
      setReviewBatchId(undefined)
      setStatus(null)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not prepare the selected chains.')
    } finally { setBusy(false) }
  }

  const submit = async () => {
    if (!review || busy) return
    setBusy(true)
    setError(null)
    try {
      const account = requireAccount()
      const saved = loadProjectBatch(scope)
      if (saved && (reviewedCallsKey(review) !== reviewedCallsKey(saved.calls) ||
          (reviewBatchId && reviewBatchId !== saved.id))) {
        setReview(saved.calls)
        setReviewBatchId(saved.id)
        setStatus('A saved batch was found with different calls. Review its original amounts and recipients before continuing.')
        return
      }
      const result = await runProjectBatch({
        scope, action, account, title, calls: review,
        expectedBatchId: saved?.id ?? reviewBatchId,
        reverify: isClaim ? reverifyClaimCall : reverifyAutoIssueCall,
        onProgress: progress => setStatus(progress.message),
      })
      setReview(result.calls)
      setReviewBatchId(result.id)
      if (result.status === 'complete') {
        setComplete(true)
        setStatus(isClaim ? 'All selected credits are now ERC-20 tokens in the holder’s wallet.' : 'Every reviewed allocation has been distributed.')
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['yourPosition'] }),
          queryClient.invalidateQueries({ queryKey: ['autoIssueAmount'] }),
          queryClient.invalidateQueries({ queryKey: ['autoIssuancesAll'] }),
        ])
        onDone?.()
      } else setStatus('The original batch is saved. Resume it to verify and finish the remaining calls.')
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not finish the original batch.')
      try {
        if (!loadProjectBatch(scope)) {
          setReview(null)
          setReviewBatchId(undefined)
          setStatus(null)
        }
      } catch { /* Storage uncertainty keeps the original review bound to its journal. */ }
    } finally { setBusy(false) }
  }

  const confirmation: TxConfirmRow[] = (review ?? []).flatMap(call => {
    const context = call.context as ClaimContext | AutoIssueContext
    return [
      { label: `${chainName(call.chainId)} · Project ${call.projectId}`, value: `${formatTokenAmount(BigInt(context.amount))} ${context.symbol}`, strong: true },
      { label: 'To', value: context.kind === 'claim-credits' ? context.holder : context.beneficiary, mono: true },
      ...(context.kind === 'auto-issuance' ? [{ label: 'Stage', value: context.stageId }] : []),
      { label: 'Token', value: context.token ?? 'Project credits', mono: true },
    ]
  })

  if (!chains.length) return null
  return (
    <div className={allocation ? 'text-right' : 'mt-3'}>
      <button type="button" disabled={busy} className={allocation
        ? 'text-xs font-medium text-bluebs-600 hover:text-bluebs-700 disabled:opacity-50'
        : 'btn-secondary min-h-[40px] px-4 text-sm'} onClick={() => {
        if (!address) { openSignIn(); return }
        try {
          const saved = loadProjectBatch(scope)
          if (saved) { setReview(saved.calls); setReviewBatchId(saved.id) }
          setComplete(false)
          setOpen(true)
          if (allocation && !saved) void prepare()
        } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not read the saved batch.') }
      }}>
        {savedForDisplay ? 'Resume saved batch' : title}
      </button>
      {!open ? <TxError error={error} className="mt-2 text-xs text-red-700" /> : null}
      {open ? <TxConfirmDialog
        open title={complete ? 'Completed' : review ? `Confirm ${isClaim ? 'claims' : allocation && review.length === 1 ? 'distribution' : 'auto issuance'}` : title}
        rows={confirmation}
        steps={(review ?? []).map(call => ({ key: call.id, title: `${chainName(call.chainId)} · ${call.label}` }))}
        activeIndex={busy ? 0 : -1} busy={busy} complete={complete} status={status} error={error}
        action={review ? error || savedForDisplay ? 'Resume original batch' : isClaim ? 'Confirm claims' : 'Confirm & distribute' : allocation ? 'Review allocation' : 'Review selected chains'}
        onConfirm={() => void (review ? submit() : prepare())}
        onClose={() => {
          if (busy) return
          setOpen(false)
          try {
            if (!loadProjectBatch(scope)) { setReview(null); setReviewBatchId(undefined) }
          } catch { /* Keep the original review recoverable. */ }
        }}
      >
        {!review && !allocation ? <ChainPicker label="Apply on" rows={chains.map(([chainId, projectId]) => ({ chainId, name: `${chainName(chainId)} · Project ${projectId}` }))}
          selected={selected} onChange={setSelected} disabled={busy} /> : null}
        <p className="mt-3 text-sm text-smoke-700">
          {isClaim ? 'Each selected chain contributes its live claimable credits. The tokens stay with the same holder.'
            : allocation && !savedForDisplay ? 'Distributes this stage’s unlocked allocation to its original beneficiary.'
              : 'Includes every unlocked stage and beneficiary allocation on the selected chains. Recipients remain unchanged.'}
        </p>
      </TxConfirmDialog> : null}
    </div>
  )
}
