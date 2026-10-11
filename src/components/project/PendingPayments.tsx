'use client'

import { transactionMessage } from '@/lib/transaction-message'
import { type JBChainId } from '@bananapus/nana-sdk-core'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { formatUnits, isAddressEqual, type Address } from 'viem'
import { TxConfirmDialog, type TxConfirmRow } from '@/components/ui/TxConfirmDialog'
import { useRelayrDiscard } from '@/components/RelayrDiscard'
import { useUnmountSignal } from '@/hooks/useUnmountSignal'
import { useWallet } from '@/hooks/useWallet'
import { chainName } from '@/lib/urn'
import { getProjectsByRefs } from '@/lib/bendystraw'
import { fillIndexedMetadata } from '@/lib/project-metadata-fill'
import { LoadingText } from '@/components/ui/LoadingText'
import { mapConcurrentChecks } from '@/lib/concurrent-checks'
import { fetchPendingPayments, loadPendingPaymentBatch, PENDING_PAYMENT_ACTION, pendingPaymentCall, pendingPaymentId, pendingPaymentOutcome, reconcilePendingPayment, reviewPendingPayment, reverifyPendingPayment, type ReviewedPayment } from '@/lib/pending-payments'
import { isProjectBatchDraft, loadProjectBatch, projectBatchRecoveryReason, recheckProjectBatch, projectBatchScope, runProjectBatch, type ProjectBatch, type ProjectBatchCall } from '@/lib/project-batch'

const subscribeHydration = () => () => {}
const clientHydrated = () => true
const serverHydrated = () => false
const amountLabel = ({ payment, decimals, symbol }: ReviewedPayment) => decimals === null
  ? 'Amount unavailable'
  : `${formatUnits(BigInt(payment.amount), decimals)} ${symbol}`

export function PendingPayments({ chainId, projectId, chains }: {
  chainId: JBChainId; projectId: number; chains: readonly (readonly [number, number])[]
}) {
  const { address, isConnected, openSignIn } = useWallet()
  // Leaving ends the batch's wait for a Safe to execute a call; the call stays submitted.
  const flowSignal = useUnmountSignal()
  const queryClient = useQueryClient()
  const hydrated = useSyncExternalStore(subscribeHydration, clientHydrated, serverHydrated)
  const scope = projectBatchScope(PENDING_PAYMENT_ACTION, chainId, projectId)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [complete, setComplete] = useState(false)
  const [calls, setCalls] = useState<ProjectBatchCall[] | null>(null)
  const [account, setAccount] = useState<Address | null>(null)
  const [saved, setSaved] = useState<ProjectBatch | null>(null)
  const [savedSelection, setSavedSelection] = useState<ProjectBatch | null>(null)
  const [needsReview, setNeedsReview] = useState(false)
  const [replaceDraft, setReplaceDraft] = useState<{ scope: string; id: string } | undefined>()
  const recovery = saved && !isProjectBatchDraft(saved) ? saved : null
  const [error, setError] = useState<string | null>(null)
  // Discard abandons the saved batch, so the payments are reviewed again from live state (ruling R114 (f)).
  const discard = useRelayrDiscard(() => setError(null), () => { setOpen(false); setCalls(null); setSaved(null) })
  const [status, setStatus] = useState<string | null>(null)
  const [outcomes, setOutcomes] = useState<Record<string, string>>({})
  useEffect(() => {
    try { setSaved(loadPendingPaymentBatch([[chainId, projectId], ...chains])) }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not read saved payment actions.') }
  }, [chainId, projectId, chains])

  const pending = useQuery({
    queryKey: ['pendingPayments', 'destination-inventory', chainId, projectId, chains],
    enabled: hydrated,
    staleTime: 15_000, refetchInterval: 30_000, retry: 1,
    queryFn: async ({ signal }) => {
      const deployments = new Map<number, number>([[chainId, projectId]])
      for (const [chain, project] of chains) {
        if (deployments.has(chain) && deployments.get(chain) !== project) throw new Error('Conflicting project deployments. Reload the project.')
        deployments.set(chain, project)
      }
      return (await mapConcurrentChecks([...deployments], ([chain, project]) => fetchPendingPayments(chain as JBChainId, project, { signal }))).flat()
    },
  })
  const verification = useQuery({
    queryKey: ['pendingPayments', 'verification', chainId, projectId, chains, pending.data],
    enabled: hydrated && !!pending.data?.length,
    staleTime: 15_000, refetchInterval: 30_000, retry: 1,
    queryFn: async () => {
      return mapConcurrentChecks(pending.data ?? [], async payment => {
        try { return { payment, review: await reviewPendingPayment(payment), error: null } }
        catch (failure) { return { payment, review: null, error: failure instanceof Error ? failure.message : 'Could not verify this payment.' } }
      })
    },
  })
  const verified = new Map((verification.data ?? []).map(item => [pendingPaymentId(item.payment), item]))
  const rows = (pending.data ?? []).flatMap(payment => {
    const item = verified.get(pendingPaymentId(payment))
    // A null live review means another attempt has already resolved this indexed payment.
    return item ? item.review || item.error ? [item] : [] : [{ payment, review: null, error: null }]
  })
  const checking = rows.some(item => !verified.has(pendingPaymentId(item.payment)))
  const available = rows.flatMap(item => item.review?.ready ? [item.review] : [])
  const unreadable = !!pending.error || !!verification.error || rows.some(item => item.error)
  const projectRefs = [...new Map([
    ...rows.map(item => item.payment),
    ...(calls ?? []).flatMap(call => {
      const payment = (call.context as ReviewedPayment | undefined)?.payment
      return payment ? [payment] : []
    }),
  ].flatMap(payment => [payment.sourceProjectId, payment.projectId].map(id => ({ chainId: payment.chainId, projectId: id, version: payment.version })))
    .map(ref => [`${ref.chainId}:${ref.projectId}:${ref.version}`, ref])).values()]
  const projectNames = useQuery({
    queryKey: ['pendingPaymentProjectNames', projectRefs],
    enabled: hydrated && !!projectRefs.length,
    staleTime: 60_000, retry: 1,
    queryFn: async ({ signal }) => fillIndexedMetadata(await getProjectsByRefs(projectRefs, { signal })),
  })
  const projectLabel = (payment: ReviewedPayment['payment'], id: number) =>
    projectNames.data?.find(project => project.chainId === payment.chainId && project.projectId === id && project.version === payment.version)?.name?.trim() || `Project ${id}`

  const recheckSaved = async () => {
    if (!recovery || busy) return
    setBusy(true); setError(null)
    try {
      const released = await recheckProjectBatch(recovery.scope, recovery.id)
      setSaved(loadPendingPaymentBatch([[chainId, projectId], ...chains]))
      setStatus(released ? 'The old quote expired without funding. Review all available payments in a new batch.' : 'The saved batch still needs recovery. Resume it to check its original attempts.')
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not check saved batch.') }
    finally { setBusy(false) }
  }

  const begin = (payments: ReviewedPayment[]) => {
    if (!isConnected || !address) { openSignIn(); return }
    try {
      const found = loadPendingPaymentBatch([[chainId, projectId], ...chains])
      const journal = found && !isProjectBatchDraft(found) ? found : null
      setReplaceDraft(found && !journal ? { scope: found.scope, id: found.id } : undefined)
      setSaved(found)
      setSavedSelection(journal); setNeedsReview(false)
      setCalls(journal?.calls ?? payments.map(payment => pendingPaymentCall(payment, address)))
      setAccount(journal?.account ?? address)
      setOpen(true); setComplete(false); setError(null); setStatus(null)
      setOutcomes(Object.fromEntries((journal?.completedIds ?? []).map(id => [id, 'Previously handled in this saved batch. The refreshed pending list shows whether routing is still needed.'])))
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not review pending payments.') }
  }
  const submit = async () => {
    if (!address || !calls?.length || busy || needsReview) return
    if (!account || !isAddressEqual(account, address)) { setError('Reconnect the wallet that reviewed these payments.'); return }
    let recovered = false
    const recover = (batch: ProjectBatch | null) => {
      if (!batch || batch.status !== 'pending' || !batch.account || isProjectBatchDraft(batch) ||
          !isAddressEqual(batch.account, address) || (savedSelection && batch.id !== savedSelection.id)) return
      setSavedSelection(batch); setCalls(batch.calls); setSaved(batch)
      setNeedsReview(false); recovered = true
    }
    setBusy(true); setError(null); discard.capture(null)
    try {
      const result = await runProjectBatch({ scope: savedSelection?.scope ?? scope, action: savedSelection?.action ?? PENDING_PAYMENT_ACTION, account: address, calls, expectedBatchId: savedSelection?.id, replaceDraft,
        title: 'Retry payments', reverify: reverifyPendingPayment, acceptRevertedTransactions: true, signal: flowSignal(),
        reconcileUnsubmitted: async call => {
          const outcome = await reconcilePendingPayment(call)
          if (outcome) setOutcomes(previous => ({ ...previous, [call.id]: outcome }))
          return outcome !== null
        },
        reconcileObsoleteSafe: async (call, proposal) => {
          if (await reviewPendingPayment((call.context as ReviewedPayment).payment)) return false
          setOutcomes(previous => ({ ...previous, [call.id]: `Payment resolved elsewhere; this Safe proposal is obsolete, not executed. Cancel nonce ${proposal.nonce} in Safe if it blocks the queue. Proposal: ${proposal.safeTxHash ?? proposal.contractTransactionHash}.` }))
          return true
        },
        verifyCompletion: async (call, receipt) => {
          if (receipt.status === 'reverted') {
            setOutcomes(previous => ({ ...previous, [call.id]: 'This attempt reverted. The refreshed pending list shows whether another attempt is needed.' }))
            return
          }
          const outcome = pendingPaymentOutcome(call, receipt)
          setOutcomes(previous => ({ ...previous, [call.id]: outcome === 'routed' ? 'Payment routed.' : outcome === 'returned' ? 'Payment returned to its source project.' : 'Attempt confirmed; payment is still awaiting routing.' }))
        },
        onProgress: progress => { setStatus(progress.message); setSaved(loadPendingPaymentBatch([[chainId, projectId], ...chains])) },
      })
      setSaved(result.status === 'pending' ? result : loadPendingPaymentBatch([[chainId, projectId], ...chains]))
      if (result.status === 'pending') recover(result)
      setComplete(result.status === 'complete')
      setStatus(result.status === 'complete' ? 'The reviewed batch is finished. Each payment’s outcome is shown below.' : 'The original action is saved. Resume it to check its execution before trying again.')
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not finish the reviewed payments.')
      discard.capture(failure)
      setSaved(loadPendingPaymentBatch([[chainId, projectId], ...chains]))
      recover(loadProjectBatch(savedSelection?.scope ?? scope))
    } finally {
      // Replacement consumes the old draft identity. Reopen to bind any new recovery journal.
      if (replaceDraft) { if (!recovered) setNeedsReview(true); setReplaceDraft(undefined) }
      setBusy(false)
      await queryClient.invalidateQueries({ queryKey: ['pendingPayments'] })
    }
  }

  if (!hydrated) return null
  if (!rows.length && !recovery && !open) {
    if (pending.isPending) return <p className="mb-5 text-sm text-smoke-500" role="status"><LoadingText text="Loading pending payments…" /></p>
    return pending.error || error ? <p className="mb-5 text-sm text-smoke-500" role="status">Pending payments could not be loaded. <button type="button" className="underline" onClick={() => void pending.refetch()}>Retry</button></p> : null
  }
  const reviewedRows: TxConfirmRow[] = (calls ?? []).flatMap(call => {
    const reviewed = call.context as ReviewedPayment
    const payment = reviewed.payment
    return [
      { label: 'Amount', value: amountLabel(reviewed), strong: true },
      { label: 'On', value: chainName(payment.chainId) },
      { label: 'To', value: projectLabel(payment, payment.projectId) },
      { label: 'Source', value: projectLabel(payment, payment.sourceProjectId) },
      { label: 'Action', value: 'Retry payments' },
      ...(payment.memo ? [{ label: 'Memo', value: payment.memo }] : []),
      ...(outcomes[call.id] ? [{ label: 'Outcome', value: outcomes[call.id], strong: true }] : []),
    ]
  })
  return <section className="mb-6 rounded-xl border border-smoke-200 p-4" aria-label="Payments awaiting processing">
    <details>
      <summary className="cursor-pointer text-sm font-medium">{rows.length ? `${rows.length} ${rows.length === 1 ? 'payment' : 'payments'} awaiting processing.` : 'Saved payment batch'}</summary>
      <p className="mt-3 text-sm text-smoke-500">These payments did not have sufficient gas to process automatically.</p>
      {recovery ? <p className="mt-2 text-sm text-smoke-500">Saved batch: {recovery.completedIds.length} of {recovery.calls.length} attempts handled. {projectBatchRecoveryReason(recovery)}</p> : null}
      {recovery ? <button type="button" className="mt-2 text-sm underline" disabled={busy} onClick={() => void recheckSaved()}>Re-check saved batch</button> : null}
      {status && !open ? <p className="mt-2 text-sm text-smoke-500" role="status"><LoadingText text={transactionMessage(status)} /></p> : null}
      <p className="mt-2 text-sm text-smoke-500" role="status"><LoadingText text={pending.isPending ? 'Loading pending payments…' : pending.error ? 'Payment count unavailable.' : checking ? verification.error ? 'Payment status unavailable.' : 'Checking payments…' : `${available.length} ${available.length === 1 ? 'payment' : 'payments'} ready to retry`} /></p>
      {recovery || rows.length > 1 ? <button type="button" className="btn-secondary mt-3 min-h-[40px] px-3 text-sm" disabled={busy || (!recovery && (unreadable || checking || !available.length))} onClick={() => begin(available)}>
        {recovery ? 'Resume saved batch' : 'Retry'}
      </button> : null}
      {pending.error ? <p className="mt-2 text-sm text-red-600">Pending payments could not be loaded. <button type="button" className="underline" onClick={() => void queryClient.invalidateQueries({ queryKey: ['pendingPayments'] })}>Retry</button></p> : null}
      {unreadable ? <p className="mt-2 text-sm text-red-600">Some payments could not be checked. <button type="button" className="underline" onClick={() => void queryClient.invalidateQueries({ queryKey: ['pendingPayments'] })}>Retry checks</button></p> : null}
      <ul className="mt-3 divide-y divide-smoke-200">
        {rows.map(item => <li key={pendingPaymentId(item.payment)} className="flex flex-wrap items-center justify-between gap-3 py-3">
          <div className="min-w-0 text-sm">
            <p className="font-medium">{item.review ? amountLabel(item.review) : <LoadingText text={item.error || verification.error ? 'Amount unavailable' : 'Checking payment amount…'} />}</p>
            <p className="text-smoke-500">To {projectLabel(item.payment, item.payment.projectId)} on {chainName(item.payment.chainId)}</p>
            {!verified.has(pendingPaymentId(item.payment)) ? <p className="mt-1 text-smoke-500"><LoadingText text={verification.error ? 'Could not check this payment.' : 'Checking payment status…'} /></p> : null}
            {item.error ? <p className="mt-1 text-red-600">{transactionMessage(item.error)}</p> : item.review && !item.review.ready ? <p className="mt-1 text-smoke-500">Available {new Date(Number(item.review.readyAt) * 1_000).toLocaleString()}</p> : null}
          </div>
          <button type="button" className="btn-secondary min-h-[40px] px-3 text-sm" disabled={busy || !item.review?.ready} onClick={() => item.review && begin([item.review])}>
            Retry
          </button>
        </li>)}
      </ul>
      {error && !open ? <p className="mt-2 text-sm text-red-600">{transactionMessage(error)}</p> : null}
    </details>
    <TxConfirmDialog open={open} title={complete ? 'Payments finished' : 'Retry payments'} rows={reviewedRows}
      steps={(calls ?? []).map(call => ({ key: call.id, title: `${chainName(call.chainId)}: ${call.label}` }))}
      stepsIntro="Retry the original payments. You pay network fees only. Payments may remain pending; a final failed attempt may return them to the source project."
      activeIndex={busy ? 0 : -1} busy={busy} complete={complete} status={needsReview && !complete ? 'Close this review and reopen pending payments to review the current batch.' : status} error={discard.active ? null : error}
      action={savedSelection ? 'Resume saved batch' : 'Retry'} actionDisabled={needsReview || !calls?.length || discard.active}
      onConfirm={() => void submit()} onClose={() => { if (!busy) { setOpen(false); discard.reset() } }}>{discard.element}</TxConfirmDialog>
  </section>
}
