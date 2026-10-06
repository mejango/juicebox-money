'use client'

import { type JBChainId } from '@bananapus/nana-sdk-core'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { formatUnits, isAddressEqual, type Address } from 'viem'
import { TxConfirmDialog, type TxConfirmRow } from '@/components/ui/TxConfirmDialog'
import { useRelayrDiscard } from '@/components/RelayrDiscard'
import { useUnmountSignal } from '@/hooks/useUnmountSignal'
import { useWallet } from '@/hooks/useWallet'
import { chainName } from '@/lib/urn'
import { truncateAddress } from '@/lib/format'
import { mapConcurrentChecks } from '@/lib/concurrent-checks'
import { fetchPendingPayments, loadPendingPaymentBatch, PENDING_PAYMENT_ACTION, pendingPaymentCall, pendingPaymentId, pendingPaymentOutcome, reconcilePendingPayment, reviewPendingPayment, reverifyPendingPayment, type ReviewedPayment } from '@/lib/pending-payments'
import { projectBatchScope, runProjectBatch, type ProjectBatch, type ProjectBatchCall } from '@/lib/project-batch'

const subscribeHydration = () => () => {}
const clientHydrated = () => true
const serverHydrated = () => false
const amountLabel = ({ payment, decimals, symbol }: ReviewedPayment) => decimals === null
  ? `${payment.amount} base units (${symbol})`
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

  const begin = (payments: ReviewedPayment[]) => {
    if (!isConnected || !address) { openSignIn(); return }
    try {
      const journal = loadPendingPaymentBatch([[chainId, projectId], ...chains])
      setSaved(journal)
      setCalls(journal?.calls ?? payments.map(payment => pendingPaymentCall(payment, address)))
      setAccount(journal?.account ?? address)
      setOpen(true); setComplete(false); setError(null); setStatus(null)
      setOutcomes(Object.fromEntries((journal?.completedIds ?? []).map(id => [id, 'Previously handled in this saved batch. The refreshed pending list shows whether routing is still needed.'])))
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not review pending payments.') }
  }
  const submit = async () => {
    if (!address || !calls?.length || busy) return
    if (!account || !isAddressEqual(account, address)) { setError('Reconnect the wallet that reviewed these payments.'); return }
    setBusy(true); setError(null); discard.capture(null)
    try {
      const result = await runProjectBatch({ scope: saved?.scope ?? scope, action: saved?.action ?? PENDING_PAYMENT_ACTION, account: address, calls, expectedBatchId: saved?.id,
        title: 'Route pending payments', reverify: reverifyPendingPayment, acceptRevertedTransactions: true, signal: flowSignal(),
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
      setComplete(result.status === 'complete')
      setStatus(result.status === 'complete' ? 'The reviewed batch is finished. Each payment’s outcome is shown below.' : 'The original action is saved. Resume it to check its execution before trying again.')
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not finish the reviewed payments.')
      discard.capture(failure)
      setSaved(loadPendingPaymentBatch([[chainId, projectId], ...chains]))
    } finally {
      setBusy(false)
      await queryClient.invalidateQueries({ queryKey: ['pendingPayments'] })
    }
  }

  if (!hydrated) return null
  if (!rows.length && !saved && !open) {
    if (pending.isPending) return <p className="mb-5 text-sm text-smoke-500" role="status">Loading pending payments…</p>
    return pending.error || error ? <p className="mb-5 text-sm text-smoke-500" role="status">Pending payments could not be loaded. <button type="button" className="underline" onClick={() => void pending.refetch()}>Retry</button></p> : null
  }
  const reviewedRows: TxConfirmRow[] = (calls ?? []).flatMap(call => {
    const reviewed = call.context as ReviewedPayment
    const payment = reviewed.payment
    return [
      { label: chainName(payment.chainId), value: amountLabel(reviewed), strong: true },
      { label: 'From project', value: `#${payment.sourceProjectId}` },
      { label: 'To project', value: `#${payment.projectId}` },
      { label: 'Gateway', value: payment.gateway, mono: true },
      { label: 'Payment ID', value: payment.pendingCallId, mono: true },
      { label: 'Token', value: payment.token, mono: true },
      { label: 'Beneficiary', value: payment.beneficiary, mono: true },
      { label: 'Action', value: reviewed.functionName === 'finalizePendingCall' ? 'Try routing once more; a matching failure returns the payment to its source project.' : 'Retry the original payment. It may remain pending if routing still fails.' },
      ...(payment.memo ? [{ label: 'Memo', value: payment.memo }] : []),
      ...(outcomes[call.id] ? [{ label: 'Outcome', value: outcomes[call.id], strong: true }] : []),
    ]
  })
  return <section className="mb-6 rounded-xl border border-smoke-200 p-4" aria-label="Payments awaiting routing">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="font-agrandir text-lg">Payments awaiting routing</h2>
      <button type="button" className="btn-secondary min-h-[40px] px-3 text-sm" disabled={busy || (!saved && (unreadable || checking || !available.length))} onClick={() => begin(available)}>
        {saved ? 'Resume saved batch' : checking && !verification.error ? 'Checking pending payments…' : available.length === rows.length ? 'Batch all pending' : `Batch ${available.length} available`}
      </button>
    </div>
    <p className="mt-2 text-sm text-smoke-500">These payments are held by the routing gateway. Anyone can retry them. Batch available payments through Relayr and pay the quoted fees once.</p>
    {saved ? <p className="mt-2 text-sm text-smoke-500">Saved batch: {saved.completedIds.length} of {saved.calls.length} attempts handled. This selection is separate from the full pending list. Finish it before starting another batch.</p> : null}
    <p className="mt-2 text-sm text-smoke-500" role="status">{pending.isPending ? 'Loading pending payments…' : pending.error ? 'Pending payment count unavailable.' : checking ? `Found ${rows.length} payments.${verification.error ? ' Current status unavailable.' : ' Checking current status…'}` : `${rows.length} payments awaiting routing · ${available.length} ready`}</p>
    {pending.error ? <p className="mt-2 text-sm text-red-600">Pending payments could not be loaded. <button type="button" className="underline" onClick={() => void queryClient.invalidateQueries({ queryKey: ['pendingPayments'] })}>Retry</button></p> : null}
    {unreadable ? <p className="mt-2 text-sm text-red-600">Some payments could not be verified. Refresh before batching all pending payments. <button type="button" className="underline" onClick={() => void queryClient.invalidateQueries({ queryKey: ['pendingPayments'] })}>Retry checks</button></p> : null}
    <ul className="mt-3 divide-y divide-smoke-200">
      {rows.map(item => <li key={pendingPaymentId(item.payment)} className="flex flex-wrap items-center justify-between gap-3 py-3">
        <div className="min-w-0 text-sm">
          <p className="font-medium">{item.review ? amountLabel(item.review) : `${item.payment.amount} base units of ${truncateAddress(item.payment.token)}`}</p>
          <p className="text-smoke-500">{chainName(item.payment.chainId)} · project #{item.payment.sourceProjectId} → #{item.payment.projectId}</p>
          {!verified.has(pendingPaymentId(item.payment)) ? <p className="mt-1 text-smoke-500">{verification.error ? 'Could not check this payment.' : 'Checking availability…'}</p> : null}
          {item.error ? <p className="mt-1 text-red-600">{item.error}</p> : item.review && !item.review.ready ? <p className="mt-1 text-smoke-500">Available {new Date(Number(item.review.readyAt) * 1_000).toLocaleString()}</p> : null}
        </div>
        <button type="button" className="btn-secondary min-h-[40px] px-3 text-sm" disabled={busy || !item.review?.ready} onClick={() => item.review && begin([item.review])}>
          {item.review?.functionName === 'finalizePendingCall' ? 'Route or return' : 'Retry payment'}
        </button>
      </li>)}
    </ul>
    {error && !open ? <p className="mt-2 text-sm text-red-600">{error}</p> : null}
    <TxConfirmDialog open={open} title={complete ? 'Payment batch finished' : 'Review pending payments'} rows={reviewedRows}
      steps={(calls ?? []).map(call => ({ key: call.id, title: `${chainName(call.chainId)} · ${call.label}` }))}
      stepsIntro="Relayr bundles available payments into one fee payment, including payments on the same chain. Each routing attempt has its own outcome; the batch does not make them atomic. Safe wallets and unsupported networks use separate transactions."
      activeIndex={busy ? 0 : -1} busy={busy} complete={complete} status={status} error={discard.active ? null : error}
      action={saved ? 'Resume original attempts' : 'Confirm attempts'} actionDisabled={!calls?.length || discard.active}
      onConfirm={() => void submit()} onClose={() => { if (!busy) { setOpen(false); discard.reset() } }}>{discard.element}</TxConfirmDialog>
  </section>
}
