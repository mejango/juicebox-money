'use client'

import { SHOP_721_QUERY_PREFIX } from '@/hooks/useShop721'

import { cidV0ToBytes32, type JBChainId } from '@bananapus/nana-sdk-core'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Address, Hex } from 'viem'
import { ChainIcon } from '@/components/ChainIcon'
import type { ShopWriteTarget } from '@/components/project/AddShopItemsModal'
import { ModalShell } from '@/components/ui/ModalShell'
import { TxProgress } from '@/components/ui/TxProgress'
import { useRelayrDiscard } from '@/components/RelayrDiscard'
import { useUnmountSignal } from '@/hooks/useUnmountSignal'
import { useWallet } from '@/hooks/useWallet'
import { clientFor } from '@/lib/authority'
import { shortError } from '@/lib/errors'
import { JBCENTER_MAX_IMAGE_BYTES, JBCENTER_MAX_MEDIA_BYTES, jbCenterIpfs } from '@/lib/jbcenter-ipfs'
import { loadProjectBatch, projectBatchScope, runProjectBatch, type ProjectBatch } from '@/lib/project-batch'
import { discountUnits, itemDiscountOk } from '@/components/create/store-draft'
import { buildShopItemCalls, distinctShopTargets, editShopMetadataDetails, pendingShopBatch, readOriginalShopMetadata, readShopSnapshot, readShopTier, replaceShopMetadataMedia, reverifyShopCall, SHOP_ITEM_DESCRIPTION_MAX, SHOP_ITEM_NAME_MAX, type ShopCallContext, type ShopItemChange, type ShopSnapshot } from '@/lib/shop-batch'
import { chainName } from '@/lib/urn'

export type ShopItemMode = 'media' | 'details' | 'discount' | 'remove'
/** `metadata` is the JSON to pin: the original for media, the edited one for details. */
type ItemPlan = { account: Address; snapshots: ShopSnapshot[]; metadata?: Record<string, unknown>; file?: File; itemName: string; summary: string; description?: string; units?: number }
const MODES = {
  media: { action: 'shop-replace-media', title: 'Replace media', noun: 'media update', button: 'Replace media', subtitle: 'Everything else about the item stays the same.', row: 'New media', stays: 'its media stays as is there', step: 'Update', chainDone: 'Updated', runTitle: 'Replace item media', confirm: 'Confirm media update', doneTitle: 'Media replaced', done: 'now points at the new media. Already-minted items update too. Indexers can take a few minutes to catch up.', fail: 'Could not update the media.' },
  details: { action: 'shop-edit-details', title: 'Edit details', noun: 'details update', button: 'Save details', subtitle: 'Everything else about the item stays the same.', row: 'New name', stays: 'it stays as is there', step: 'Update', chainDone: 'Updated', runTitle: 'Edit item details', confirm: 'Confirm details update', doneTitle: 'Details saved', done: 'has its new details. Already-minted items update too. Indexers can take a few minutes to catch up.', fail: 'Could not update the details.' },
  discount: { action: 'shop-set-discount', title: 'Set discount', noun: 'discount update', button: 'Set discount', subtitle: 'New purchases pay the discounted price.', row: 'Discount', stays: 'its discount stays as is there', step: 'Update', chainDone: 'Updated', runTitle: 'Set item discount', confirm: 'Confirm discount', doneTitle: 'Discount set', done: 'has its new discount. Indexers can take a few minutes to catch up.', fail: 'Could not set the discount.' },
  remove: { action: 'shop-remove-item', title: 'Remove item', noun: 'removal', button: 'Remove item', subtitle: 'It leaves the shop for good.', row: '', stays: 'it stays in the shop there', step: 'Remove on', chainDone: 'Removed', runTitle: 'Remove shop item', confirm: 'Confirm removal', doneTitle: 'Item removed', done: 'is no longer for sale. Indexers can take a few minutes to catch up.', fail: 'Could not remove the item.' },
} as const
function percentOff(units: number): string { return `${units / 2}% off` }
const PROBE_URI = `0x${'1'.repeat(64)}` as Hex
function mediaAllowed(file: File): boolean {
  return ['image/', 'video/', 'audio/', 'text/'].some(prefix => file.type.startsWith(prefix)) || file.type === 'application/pdf'
}

/** Change one existing item (its media, its name and description, its discount,
 * or remove it) after proving the linked shops still contain the same item.
 * Metadata edits keep every other field of the original immutable JSON.
 * Recovery uses frozen calls. */
export function ShopItemModal({ mode, chainId, hook, tierId, current, discountPercent = 0, targets, isRevnet, onClose }: {
  mode: ShopItemMode
  chainId: JBChainId; hook: Address; tierId: number
  current: { name?: string; description?: string; categoryName?: string } | undefined
  /** The item's discount on this chain, out of 200. */
  discountPercent?: number
  targets: ShopWriteTarget[] | null
  isRevnet: boolean
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const { isConnected, address, openSignIn } = useWallet()
  // Leaving ends the batch's wait for a Safe to execute a call; the call stays submitted.
  const flowSignal = useUnmountSignal()
  const copy = MODES[mode]
  const action = copy.action
  const [file, setFile] = useState<File | null>(null)
  const [name, setName] = useState(current?.name ?? '')
  const [description, setDescription] = useState(current?.description ?? '')
  const [discount, setDiscount] = useState(String(discountPercent / 2))
  const [preview, setPreview] = useState<string | null>(null)
  const [selected, setSelected] = useState<number[]>([chainId])
  const [eligible, setEligible] = useState<Record<number, string | null> | null>(null)
  const [batch, setBatch] = useState<ProjectBatch | null>(null)
  const [freshPlan, setPlan] = useState<ItemPlan | null>(null)
  const [phase, setPhase] = useState<'form' | 'checking' | 'pinning' | 'writing' | 'done'>('form')
  const [message, setMessage] = useState<string | null>(null)
  // Discard abandons the saved batch, so the update is reviewed again from live state (ruling R114 (f)).
  const discard = useRelayrDiscard(() => setMessage(null), () => { setBatch(null); setPlan(null); setPhase('form') })
  const pinnedRef = useRef<Hex | null>(null)
  const busy = ['checking', 'pinning', 'writing'].includes(phase)
  const chainTargets = useMemo(() => (targets ?? []).filter(target => target.hook && !target.error), [targets])
  const usableTargets = chainTargets.filter(target => eligible?.[target.chainId] === null)
  const savedContext = batch?.calls[0]?.context as ShopCallContext | undefined
  const itemName = savedContext?.items[0]?.name ?? freshPlan?.itemName ?? current?.name ?? `Item #${tierId}`
  const plan = batch ? { account: batch.account, chainIds: batch.calls.map(call => call.chainId), summary: savedContext?.mediaName ?? savedContext?.summary ?? (mode === 'media' ? 'Saved media' : ''), description: savedContext?.description } : freshPlan ? { account: freshPlan.account, chainIds: freshPlan.snapshots.map(snapshot => snapshot.target.chainId), summary: freshPlan.summary, description: freshPlan.description } : null
  const units = itemDiscountOk(discount) && discount.trim() !== '' && Number.isInteger(Number(discount) * 2) ? discountUnits(discount) : null
  const ready = mode === 'media' ? !!file : mode === 'details' ? !!name.trim() : mode === 'discount' ? units !== null && units !== discountPercent : true
  const statuses = Object.fromEntries((batch?.calls ?? []).map(call => [call.chainId, { phase: batch!.completedIds.includes(call.id) ? 'done' : 'pending', error: undefined }]))

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview) }, [preview])
  useEffect(() => {
    if (!targets || batch || freshPlan || busy) return
    try { const saved = pendingShopBatch(action, targets); if (saved) setBatch(saved) }
    catch (error) { setMessage(shortError(error, `Could not read the saved ${copy.noun}.`)) }
  }, [targets, batch, freshPlan, busy, action, copy.noun])
  useEffect(() => {
    if (!targets || batch || freshPlan) return
    let cancelled = false
    void (async () => {
      try {
        const unique = distinctShopTargets(chainTargets)
        const source = unique.find(target => target.chainId === chainId)
        if (!source?.hook || source.hook.toLowerCase() !== hook.toLowerCase()) throw new Error('The source shop changed. Reopen this item.')
        const home = await readShopTier(clientFor(chainId), hook, tierId)
        const rows = await Promise.all(unique.map(async target => {
          try {
            const peer = await readShopTier(clientFor(target.chainId), target.hook!, tierId)
            return [target.chainId, peer.encodedIpfsUri.toLowerCase() === home.encodedIpfsUri.toLowerCase() ? null : 'A different item has this number here'] as const
          } catch { return [target.chainId, 'Could not verify this item'] as const }
        }))
        if (cancelled) return
        const result = Object.fromEntries(rows)
        setEligible(result); setSelected(unique.filter(target => result[target.chainId] === null).map(target => target.chainId))
      } catch (error) { if (!cancelled) { setEligible({}); setSelected([]); setMessage(shortError(error, 'Could not resolve linked shops.')) } }
    })()
    return () => { cancelled = true }
  }, [targets, chainTargets, chainId, hook, tierId, batch, freshPlan])

  const pick = (next: File | null) => {
    if (batch || freshPlan || busy) return
    if (preview) URL.revokeObjectURL(preview)
    setMessage(null); pinnedRef.current = null
    if (!next) { setFile(null); setPreview(null); return }
    if (!mediaAllowed(next)) { setMessage('Images, video, audio, PDF, or text only.'); return }
    if (!next.size) { setMessage(`“${next.name}” is empty. Download it to this device first.`); return }
    if (next.size > JBCENTER_MAX_MEDIA_BYTES) { setMessage('That file is larger than the 500 MB limit.'); return }
    setFile(next); setPreview(next.type.startsWith('image/') ? URL.createObjectURL(next) : null)
  }
  const changeOf = (item: ItemPlan, uri: Hex): ShopItemChange =>
    mode === 'media' ? { action: 'shop-replace-media', encodedIpfsUri: uri, mediaName: item.summary }
      : mode === 'details' ? { action: 'shop-edit-details', encodedIpfsUri: uri, summary: item.summary, description: item.description ?? '' }
        : mode === 'discount' ? { action: 'shop-set-discount', discountPercent: item.units!, summary: item.summary }
          : { action: 'shop-remove-item' }
  const handleReview = async () => {
    if (!isConnected || !address) { openSignIn(); return }
    if (!ready || busy || batch) return
    setMessage(null); setPhase('checking')
    try {
      const chosen = distinctShopTargets(chainTargets.filter(target => selected.includes(target.chainId)))
      if (!chosen.length || chosen.length !== selected.length) throw new Error('Choose the available chains again.')
      const pending = pendingShopBatch(action, chosen)
      if (pending) { setBatch(pending); return }
      const source = distinctShopTargets(chainTargets).find(target => target.chainId === chainId)
      if (!source?.hook || source.hook.toLowerCase() !== hook.toLowerCase()) throw new Error('The source shop changed. Reopen this item.')
      const sourceTier = await readShopTier(clientFor(chainId), hook, tierId)
      const snapshots = await Promise.all(chosen.map(target => readShopSnapshot(target, address, isRevnet, action, tierId)))
      if (snapshots.some(snapshot => snapshot.encodedIpfsUri?.toLowerCase() !== sourceTier.encodedIpfsUri.toLowerCase())) throw new Error('One selected chain now has a different item. Review the chain selection again.')
      pinnedRef.current = null
      let next: ItemPlan = { account: address, snapshots, itemName, summary: '' }
      if (mode === 'media' || mode === 'details') {
        const original = await readOriginalShopMetadata(sourceTier.encodedIpfsUri)
        if (typeof original.name === 'string') next.itemName = original.name
        next = mode === 'media'
          ? { ...next, metadata: original, file: file!, summary: file!.name }
          : { ...next, metadata: editShopMetadataDetails(original, name, description), summary: name.trim(), description: description.trim() }
      } else if (mode === 'discount') next = { ...next, units: units!, summary: percentOff(units!) }
      // Each chain's own refusal (a discount that can only be lowered) shows here, before any pin.
      buildShopItemCalls(snapshots, address, changeOf(next, PROBE_URI), next.itemName)
      setPlan(next)
    } catch (error) { setMessage(shortError(error, `Could not review the ${copy.noun}.`)) }
    finally { setPhase('form') }
  }
  const handleSubmit = async () => {
    if ((!freshPlan && !batch) || !address || busy) return
    if ((batch?.account ?? freshPlan!.account).toLowerCase() !== address.toLowerCase()) { setMessage(`Reconnect the wallet that reviewed this ${copy.noun}.`); return }
    let scope = batch?.scope
    setMessage(null)
    discard.capture(null)
    try {
      let calls
      if (!batch) {
        const frozen = freshPlan!
        const probe = buildShopItemCalls(frozen.snapshots, address, changeOf(frozen, PROBE_URI), frozen.itemName)
        setPhase('checking'); await Promise.all(probe.map(call => reverifyShopCall(call, address, true)))
        if (frozen.metadata && !pinnedRef.current) {
          setPhase('pinning')
          let metadata = frozen.metadata
          if (frozen.file) {
            const media = frozen.file.type.startsWith('image/') && frozen.file.size <= JBCENTER_MAX_IMAGE_BYTES ? await jbCenterIpfs.pinImage(frozen.file) : await jbCenterIpfs.pinMedia(frozen.file)
            metadata = replaceShopMetadataMedia(metadata, media.uri, frozen.file.type)
          }
          pinnedRef.current = cidV0ToBytes32((await jbCenterIpfs.pinJson(metadata)).cid)
        }
        calls = buildShopItemCalls(frozen.snapshots, address, changeOf(frozen, pinnedRef.current ?? PROBE_URI), frozen.itemName)
        scope = projectBatchScope(action, calls[0].chainId, calls[0].projectId)
      }
      setPhase('writing')
      const result = await runProjectBatch({ scope: scope!, action, account: address, calls: batch?.calls ?? calls, expectedBatchId: batch?.id, title: copy.runTitle, reverify: call => reverifyShopCall(call, address, true), signal: flowSignal(), onProgress: progress => { setMessage(progress.message); const saved = loadProjectBatch(scope!); if (saved) setBatch(saved) } })
      setBatch(result)
      await Promise.allSettled([queryClient.invalidateQueries({ queryKey: SHOP_721_QUERY_PREFIX }), queryClient.invalidateQueries({ queryKey: ['shop721Media'] })])
      setPhase(result.status === 'complete' ? 'done' : 'form')
      setMessage(result.status === 'complete' ? null : 'This update is saved. Continue to check its original transactions and any unfinished chains.')
    } catch (error) {
      let detail = shortError(error, copy.fail)
      try { if (scope) setBatch(loadProjectBatch(scope)) }
      catch (recoveryError) { detail = shortError(recoveryError, detail) }
      setMessage(detail); setPhase('form')
      discard.capture(error)
    }
  }

  const started = !!batch
  const footer = (
    <div className="flex justify-end gap-2">
      <button type="button" onClick={onClose} disabled={busy} className="btn-secondary min-h-[44px] px-5 text-sm">
        {started ? 'Close' : 'Cancel'}
      </button>
      <button
        type="button"
        onClick={() => void handleReview()}
        disabled={busy || !ready || !targets || !!plan}
        className="btn-primary min-h-[44px] px-5 text-sm"
      >
        {!isConnected
          ? 'Sign in to continue'
          : started
            ? 'Continue saved update'
            : selected.length > 1
              ? `${copy.button} on ${selected.length} chains`
              : copy.button}
      </button>
    </div>
  )

  return (
    <ModalShell
      title={copy.title}
      subtitle={`${itemName}. ${copy.subtitle}`}
      footer={footer}
      onClose={onClose}
    >
      <div className="space-y-5">
        <div className="callout callout-info text-xs">
          Only the {isRevnet ? 'revnet operator' : 'project owner'} or an authorized operator can do this.
        </div>
        {mode === 'media' ? (
        <div>
            <span className="field-label">New media</span>
            <label className={`btn-secondary mt-2 min-h-[40px] cursor-pointer px-4 text-sm ${busy || plan ? 'pointer-events-none opacity-60' : ''}`}>
              {file ? 'Change media' : 'Upload media'}
              <input
                type="file"
                accept="image/*,video/*,audio/*,application/pdf,text/*"
                disabled={busy || !!plan}
                onChange={event => pick(event.target.files?.[0] ?? null)}
                className="sr-only"
              />
            </label>
            {preview ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={preview} alt="" className="mt-3 block max-h-48 rounded-lg object-contain" />
            ) : file ? (
              <p className="mt-2 text-xs text-smoke-500">{file.name}</p>
            ) : null}
          </div>
        ) : mode === 'details' ? (
          <>
            <label className="block">
              <span className="field-label">Name</span>
              <input type="text" value={name} maxLength={SHOP_ITEM_NAME_MAX} disabled={busy || !!plan} onChange={event => setName(event.target.value)} className="input-well mt-2 min-h-[44px] w-full px-3 text-sm" />
            </label>
            <label className="block">
              <span className="field-label">Description</span>
              <textarea value={description} maxLength={SHOP_ITEM_DESCRIPTION_MAX} rows={4} disabled={busy || !!plan} onChange={event => setDescription(event.target.value)} className="input-well mt-2 w-full p-3 text-sm" />
            </label>
          </>
        ) : mode === 'discount' ? (
          <label className="block">
            <span className="field-label">Discount (% off)</span>
            <input type="number" min={0} max={100} step={0.5} value={discount} disabled={busy || !!plan} onChange={event => setDiscount(event.target.value)} className="input-well mt-2 min-h-[44px] w-full px-3 text-sm" />
          </label>
        ) : (
          <div className="callout callout-warning text-xs">
            Buyers can no longer mint this item. Items already minted stay with their holders. Adding it again makes a new item.
          </div>
        )}
        <div>
          <span className="field-label">Chains</span>
          {!targets || !eligible ? (
            <div role="status" aria-label="Resolving linked shops" className="mt-2 h-9 w-full animate-pulse rounded-lg bg-smoke-100" />
          ) : (
            <ul className="mt-2 space-y-1.5">
              {usableTargets.map(target => {
                const status = statuses[target.chainId]
                const checked = selected.includes(target.chainId)
                return (
                  <li key={target.chainId} className="flex items-center justify-between gap-3 text-sm">
                    <label className="flex items-center gap-2 text-ink">
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={busy || !!plan}
                        onChange={event =>
                          setSelected(prev =>
                            event.target.checked
                              ? [...prev, target.chainId]
                              : prev.filter(id => id !== target.chainId),
                          )
                        }
                        className="h-4 w-4 accent-ink"
                      />
                      <ChainIcon chainId={target.chainId} size={16} />
                      {chainName(target.chainId)}
                    </label>
                    {status ? (
                      <span className={`text-xs ${status.phase === 'failed' ? 'text-error-700' : status.phase === 'done' ? 'text-melon-700' : 'text-smoke-500'}`}>
                        {status.phase === 'signing'
                          ? 'Awaiting signature…'
                          : status.phase === 'confirming'
                            ? 'Confirming…'
                            : status.phase === 'done'
                              ? copy.chainDone
                              : status.phase === 'uncertain'
                                ? 'Submitted, unconfirmed'
                                : status.phase === 'failed'
                                  ? status.error
                                  : 'Pending'}
                      </span>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          )}
          {eligible && usableTargets.length < chainTargets.length ? (
            <p className="mt-2 text-xs text-smoke-700">
              Couldn&rsquo;t match this item on{' '}
              {chainTargets.filter(target => !usableTargets.includes(target)).map(target => chainName(target.chainId)).join(', ')}, so {copy.stays}.
            </p>
          ) : null}
        </div>
      </div>
      {message && !plan ? (
        <p role="alert" className="mt-4 rounded-lg bg-error-50 px-3.5 py-2.5 text-xs text-error-700">
          {message}
        </p>
      ) : null}
      {plan || phase === 'checking' ? (
        <TxProgress
          open
          preparing={!plan}
          title={phase === 'done' ? copy.doneTitle : copy.confirm}
          rows={
            plan
              ? [
                  { label: 'Item', value: itemName },
                  ...(copy.row && plan.summary ? [{ label: copy.row, value: plan.summary }] : []),
                  ...(plan.description === undefined ? [] : [{ label: 'New description', value: plan.description || 'None' }]),
                  ...((batch?.calls.map(call => (call.context as ShopCallContext).snapshot) ?? freshPlan?.snapshots) ?? []).map(snapshot => ({ label: chainName(snapshot.target.chainId), value: `Project #${snapshot.target.projectId}, item #${snapshot.tierId}` })),
                ]
              : []
          }
          steps={(plan?.chainIds ?? []).map(id => {
            const status = statuses[id]
            return {
              key: String(id),
              title: `${copy.step} ${chainName(id)}`,
              detail:
                status?.phase === 'uncertain'
                  ? 'Submitted, unconfirmed'
                  : status?.phase === 'failed'
                    ? status.error
                    : undefined,
            }
          })}
          activeIndex={
            plan && (started || phase !== 'form')
              ? plan.chainIds.filter(id => statuses[id]?.phase === 'done').length
              : -1
          }
          status={
            phase === 'checking'
              ? 'Checking your permission on the selected chains…'
              : phase === 'pinning'
                ? 'Pinning the metadata…'
                : phase === 'done'
                  ? `${itemName} ${copy.done}`
                  : phase === 'writing' ? message : undefined
          }
          error={busy || discard.active ? undefined : message}
          busy={busy}
          complete={phase === 'done'}
          cancelLabel={started ? 'Close' : 'Cancel'}
          onClose={batch || phase === 'done' ? onClose : () => setPlan(null)}
          start={() => void handleSubmit()}
          next={!busy && !!message && phase !== 'done' ? { label: started ? 'Continue saved update' : 'Try again', onClick: () => void handleSubmit(), disabled: discard.active } : null}
        >
          {discard.element}
        </TxProgress>
      ) : null}
    </ModalShell>
  )
}
