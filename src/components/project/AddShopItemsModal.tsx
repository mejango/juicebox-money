'use client'

import { type JBChainId } from '@bananapus/nana-sdk-core'
import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Address } from 'viem'
import { ChainPillButton } from '@/components/ui/ChainPillButton'
import { ModalShell } from '@/components/ui/ModalShell'
import { TxConfirmDialog } from '@/components/ui/TxConfirmDialog'
import { StoreEditor, itemOk, newDraftItem, type DraftItem, type StoreCategory } from '@/components/create/StoreEditor'
import { useWallet } from '@/hooks/useWallet'
import { shortError } from '@/lib/errors'
import { pinStoreItemDrafts, type PinnedStoreItemDraft } from '@/lib/store-items'
import { chainName } from '@/lib/urn'
import { loadProjectBatch, projectBatchScope, runProjectBatch, type ProjectBatch } from '@/lib/project-batch'
import { buildShopAddCalls, distinctShopTargets, pendingShopBatch, readShopSnapshot, reverifyShopCall, type ShopCallContext, type ShopSnapshot, type ShopWriteTarget } from '@/lib/shop-batch'

export type { ShopWriteTarget } from '@/lib/shop-batch'

type Review = { account: Address; items: DraftItem[]; categories: StoreCategory[]; chainIds: JBChainId[]; snapshots: ShopSnapshot[] }

export function AddShopItemsModal({ targets, activePricing, existingCategories, isRevnet, onClose }: {
  targets: ShopWriteTarget[]
  activePricing: { currency: number; decimals: number; symbol: string }
  existingCategories: StoreCategory[]
  isRevnet: boolean
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const { isConnected, address, openSignIn } = useWallet()
  const compatibleTargets = useMemo(() => targets.filter(target => target.hook && target.pricing && !target.error && target.pricing.currency === activePricing.currency), [targets, activePricing.currency])
  const [selected, setSelected] = useState<JBChainId[]>(() => compatibleTargets.map(target => target.chainId))
  const [items, setItems] = useState<DraftItem[]>(() => [newDraftItem()])
  const [categories, setCategories] = useState<StoreCategory[]>(() => existingCategories.filter(category => category.id !== 0))
  const [freshReview, setReview] = useState<Review | null>(null)
  const [batch, setBatch] = useState<ProjectBatch | null>(null)
  const [phase, setPhase] = useState<'form' | 'checking' | 'review' | 'pinning' | 'writing' | 'failed' | 'done'>('form')
  const [message, setMessage] = useState<string | null>(null)
  const pinnedRef = useRef<PinnedStoreItemDraft[] | null>(null)
  const busy = phase === 'checking' || phase === 'pinning' || phase === 'writing'
  const hasSubmittedTransactions = !!batch
  const hasUncertainTransactions = batch?.status === 'pending'
  const savedContext = batch?.calls[0]?.context as ShopCallContext | undefined
  const review = freshReview ?? (batch && savedContext ? { account: batch.account, items: savedContext.items, chainIds: batch.calls.map(call => call.chainId) } : null)
  const statuses = Object.fromEntries((batch?.calls ?? []).map(call => [call.chainId, { phase: batch!.completedIds.includes(call.id) ? 'done' : 'pending', error: undefined }]))

  useEffect(() => {
    if (freshReview || batch || busy) return
    try { const saved = pendingShopBatch('shop-add-items', targets); if (saved) setBatch(saved) }
    catch (error) { setMessage(shortError(error, 'Could not read the saved shop update.')) }
  }, [targets, freshReview, batch, busy])

  const close = useCallback(() => {
    if (busy) return
    for (const item of items) if (item.mediaPreview) URL.revokeObjectURL(item.mediaPreview)
    onClose()
  }, [busy, items, onClose])

  const toggleChain = (id: JBChainId) => {
    if (busy || review) return
    setSelected(current => current.includes(id) ? current.filter(chain => chain !== id) : [...current, id].sort((a, b) => a - b))
    setMessage(null)
  }
  const handleReview = async () => {
    if (!isConnected || !address) { openSignIn(); return }
    if (busy || batch) return
    setMessage(null)
    if (!selected.length) { setMessage('Select at least one chain.'); return }
    if (!items.length) { setMessage('Add at least one item.'); return }
    const invalid = items.findIndex(item => !itemOk(item))
    if (invalid >= 0) { setMessage(`Finish the required fields for item ${invalid + 1}.`); return }
    if (items.some(item => item.reserveN.trim() && selected.some(chain => (item.perChainSupply[chain]?.trim() || item.supply.trim()) === '1'))) { setMessage('Reserved inventory needs at least 2 items on every selected chain.'); return }
    setPhase('checking')
    try {
      const chosen = distinctShopTargets(compatibleTargets.filter(target => selected.includes(target.chainId)))
      if (chosen.length !== selected.length) throw new Error('The selected shops changed. Select the chains again.')
      const pending = pendingShopBatch('shop-add-items', chosen)
      if (pending) { setBatch(pending); setPhase('review'); return }
      const snapshots = await Promise.all(chosen.map(target => readShopSnapshot(target, address, isRevnet, 'shop-add-items')))
      const frozenItems = items.map(cloneDraftItem)
      // Validate exact per-chain prices, supplies and recipient mappings before uploading.
      buildShopAddCalls(snapshots, address, frozenItems.map(draft => ({ draft, encodedIpfsUri: `0x${'1'.repeat(64)}` })))
      setReview({ account: address, items: frozenItems, categories: categories.map(category => ({ ...category })), chainIds: chosen.map(target => target.chainId), snapshots })
      setPhase('review')
    } catch (error) { setMessage(shortError(error, 'Could not review the items.')); setPhase('form') }
  }
  const handleConfirm = async () => {
    if ((!freshReview && !batch) || !address || busy) return
    const expectedAccount = batch?.account ?? freshReview!.account
    if (expectedAccount.toLowerCase() !== address.toLowerCase()) { setMessage('Reconnect the wallet that reviewed this shop update.'); return }
    let scope = batch?.scope
    setMessage(null)
    try {
      let calls
      if (!batch) {
        setPhase('checking')
        const frozen = freshReview!
        const probe = buildShopAddCalls(frozen.snapshots, address, frozen.items.map(draft => ({ draft, encodedIpfsUri: `0x${'1'.repeat(64)}` })))
        await Promise.all(probe.map(call => reverifyShopCall(call, address)))
        if (!pinnedRef.current) { setPhase('pinning'); pinnedRef.current = await pinStoreItemDrafts(frozen.items, frozen.categories, setMessage) }
        calls = buildShopAddCalls(frozen.snapshots, address, pinnedRef.current)
        scope = projectBatchScope('shop-add-items', calls[0].chainId, calls[0].projectId)
      }
      setPhase('writing')
      const result = await runProjectBatch({ scope: scope!, action: 'shop-add-items', account: address, calls: batch?.calls ?? calls, expectedBatchId: batch?.id, title: 'Add shop items', reverify: call => reverifyShopCall(call, address), onProgress: progress => { setMessage(progress.message); const saved = loadProjectBatch(scope!); if (saved) setBatch(saved) } })
      setBatch(result)
      await Promise.allSettled([queryClient.invalidateQueries({ queryKey: ['shop721'] }), queryClient.invalidateQueries({ queryKey: ['shop721Media'] })])
      setPhase(result.status === 'complete' ? 'done' : 'failed')
      setMessage(result.status === 'complete' ? 'Items added on every reviewed chain.' : 'This update is saved. Continue to check its original transactions and any unfinished chains.')
    } catch (error) {
      let detail = shortError(error, 'Could not add the items.')
      try { if (scope) setBatch(loadProjectBatch(scope)) }
      catch (recoveryError) { detail = shortError(recoveryError, detail) }
      setMessage(detail); setPhase('failed')
    }
  }
  const backToForm = () => {
    if (busy || batch) { close(); return }
    setReview(null); pinnedRef.current = null; setMessage(null); setPhase('form')
  }

  const footer = (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <button
        type="button"
        onClick={close}
        disabled={busy}
        className="btn-secondary min-h-[44px] px-5 text-sm"
      >
        Cancel
      </button>
      <button
        type="button"
        onClick={() => void handleReview()}
        disabled={busy || !!review}
        className="btn-primary min-h-[44px] px-5 text-sm"
      >
        {!isConnected ? 'Sign in to continue' : 'Add items for sale'}
      </button>
    </div>
  )

  return (
    <ModalShell
      title="Add items for sale"
      subtitle="Stage one or more items, then add them to the collection."
      footer={footer}
      onClose={close}
      busy={busy}
    >
      <div className="callout callout-info text-xs">
        {isConnected
          ? 'Choose destination chains, then review each shop’s items. Eligible chains use Relayr with one funding transaction; Safe and unsupported chains proceed in separate rounds.'
          : 'Sign in with the shop owner or an authorized manager wallet to add items.'}
      </div>

      <StoreEditor
        items={items}
        onChange={next => {
          setItems(next)
          setMessage(null)
        }}
        currencyLabel={activePricing.symbol}
        disabled={busy || !!review}
        categories={categories}
        onAddCategory={name => {
          const id =
            categories.reduce(
              (largest, category) => Math.max(largest, category.id),
              0,
            ) + 1
          setCategories(current => [
            ...current,
            { id, name: name.slice(0, 40) },
          ])
          return id
        }}
        chainIds={selected}
        isRevnet={isRevnet}
      />

      <div className="mt-6 border-t border-smoke-200 pt-5 pb-5">
        <span className="field-label">Add on</span>
        <div
          role="group"
          aria-label="Chains to add items on"
          className="mt-2.5 flex min-w-0 flex-wrap gap-2"
        >
          {targets.map(target => {
            const compatible =
              !!target.hook &&
              !!target.pricing &&
              target.pricing.currency === activePricing.currency && !target.error
            const checked = selected.includes(target.chainId)
            const unavailableReason =
              target.error ??
              (target.pricing
                ? 'Different pricing currency'
                : 'Shop unavailable')
            return (
              <ChainPillButton
                key={target.chainId}
                chainId={target.chainId}
                selected={checked}
                ariaLabel={`${checked ? 'Remove' : 'Add'} ${chainName(target.chainId)}`}
                onClick={() => toggleChain(target.chainId)}
                disabled={!compatible || busy || !!review}
                title={compatible ? undefined : unavailableReason}
                size="lg"
              >
                <span>{chainName(target.chainId)}</span>
                {!compatible ? (
                  <span className="sr-only"> — {unavailableReason}</span>
                ) : null}
              </ChainPillButton>
            )
          })}
        </div>
      </div>

      {message && !review ? (
        <p
          className={`mt-4 rounded-lg px-3.5 py-2.5 text-xs leading-relaxed ${
            phase === 'failed' || phase === 'form'
              ? 'bg-error-50 text-error-700'
              : 'bg-bluebs-25 text-bluebs-700'
          }`}
          role={phase === 'failed' || phase === 'form' ? 'alert' : 'status'}
        >
          {message}
        </p>
      ) : null}

      {review || phase === 'checking' ? (
        <TxConfirmDialog
          open
          preparing={!review}
          title={phase === 'done' ? 'Items added' : 'Confirm items'}
          rows={
            review
              ? [
                  { label: 'Items', value: String(review.items.length) },
                  ...review.items.map((item, index) => ({
                    label: `Item ${index + 1}`,
                    value: `${item.name.trim()} — ${item.price} ${savedContext?.snapshot.target.pricing.symbol ?? activePricing.symbol}`,
                  })),
                  ...((batch?.calls.map(call => (call.context as ShopCallContext).snapshot) ?? freshReview?.snapshots) ?? []).map(snapshot => ({ label: `${chainName(snapshot.target.chainId)} · project #${snapshot.target.projectId}`, value: `Next item ID at review: ${BigInt(snapshot.maxTierId ?? '0') + 1n}; ${snapshot.target.pricing.decimals} price decimals` })),
                  ...(batch?.calls.flatMap(call => (call.context as ShopCallContext).items.map(item => ({ label: `${chainName(call.chainId)} · ${item.name}`, value: `Expected item #${item.tierId} · quantity: ${item.supply || 'unlimited'}` }))) ?? freshReview?.snapshots.flatMap(snapshot => [...freshReview.items].sort((a, b) => a.category - b.category).map((item, index) => ({ label: `${chainName(snapshot.target.chainId)} · ${item.name}`, value: `Expected item #${BigInt(snapshot.maxTierId ?? '0') + BigInt(index) + 1n} · quantity: ${item.perChainSupply[snapshot.target.chainId]?.trim() || item.supply || 'unlimited'}` }))) ?? []),
                  {
                    label: 'On',
                    value: review.chainIds.map(chainId => chainName(chainId)).join(', '),
                  },
                ]
              : []
          }
          steps={(review?.chainIds ?? []).map(chainId => {
            const status = statuses[chainId]
            return {
              key: String(chainId),
              title: `Add items on ${chainName(chainId)}`,
              detail:
                status?.phase === 'uncertain'
                  ? 'Submitted — status unknown'
                  : status?.phase === 'failed'
                    ? status.error
                    : undefined,
            }
          })}
          activeIndex={
            !review || phase === 'review'
              ? -1
              : review.chainIds.filter(
                  chainId => statuses[chainId]?.phase === 'done',
                ).length
          }
          status={
            !review
              ? 'Checking your permissions on the selected chains…'
              : phase === 'failed'
                ? undefined
                : message
          }
          error={phase === 'failed' ? message : undefined}
          busy={busy}
          complete={phase === 'done'}
          cancelLabel={hasSubmittedTransactions ? 'Close' : 'Cancel'}
          action={
            phase === 'checking'
              ? 'Checking permissions…'
              : phase === 'pinning'
                ? 'Saving items…'
                : phase === 'writing'
                  ? 'Adding items…'
                  : phase === 'failed'
                    ? hasUncertainTransactions
                      ? 'Continue saved update'
                      : 'Continue update'
                    : hasUncertainTransactions ? 'Continue saved update' : 'Add items for sale'
          }
          onConfirm={() => void handleConfirm()}
          onClose={
            phase === 'done' || hasSubmittedTransactions ? close : backToForm
          }
        />
      ) : null}
    </ModalShell>
  )
}

function cloneDraftItem(item: DraftItem): DraftItem {
  return {
    ...item,
    perChainSupply: { ...item.perChainSupply },
    splits: item.splits.map(split => ({
      ...split,
      perChain: { ...split.perChain },
      perChainBeneficiary: { ...split.perChainBeneficiary },
      perChainAmount: { ...split.perChainAmount },
    })),
  }
}
