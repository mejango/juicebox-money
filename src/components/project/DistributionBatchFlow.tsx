'use client'

import { type JBChainId } from '@bananapus/nana-sdk-core'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { formatUnits, isAddressEqual, parseUnits, zeroAddress, type Address } from 'viem'
import { useWallet } from '@/hooks/useWallet'
import { TxConfirmDialog, type TxConfirmRow } from '@/components/ui/TxConfirmDialog'
import { TxError } from '@/components/ui/TxError'
import { chainName } from '@/lib/urn'
import { formatTokenAmount } from '@/lib/format'
import { distributionCall, distributionProjects, matchingPayoutToken, readPayoutOptions, reviewPayout, reviewReserved, reverifyDistribution, verifyDistributionCompletion, type Distribution, type PayoutOptions } from '@/lib/project-distributions'
import { loadProjectBatch, projectBatchScope, runProjectBatch, type ProjectBatch, type ProjectBatchCall } from '@/lib/project-batch'

type Draft = { token: string; currency: string; amount: string }
const emptyDraft: Draft = { token: '', currency: '', amount: '' }

function distributionReviewRows(distributions: readonly Distribution[]): TxConfirmRow[] {
  return distributions.flatMap(item => {
    const amount = item.kind === 'payouts' ? item.quote : item.pending
    const decimals = item.kind === 'payouts' ? item.context.decimals : 18
    const recipientTotal = item.splits.reduce((sum, split) => sum + split.percent, 0)
    const allocated = item.splits.reduce((sum, split) => sum + amount * BigInt(split.percent) / 1_000_000_000n, 0n)
    return [
      { label: chainName(item.chainId), value: `Project #${item.projectId} · ${formatTokenAmount(amount, decimals)} ${item.symbol}`, strong: true },
      { label: 'Controller', value: item.controller, mono: true },
      ...(item.kind === 'payouts' ? [
        { label: 'Terminal', value: item.terminal, mono: true },
        { label: 'Accounting token', value: `${item.context.token} (${item.context.decimals} decimals)` },
        { label: 'Payout amount', value: `${formatUnits(item.amount, item.context.decimals)} ${payoutCurrency(item.currency, item.context.currency, item.symbol)}` },
        { label: 'Minimum distributed', value: `${formatTokenAmount(item.min, decimals)} ${item.symbol} before payout fees` },
      ] : []),
      ...item.splits.map(split => ({ label: !isAddressEqual(split.hook, zeroAddress) ? `Hook ${split.hook}` : split.projectId > 0n ? `Project #${split.projectId}` : isAddressEqual(split.beneficiary, zeroAddress) ? item.authority : split.beneficiary,
        value: `${formatTokenAmount(amount * BigInt(split.percent) / 1_000_000_000n, decimals)} ${item.symbol} (${split.percent / 10_000_000}%)${item.kind === 'payouts' ? ' before fees' : ''}` })),
      ...(recipientTotal < 1_000_000_000 || allocated < amount ? [{ label: `Owner ${item.owner}`, value: `${formatTokenAmount(amount - allocated, decimals)} ${item.symbol} remainder${item.kind === 'payouts' ? ' before fees' : ''}` }] : []),
    ]
  })
}

function payoutCurrency(currency: number, tokenCurrency: number, symbol: string) {
  return currency === tokenCurrency ? symbol : currency === 1 ? 'ETH' : currency === 2 ? 'USD' : `currency #${currency}`
}

export function distributionBatchCalls(distributions: readonly Distribution[]): ProjectBatchCall[] {
  return distributions.map(item => ({ ...distributionCall(item), projectId: item.projectId,
    id: `${item.kind}:${item.chainId}:${item.projectId}:${item.kind === 'payouts' ? item.context.token.toLowerCase() : 'reserved'}`,
    context: item }))
}

export function DistributionBatchFlow({ kind, chainId, projectId, chains, homeToken, onDone }: {
  kind: 'payouts' | 'reserved'; chainId: JBChainId; projectId: number; chains: readonly (readonly [number, number])[]; homeToken?: Address; onDone?: () => void
}) {
  const { address, isConnected, openSignIn } = useWallet()
  const queryClient = useQueryClient()
  const action = kind === 'payouts' ? 'distribute-payouts' : 'distribute-reserved'
  const scope = projectBatchScope(action, chainId, projectId)
  const projectState = useMemo(() => {
    try { return { projects: distributionProjects(chainId, projectId, chains), error: null } }
    catch (err) { return { projects: [], error: err instanceof Error ? err.message : 'Invalid project deployments.' } }
  }, [chainId, projectId, chains])
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<Set<number>>(() => new Set([chainId]))
  const [drafts, setDrafts] = useState<Record<number, Draft>>({})
  const [review, setReview] = useState<Distribution[] | null>(null)
  const [reviewAccount, setReviewAccount] = useState<Address | null>(null)
  const [batch, setBatch] = useState<ProjectBatch | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [complete, setComplete] = useState(false)
  useEffect(() => {
    const saved = loadProjectBatch(scope)
    setBatch(saved?.status === 'pending' ? saved : null)
    setReview(null)
    setReviewAccount(null)
    setSelected(new Set([chainId]))
    setDrafts({})
    setComplete(false)
    setOpen(saved?.status === 'pending')
  }, [scope, chainId])

  const options = useQuery({
    queryKey: ['distributionOptions', kind, projectState.projects, address, open],
    enabled: open && !!address && !batch && !projectState.error,
    staleTime: 0,
    retry: 1,
    queryFn: () => Promise.all(projectState.projects.map(async project => {
      try {
        return { project, payout: kind === 'payouts' ? await readPayoutOptions(project) : null, reserved: kind === 'reserved' ? await reviewReserved(project, address!) : null, error: null }
      } catch (err) { return { project, payout: null, reserved: null, error: err instanceof Error ? err.message : 'Could not verify this destination.' } }
    })),
  })

  const draftFor = (id: JBChainId, payout: PayoutOptions): Draft => {
    if (drafts[id]) return drafts[id]
    const token = homeToken ? matchingPayoutToken(homeToken, chainId, id) : null
    const context = token ? payout.contexts.find(item => isAddressEqual(item.token, token)) : undefined
    const limit = context?.limits.find(item => item.remaining > 0n)
    return { token: context?.token ?? '', currency: limit ? String(limit.currency) : '', amount: '' }
  }

  const begin = () => {
    if (!isConnected || !address) { openSignIn(); return }
    const saved = loadProjectBatch(scope)
    if (saved?.status === 'pending') setBatch(saved)
    setOpen(true); setComplete(false); setError(null)
  }
  const handleReview = async () => {
    if (!address || busy) return
    setBusy(true); setError(null)
    try {
      const saved = loadProjectBatch(scope)
      if (saved?.status === 'pending') { setBatch(saved); return }
      const chosen = projectState.projects.filter(project => selected.has(project.chainId))
      if (!chosen.length) throw new Error('Choose at least one chain.')
      const destinations = await Promise.all(chosen.map(async project => {
        if (kind === 'reserved') return reviewReserved(project, address)
        const option = options.data?.find(item => item.project.chainId === project.chainId)?.payout
        if (!option) throw new Error(`${chainName(project.chainId)} could not be verified.`)
        const draft = draftFor(project.chainId, option)
        const context = option.contexts.find(item => item.token.toLowerCase() === draft.token.toLowerCase())
        if (!context || !draft.currency || !draft.amount.trim()) throw new Error(`${chainName(project.chainId)}: choose a token, currency and payout amount.`)
        const entered = draft.amount.trim()
        if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/u.test(entered) || (entered.split('.')[1]?.length ?? 0) > context.decimals) {
          throw new Error(`${chainName(project.chainId)}: enter an amount with at most ${context.decimals} decimal places.`)
        }
        const amount = parseUnits(draft.amount.trim(), context.decimals)
        return reviewPayout(project, context.token, amount, Number(draft.currency), address)
      }))
      setReview(destinations)
      setReviewAccount(address)
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not review the distributions.') }
    finally { setBusy(false) }
  }

  const submit = async () => {
    if (!address || busy || (!review && !batch)) return
    if (!batch && (!reviewAccount || !isAddressEqual(address, reviewAccount))) {
      setReview(null); setError('The connected wallet changed. Review the distributions again.'); return
    }
    setBusy(true); setError(null)
    try {
      const result = await runProjectBatch({ scope, action, account: address,
        ...(batch ? { calls: batch.calls, expectedBatchId: batch.id } : { calls: distributionBatchCalls(review!), title: kind === 'payouts' ? 'Distribute payouts' : 'Distribute reserved tokens' }),
        reverify: call => reverifyDistribution(call.context as Distribution, address),
        verifyCompletion: async (call, receipt) => verifyDistributionCompletion(call.context as Distribution, receipt),
        onProgress: progress => setStatus(progress.message),
      })
      setBatch(result)
      if (result.status === 'complete') { setComplete(true); setStatus('All selected distributions are confirmed.'); void queryClient.invalidateQueries({ queryKey: ['readContract'] }); onDone?.() }
      else setStatus('Some distributions are still pending. Resume this saved review to check them.')
    } catch (err) {
      const saved = loadProjectBatch(scope)
      setBatch(saved?.status === 'pending' ? saved : null)
      if (!saved) { setReview(null); setReviewAccount(null); setStatus(null) }
      setError(err instanceof Error ? err.message : 'Could not complete the distributions.')
    } finally { setBusy(false) }
  }

  const reviewed = batch?.calls.map(call => call.context as Distribution) ?? review
  const title = kind === 'payouts' ? 'Distribute payouts' : 'Distribute reserved tokens'
  if (projectState.error) return <TxError error={projectState.error} />
  return <div className="mt-4 space-y-3">
    <button type="button" className="btn-secondary min-h-[40px] px-4 text-sm" disabled={busy} onClick={begin}>{batch?.status === 'pending' ? 'Resume saved distributions' : title}</button>
    {open && !reviewed ? <div className="space-y-4 rounded-xl border border-smoke-200 p-4">
      <p className="text-sm text-smoke-700">Choose the destination chains. Eligible independent calls share one Relayr payment; Safe and testnet calls continue as separate transactions.</p>
      {projectState.projects.map(project => {
        const option = options.data?.find(item => item.project.chainId === project.chainId)
        const payout = option?.payout
        const draft = payout ? draftFor(project.chainId, payout) : emptyDraft
        const context = payout?.contexts.find(item => item.token.toLowerCase() === draft.token.toLowerCase())
        const line = context?.limits.find(item => item.currency === Number(draft.currency))
        return <fieldset key={project.chainId} className="space-y-2 rounded-lg border border-smoke-200 p-3">
          <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={selected.has(project.chainId)} disabled={busy || (!!option?.error && !selected.has(project.chainId))} onChange={() => setSelected(previous => { const next = new Set(previous); if (next.has(project.chainId)) next.delete(project.chainId); else next.add(project.chainId); return next })} />{chainName(project.chainId)} · Project #{project.projectId}</label>
          {!option ? <p className="text-xs text-smoke-600">Reading this destination…</p> : option.error ? <p className="text-xs text-red-700">{option.error}</p> : option.reserved ? <p className="text-sm">{formatTokenAmount(option.reserved.pending)} {option.reserved.symbol} pending</p> : null}
          {selected.has(project.chainId) && payout ? <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs text-smoke-700">Accounting token<select aria-label={`Accounting token on ${chainName(project.chainId)}`} className="input-well mt-1 min-h-[40px] w-full px-2" value={draft.token} disabled={busy} onChange={event => {
              const nextContext = payout.contexts.find(item => item.token === event.target.value)
              setDrafts(previous => ({ ...previous, [project.chainId]: { token: event.target.value, currency: String(nextContext?.limits.find(item => item.remaining > 0n)?.currency ?? ''), amount: '' } }))
            }}><option value="">Choose a token</option>{payout.contexts.map(item => <option key={item.token} value={item.token}>{item.symbol} · {item.token.slice(0, 8)}… · {item.decimals} decimals</option>)}</select></label>
            <label className="text-xs text-smoke-700">Payout currency<select aria-label={`Payout currency on ${chainName(project.chainId)}`} className="input-well mt-1 min-h-[40px] w-full px-2" value={draft.currency} disabled={busy || !context} onChange={event => setDrafts(previous => ({ ...previous, [project.chainId]: { ...draft, currency: event.target.value, amount: '' } }))}><option value="">Choose a currency</option>{context?.limits.filter(item => item.amount > 0n).map(item => <option key={item.currency} value={item.currency}>{payoutCurrency(item.currency, context.currency, context.symbol)}</option>)}</select></label>
            <label className="text-xs text-smoke-700">Amount<input aria-label={`Payout amount on ${chainName(project.chainId)}`} type="text" inputMode="decimal" className="input-well mt-1 min-h-[40px] w-full px-2" value={draft.amount} disabled={busy || !line} onChange={event => setDrafts(previous => ({ ...previous, [project.chainId]: { ...draft, amount: event.target.value } }))} /></label>
            {context && line ? <p className="self-end text-xs text-smoke-600">Remaining limit: {formatTokenAmount(line.remaining, context.decimals)} {payoutCurrency(line.currency, context.currency, context.symbol)}. Balance: {formatTokenAmount(context.balance, context.decimals)} {context.symbol}.</p> : null}
          </div> : null}
        </fieldset>
      })}
      <TxError error={error} />
      <div className="flex gap-3"><button className="btn-primary min-h-[40px] px-4 text-sm" disabled={busy || options.isLoading} onClick={() => void handleReview()}>{busy ? 'Reviewing…' : 'Review selected distributions'}</button><button className="text-sm underline" disabled={busy} onClick={() => setOpen(false)}>Cancel</button></div>
    </div> : null}
    {open && reviewed ? <TxConfirmDialog open title={complete ? 'Distributions confirmed' : batch?.status === 'pending' ? 'Resume saved distributions' : 'Confirm distributions'} rows={distributionReviewRows(reviewed)} steps={[{ title }]} activeIndex={busy ? 0 : -1} busy={busy} complete={complete} status={status} error={error} action={batch?.status === 'pending' ? 'Resume saved distributions' : 'Confirm distributions'} onConfirm={() => void submit()} onClose={() => { if (busy) return; setOpen(false); if (!batch || batch.status === 'complete') { setReview(null); setBatch(null) } }} /> : null}
  </div>
}
