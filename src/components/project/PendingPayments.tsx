'use client'

import { type JBChainId } from '@bananapus/nana-sdk-core'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { formatUnits, isAddressEqual, type Address } from 'viem'
import { TxConfirmDialog, type TxConfirmRow } from '@/components/ui/TxConfirmDialog'
import { useWallet } from '@/hooks/useWallet'
import { chainName } from '@/lib/urn'
import { truncateAddress } from '@/lib/format'
import { fetchPendingPayments, pendingPaymentCall, pendingPaymentId, pendingPaymentOutcome, reconcilePendingPayment, reviewPendingPayment, reverifyPendingPayment, type ReviewedPayment } from '@/lib/pending-payments'
import { loadProjectBatch, projectBatchScope, runProjectBatch, type ProjectBatch, type ProjectBatchCall } from '@/lib/project-batch'

const ACTION = 'route-pending-payments'
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
  const queryClient = useQueryClient()
  const hydrated = useSyncExternalStore(subscribeHydration, clientHydrated, serverHydrated)
  const scope = projectBatchScope(ACTION, chainId, projectId)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [complete, setComplete] = useState(false)
  const [calls, setCalls] = useState<ProjectBatchCall[] | null>(null)
  const [account, setAccount] = useState<Address | null>(null)
  const [saved, setSaved] = useState<ProjectBatch | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [outcomes, setOutcomes] = useState<Record<string, string>>({})
  useEffect(() => {
    try { setSaved(loadProjectBatch(scope)) }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not read saved payment actions.') }
  }, [scope])

  const pending = useQuery({
    queryKey: ['pendingPayments', chainId, projectId, chains],
    enabled: hydrated,
    staleTime: 15_000, refetchInterval: 30_000, retry: 1,
    queryFn: async () => {
      const deployments = new Map<number, number>([[chainId, projectId]])
      for (const [chain, project] of chains) {
        if (deployments.has(chain) && deployments.get(chain) !== project) throw new Error('Conflicting project deployments. Reload the project.')
        deployments.set(chain, project)
      }
      const payments = (await Promise.all([...deployments].map(([chain, project]) => fetchPendingPayments(chain as JBChainId, project)))).flat()
      const reviewed = await Promise.all(payments.map(async payment => {
        try { return { payment, review: await reviewPendingPayment(payment), error: null } }
        catch (failure) { return { payment, review: null, error: failure instanceof Error ? failure.message : 'Could not verify this payment.' } }
      }))
      return reviewed.filter(item => item.review || item.error)
    },
  })
  const rows = pending.data ?? []
  const available = rows.flatMap(item => item.review?.ready ? [item.review] : [])
  const unreadable = !!pending.error || rows.some(item => item.error)

  const begin = (payments: ReviewedPayment[]) => {
    if (!isConnected || !address) { openSignIn(); return }
    try {
      const journal = loadProjectBatch(scope)
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
    setBusy(true); setError(null)
    try {
      const result = await runProjectBatch({ scope, action: ACTION, account: address, calls, expectedBatchId: saved?.id,
        title: 'Route pending payments', reverify: reverifyPendingPayment, acceptRevertedTransactions: true,
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
        onProgress: progress => { setStatus(progress.message); setSaved(loadProjectBatch(scope)) },
      })
      setSaved(result.status === 'pending' ? result : null)
      setComplete(result.status === 'complete')
      setStatus(result.status === 'complete' ? 'The reviewed batch is finished. Each payment’s outcome is shown below.' : 'The original action is saved. Resume it to check its execution before trying again.')
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not finish the reviewed payments.')
      setSaved(loadProjectBatch(scope))
    } finally {
      setBusy(false)
      await queryClient.invalidateQueries({ queryKey: ['pendingPayments'] })
    }
  }

  if (!hydrated) return null
  if (!rows.length && !saved && !open) {
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
      <button type="button" className="btn-secondary min-h-[40px] px-3 text-sm" disabled={busy || (!saved && (unreadable || !available.length))} onClick={() => begin(available)}>
        {saved ? 'Resume saved attempts' : available.length === rows.length ? 'Batch all pending' : `Batch ${available.length} available`}
      </button>
    </div>
    <p className="mt-2 text-sm text-smoke-500">These payments are held by the routing gateway. Anyone can retry them; only network fees come from your wallet.</p>
    {unreadable ? <p className="mt-2 text-sm text-red-600">Some payments could not be verified. Refresh before batching all pending payments.</p> : null}
    <ul className="mt-3 divide-y divide-smoke-200">
      {rows.map(item => <li key={pendingPaymentId(item.payment)} className="flex flex-wrap items-center justify-between gap-3 py-3">
        <div className="min-w-0 text-sm">
          <p className="font-medium">{item.review ? amountLabel(item.review) : `${item.payment.amount} base units of ${truncateAddress(item.payment.token)}`}</p>
          <p className="text-smoke-500">{chainName(item.payment.chainId)} · project #{item.payment.sourceProjectId} → #{item.payment.projectId}</p>
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
      stepsIntro="Each payment is a separate transaction or Safe proposal. The batch saves progress across chains; it does not make them atomic."
      activeIndex={busy ? 0 : -1} busy={busy} complete={complete} status={status} error={error}
      action={saved ? 'Resume original attempts' : 'Confirm attempts'} actionDisabled={!calls?.length}
      onConfirm={() => void submit()} onClose={() => { if (!busy) setOpen(false) }} />
  </section>
}
