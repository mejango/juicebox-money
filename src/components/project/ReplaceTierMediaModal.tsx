'use client'

import { cidV0ToBytes32, type JBChainId } from '@bananapus/nana-sdk-core'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Address, Hex } from 'viem'
import { ChainIcon } from '@/components/ChainIcon'
import type { ShopWriteTarget } from '@/components/project/AddShopItemsModal'
import { ModalShell } from '@/components/ui/ModalShell'
import { TxConfirmDialog } from '@/components/ui/TxConfirmDialog'
import { useWallet } from '@/hooks/useWallet'
import { clientFor } from '@/lib/authority'
import { shortError } from '@/lib/errors'
import { JBCENTER_MAX_IMAGE_BYTES, JBCENTER_MAX_MEDIA_BYTES, jbCenterIpfs } from '@/lib/jbcenter-ipfs'
import { loadProjectBatch, projectBatchScope, runProjectBatch, type ProjectBatch } from '@/lib/project-batch'
import { buildShopMediaCalls, distinctShopTargets, pendingShopBatch, readOriginalShopMetadata, readShopSnapshot, readShopTier, replaceShopMetadataMedia, reverifyShopCall, type ShopCallContext, type ShopSnapshot } from '@/lib/shop-batch'
import { chainName } from '@/lib/urn'

type MediaPlan = { account: Address; snapshots: ShopSnapshot[]; metadata: Record<string, unknown>; file: File; itemName: string }
function mediaAllowed(file: File): boolean {
  return ['image/', 'video/', 'audio/', 'text/'].some(prefix => file.type.startsWith(prefix)) || file.type === 'application/pdf'
}

/** Replace only media fields in the original immutable JSON, after proving
 * the linked shops still contain the same item. Recovery uses frozen calls. */
export function ReplaceTierMediaModal({ chainId, hook, tierId, current, targets, isRevnet, onClose }: {
  chainId: JBChainId; hook: Address; tierId: number
  current: { name?: string; description?: string; categoryName?: string } | undefined
  targets: ShopWriteTarget[] | null
  isRevnet: boolean
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const { isConnected, address, openSignIn } = useWallet()
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [selected, setSelected] = useState<number[]>([chainId])
  const [eligible, setEligible] = useState<Record<number, string | null> | null>(null)
  const [batch, setBatch] = useState<ProjectBatch | null>(null)
  const [freshPlan, setPlan] = useState<MediaPlan | null>(null)
  const [phase, setPhase] = useState<'form' | 'checking' | 'pinning' | 'writing' | 'done'>('form')
  const [message, setMessage] = useState<string | null>(null)
  const pinnedRef = useRef<Hex | null>(null)
  const busy = ['checking', 'pinning', 'writing'].includes(phase)
  const chainTargets = useMemo(() => (targets ?? []).filter(target => target.hook && !target.error), [targets])
  const savedContext = batch?.calls[0]?.context as ShopCallContext | undefined
  const itemName = savedContext?.items[0]?.name ?? freshPlan?.itemName ?? current?.name ?? `Item #${tierId}`
  const plan = batch ? { account: batch.account, chainIds: batch.calls.map(call => call.chainId), mediaName: savedContext?.mediaName ?? 'Saved media' } : freshPlan ? { account: freshPlan.account, chainIds: freshPlan.snapshots.map(snapshot => snapshot.target.chainId), mediaName: freshPlan.file.name } : null
  const statuses = Object.fromEntries((batch?.calls ?? []).map(call => [call.chainId, { phase: batch!.completedIds.includes(call.id) ? 'done' : 'pending', error: undefined }]))

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview) }, [preview])
  useEffect(() => {
    if (!targets || batch || freshPlan || busy) return
    try { const saved = pendingShopBatch('shop-replace-media', targets); if (saved) setBatch(saved) }
    catch (error) { setMessage(shortError(error, 'Could not read the saved media update.')) }
  }, [targets, batch, freshPlan, busy])
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
  const handleReview = async () => {
    if (!isConnected || !address) { openSignIn(); return }
    if (!file || busy || batch) return
    setMessage(null); setPhase('checking')
    try {
      const chosen = distinctShopTargets(chainTargets.filter(target => selected.includes(target.chainId)))
      if (!chosen.length || chosen.length !== selected.length) throw new Error('Choose the available chains again.')
      const pending = pendingShopBatch('shop-replace-media', chosen)
      if (pending) { setBatch(pending); return }
      const source = distinctShopTargets(chainTargets).find(target => target.chainId === chainId)
      if (!source?.hook || source.hook.toLowerCase() !== hook.toLowerCase()) throw new Error('The source shop changed. Reopen this item.')
      const sourceTier = await readShopTier(clientFor(chainId), hook, tierId)
      const snapshots = await Promise.all(chosen.map(target => readShopSnapshot(target, address, isRevnet, 'shop-replace-media', tierId)))
      if (snapshots.some(snapshot => snapshot.encodedIpfsUri?.toLowerCase() !== sourceTier.encodedIpfsUri.toLowerCase())) throw new Error('One selected chain now has a different item. Review the chain selection again.')
      const metadata = await readOriginalShopMetadata(sourceTier.encodedIpfsUri)
      pinnedRef.current = null
      setPlan({ account: address, snapshots, metadata, file, itemName: typeof metadata.name === 'string' ? metadata.name : itemName })
    } catch (error) { setMessage(shortError(error, 'Could not review the media update.')) }
    finally { setPhase('form') }
  }
  const handleSubmit = async () => {
    if ((!freshPlan && !batch) || !address || busy) return
    if ((batch?.account ?? freshPlan!.account).toLowerCase() !== address.toLowerCase()) { setMessage('Reconnect the wallet that reviewed this media update.'); return }
    let scope = batch?.scope
    setMessage(null)
    try {
      let calls
      if (!batch) {
        const frozen = freshPlan!
        const probe = buildShopMediaCalls(frozen.snapshots, address, `0x${'1'.repeat(64)}`, frozen.file.name, itemName)
        setPhase('checking'); await Promise.all(probe.map(call => reverifyShopCall(call, address)))
        if (!pinnedRef.current) {
          setPhase('pinning')
          const media = frozen.file.type.startsWith('image/') && frozen.file.size <= JBCENTER_MAX_IMAGE_BYTES ? await jbCenterIpfs.pinImage(frozen.file) : await jbCenterIpfs.pinMedia(frozen.file)
          const metadata = replaceShopMetadataMedia(frozen.metadata, media.uri, frozen.file.type)
          pinnedRef.current = cidV0ToBytes32((await jbCenterIpfs.pinJson(metadata)).cid)
        }
        calls = buildShopMediaCalls(frozen.snapshots, address, pinnedRef.current, frozen.file.name, itemName)
        scope = projectBatchScope('shop-replace-media', calls[0].chainId, calls[0].projectId)
      }
      setPhase('writing')
      const result = await runProjectBatch({ scope: scope!, action: 'shop-replace-media', account: address, calls: batch?.calls ?? calls, expectedBatchId: batch?.id, title: 'Replace item media', reverify: call => reverifyShopCall(call, address), onProgress: progress => { setMessage(progress.message); const saved = loadProjectBatch(scope!); if (saved) setBatch(saved) } })
      setBatch(result)
      await Promise.allSettled([queryClient.invalidateQueries({ queryKey: ['shop721'] }), queryClient.invalidateQueries({ queryKey: ['shop721Media'] })])
      setPhase(result.status === 'complete' ? 'done' : 'form')
      setMessage(result.status === 'complete' ? null : 'This update is saved. Continue to check its original transactions and any unfinished chains.')
    } catch (error) {
      let detail = shortError(error, 'Could not update the media.')
      try { if (scope) setBatch(loadProjectBatch(scope)) }
      catch (recoveryError) { detail = shortError(recoveryError, detail) }
      setMessage(detail); setPhase('form')
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
        disabled={busy || !file || !targets || !!plan}
        className="btn-primary min-h-[44px] px-5 text-sm"
      >
        {!isConnected
          ? 'Sign in to continue'
          : started
            ? 'Continue saved update'
            : selected.length > 1
              ? `Replace media on ${selected.length} chains`
              : 'Replace media'}
      </button>
    </div>
  )

  return (
    <ModalShell
      title={`Replace media for ${itemName}`}
      subtitle="Preserves the original metadata and updates the media on each reviewed chain."
      footer={footer}
      onClose={onClose}
      busy={busy}
    >
      <div className="space-y-5">
        <div className="callout callout-info text-xs">
          Only the {isRevnet ? 'revnet operator' : 'project owner'} or an address with the SET_721_METADATA permission can do this. All other original metadata fields carry over. Eligible chains use Relayr with one funding transaction; Safe and unsupported chains proceed in separate rounds.
        </div>
        <label className="block">
          <span className="field-label">New media</span>
          <input
            type="file"
            accept="image/*,video/*,audio/*,application/pdf,text/*"
            disabled={busy || !!plan}
            onChange={event => pick(event.target.files?.[0] ?? null)}
            className="mt-2 block w-full text-sm text-smoke-700 file:mr-3 file:rounded-lg file:border file:border-smoke-300 file:bg-white file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-ink"
          />
          {preview ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={preview} alt="" className="mt-3 max-h-48 rounded-lg object-contain" />
          ) : file ? (
            <p className="mt-2 text-xs text-smoke-500">{file.name}</p>
          ) : null}
        </label>
        <div>
          <span className="field-label">Chains</span>
          {!targets || !eligible ? (
            <div role="status" aria-label="Resolving linked shops" className="mt-2 h-9 w-full animate-pulse rounded-lg bg-smoke-100" />
          ) : (
            <ul className="mt-2 space-y-1.5">
              {chainTargets.map(target => {
                const reason = eligible[target.chainId] === null ? null : eligible[target.chainId] ?? 'Item not verified'
                const status = statuses[target.chainId]
                const checked = selected.includes(target.chainId)
                return (
                  <li key={target.chainId} className="flex items-center justify-between gap-3 text-sm">
                    <label className={`flex items-center gap-2 ${reason ? 'text-smoke-400' : 'text-ink'}`}>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={!!reason || busy || !!plan}
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
                      {reason ? <span className="text-xs">— {reason}</span> : null}
                    </label>
                    {status ? (
                      <span className={`text-xs ${status.phase === 'failed' ? 'text-error-700' : status.phase === 'done' ? 'text-melon-700' : 'text-smoke-500'}`}>
                        {status.phase === 'signing'
                          ? 'Awaiting signature…'
                          : status.phase === 'confirming'
                            ? 'Confirming…'
                            : status.phase === 'done'
                              ? 'Updated'
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
        </div>
      </div>
      {message && !plan ? (
        <p role="alert" className="mt-4 rounded-lg bg-error-50 px-3.5 py-2.5 text-xs text-error-700">
          {message}
        </p>
      ) : null}
      {plan || phase === 'checking' ? (
        <TxConfirmDialog
          open
          preparing={!plan}
          title={phase === 'done' ? 'Media replaced' : 'Confirm media update'}
          rows={
            plan
              ? [
                  { label: 'Item', value: itemName },
                  { label: 'New media', value: plan.mediaName },
                  ...((batch?.calls.map(call => (call.context as ShopCallContext).snapshot) ?? freshPlan?.snapshots) ?? []).map(snapshot => ({ label: chainName(snapshot.target.chainId), value: `Project #${snapshot.target.projectId} · item #${snapshot.tierId}` })),
                ]
              : []
          }
          steps={(plan?.chainIds ?? []).map(id => {
            const status = statuses[id]
            return {
              key: String(id),
              title: `Update ${chainName(id)}`,
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
                ? 'Pinning the media and metadata…'
                : phase === 'done'
                  ? `${itemName} now points at the new media. Already-minted items update too. Indexers can take a few minutes to catch up.`
                  : phase === 'writing' ? message : undefined
          }
          error={busy ? undefined : message}
          busy={busy}
          complete={phase === 'done'}
          cancelLabel={started ? 'Close' : 'Cancel'}
          action={
            phase === 'checking'
              ? 'Checking permission…'
              : phase === 'pinning'
                ? 'Uploading…'
                : phase === 'writing'
                  ? 'Updating…'
                  : started
                    ? 'Continue saved update'
                    : 'Confirm & replace media'
          }
          onConfirm={() => void handleSubmit()}
          onClose={batch || phase === 'done' ? onClose : () => setPlan(null)}
        />
      ) : null}
    </ModalShell>
  )
}
