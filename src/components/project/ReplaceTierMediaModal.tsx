'use client'

import {
  cidV0ToBytes32,
  jb721TiersHookAbi,
  jb721TiersHookStoreAbi,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import { hasPermissions, JBPermissionIdsV6 } from '@bananapus/nana-sdk-core/v6'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import type { Address, Hex, PublicClient } from 'viem'
import { useConfig, useSwitchChain, useWriteContract } from 'wagmi'
import { getAccount, getPublicClient } from 'wagmi/actions'
import { ChainIcon } from '@/components/ChainIcon'
import type { ShopWriteTarget } from '@/components/project/AddShopItemsModal'
import { ModalShell } from '@/components/ui/ModalShell'
import { TxConfirmDialog } from '@/components/ui/TxConfirmDialog'
import { useWallet } from '@/hooks/useWallet'
import { submitReviewedContractWrite } from '@/lib/contract-write'
import { buildSet721TierMediaRequest } from '@/lib/transaction-builders'
import { shortError } from '@/lib/errors'
import { gasWithHeadroom } from '@/lib/gas'
import {
  JBCENTER_MAX_IMAGE_BYTES,
  JBCENTER_MAX_MEDIA_BYTES,
  jbCenterIpfs,
} from '@/lib/jbcenter-ipfs'
import {
  isTransactionReceiptUnavailableError,
  waitForTrackedReceipt,
} from '@/lib/receipt'
import {
  isSafeConnection,
  SAFE_NONCE_GUIDANCE,
  waitForSafeExecutionHash,
} from '@/lib/safe-connector'
import { requireContractTransactionReview } from '@/lib/transaction-review'
import { chainName } from '@/lib/urn'
import { SUPPORTED_CHAINS } from '@/providers/Providers'

type SupportedChainId = (typeof SUPPORTED_CHAINS)[number]['id']

type ChainStatus = {
  phase: 'pending' | 'signing' | 'confirming' | 'done' | 'failed' | 'uncertain'
  hash?: `0x${string}`
  error?: string
}

function mediaAllowed(file: File): boolean {
  const type = file.type
  return (
    type.startsWith('image/') ||
    type.startsWith('video/') ||
    type.startsWith('audio/') ||
    type === 'application/pdf' ||
    type.startsWith('text/')
  )
}

/**
 * Re-pins one tier's metadata with new media and points the tier at it via
 * JB721TiersHook.setMetadata on every selected chain. Name, description and
 * category carry over; the other setMetadata arguments use the contract's
 * "leave unchanged" sentinels. A chain is only eligible when its copy of the
 * tier carries the same encodedIPFSUri as this chain's, so a same-numbered but
 * different item is never overwritten.
 */
export function ReplaceTierMediaModal({
  chainId,
  hook,
  tierId,
  current,
  targets,
  isRevnet,
  onClose,
}: {
  chainId: JBChainId
  hook: Address
  tierId: number
  current: { name?: string; description?: string; categoryName?: string } | undefined
  /** Linked shops on every chain; null while resolving. */
  targets: ShopWriteTarget[] | null
  isRevnet: boolean
  onClose: () => void
}) {
  const config = useConfig()
  const queryClient = useQueryClient()
  const { switchChainAsync } = useSwitchChain()
  const { writeContractAsync } = useWriteContract()
  const { isConnected, address, openSignIn } = useWallet()
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [selected, setSelected] = useState<number[]>([chainId])
  const [eligible, setEligible] = useState<Record<number, string | null> | null>(null)
  const [statuses, setStatuses] = useState<Record<number, ChainStatus>>({})
  const statusesRef = useRef<Record<number, ChainStatus>>({})
  const pinnedRef = useRef<Hex | null>(null)
  const [phase, setPhase] = useState<'form' | 'checking' | 'pinning' | 'writing' | 'done'>('form')
  const [message, setMessage] = useState<string | null>(null)
  const [plan, setPlan] = useState<{ account: Address; chainIds: number[] } | null>(null)

  const itemName = current?.name ?? `Item #${tierId}`
  const busy = ['checking', 'pinning', 'writing'].includes(phase)
  const chainTargets = (targets ?? []).filter(
    target => target.hook && !target.error,
  )

  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview)
  }, [preview])

  // Which linked chains carry the same item (same tier metadata) — the rest
  // are listed but not selectable.
  useEffect(() => {
    if (!targets) return
    let cancelled = false
    ;(async () => {
      const home = getPublicClient(config, { chainId: chainId as SupportedChainId }) as PublicClient | undefined
      if (!home) return
      const homeUri = await readTierUri(home, hook, tierId).catch(() => null)
      const result: Record<number, string | null> = {}
      await Promise.all(
        chainTargets.map(async target => {
          if (target.chainId === chainId) {
            result[target.chainId] = null
            return
          }
          const client = getPublicClient(config, { chainId: target.chainId as SupportedChainId }) as PublicClient | undefined
          if (!client || !target.hook) {
            result[target.chainId] = 'Unavailable'
            return
          }
          const uri = await readTierUri(client, target.hook, tierId).catch(() => undefined)
          result[target.chainId] =
            uri === undefined
              ? 'Could not read this item'
              : uri === '0x0000000000000000000000000000000000000000000000000000000000000000'
                ? 'No such item'
                : homeUri && uri.toLowerCase() === homeUri.toLowerCase()
                  ? null
                  : 'A different item has this number here'
        }),
      )
      if (cancelled) return
      setEligible(result)
      setSelected(chainTargets.filter(t => result[t.chainId] === null).map(t => t.chainId))
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targets, chainId, hook, tierId])

  const updateStatus = (id: number, patch: Partial<ChainStatus>) => {
    statusesRef.current = {
      ...statusesRef.current,
      [id]: { ...(statusesRef.current[id] ?? { phase: 'pending' }), ...patch },
    }
    setStatuses(statusesRef.current)
  }

  const pick = (next: File | null) => {
    if (preview) URL.revokeObjectURL(preview)
    setMessage(null)
    pinnedRef.current = null
    if (!next) {
      setFile(null)
      setPreview(null)
      return
    }
    if (!mediaAllowed(next)) {
      setMessage('Images, video, audio, PDF, or text only.')
      return
    }
    if (next.size === 0) {
      setMessage(
        `"${next.name}" is empty (0 bytes). If it lives in iCloud or another cloud drive, open it on this device first, then choose it again.`,
      )
      return
    }
    if (next.size > JBCENTER_MAX_MEDIA_BYTES) {
      setMessage('That file is larger than the 500 MB limit.')
      return
    }
    setFile(next)
    setPreview(next.type.startsWith('image/') ? URL.createObjectURL(next) : null)
  }

  const assertTargetsReady = async (runTargets: ShopWriteTarget[], account: Address) => {
    for (const target of runTargets) {
      if (statusesRef.current[target.chainId]?.phase === 'done') continue
      const client = getPublicClient(config, { chainId: target.chainId as SupportedChainId }) as PublicClient | undefined
      if (!client || !target.hook) throw new Error(`${chainName(target.chainId)} is unavailable.`)
      await assertMetadataReady(client, { chainId: target.chainId, projectId: target.projectId, hook: target.hook, account })
    }
  }

  const handleReview = async () => {
    if (!isConnected || !address) {
      openSignIn()
      return
    }
    if (!file || busy) return
    const runTargets = chainTargets.filter(t => selected.includes(t.chainId))
    if (runTargets.length === 0) {
      setMessage('Choose at least one chain.')
      return
    }
    setMessage(null)
    setPhase('checking')
    try {
      await assertTargetsReady(runTargets, address)
      setPlan({ account: address, chainIds: runTargets.map(t => t.chainId) })
    } catch (error) {
      setMessage(shortError(error, 'Could not update the media.'))
    } finally {
      setPhase('form')
    }
  }

  const handleSubmit = async () => {
    if (!plan || !file || !address || busy) return
    if (plan.account.toLowerCase() !== address.toLowerCase()) {
      setPlan(null)
      setMessage('Connected account changed. Start the media update again.')
      return
    }
    const runTargets = chainTargets.filter(t => plan.chainIds.includes(t.chainId))
    setMessage(null)
    try {
      setPhase('checking')
      await assertTargetsReady(runTargets, address)

      if (!pinnedRef.current) {
        setPhase('pinning')
        const isImage = file.type.startsWith('image/')
        const mediaPin =
          isImage && file.size <= JBCENTER_MAX_IMAGE_BYTES
            ? await jbCenterIpfs.pinImage(file)
            : await jbCenterIpfs.pinMedia(file)
        const metadataPin = await jbCenterIpfs.pinJson({
          name: current?.name ?? itemName,
          description: current?.description || undefined,
          image: isImage ? mediaPin.uri : undefined,
          animation_url: isImage ? undefined : mediaPin.uri,
          mediaType: file.type || undefined,
          categoryName: current?.categoryName || undefined,
        })
        pinnedRef.current = cidV0ToBytes32(metadataPin.cid)
      }
      const encoded = pinnedRef.current

      setPhase('writing')
      for (const target of runTargets) {
        if (statusesRef.current[target.chainId]?.phase === 'done') continue
        const targetChain = target.chainId as JBChainId
        const targetHook = target.hook as Address
        const client = getPublicClient(config, { chainId: target.chainId as SupportedChainId }) as PublicClient
        updateStatus(target.chainId, { phase: 'signing', error: undefined })
        try {
          const request = buildSet721TierMediaRequest({
            chainId: targetChain,
            hook: targetHook,
            tierId,
            encodedIpfsUri: encoded,
          })
          let submitted = await submitReviewedContractWrite({
            request,
            expectedAccount: address,
            review: reviewed =>
              requireContractTransactionReview(
                { ...reviewed, account: address },
                {
                  title: `Review media update on ${chainName(targetChain)}`,
                  label: `Replace media for ${itemName}`,
                  contractName: 'JB721TiersHook',
                  description: isSafeConnection(config)
                    ? SAFE_NONCE_GUIDANCE
                    : 'This points the item at newly pinned metadata. Already-minted items update too.',
                  ...(isSafeConnection(config) ? { confirmLabel: 'Agree & continue to Safe' } : {}),
                },
              ),
            switchChain: reviewedChainId =>
              switchChainAsync({ chainId: reviewedChainId as SupportedChainId }),
            currentAccount: () => getAccount(config).address,
            reverify: () =>
              assertMetadataReady(client, { chainId: targetChain, projectId: target.projectId, hook: targetHook, account: address }),
            simulate: async reviewed => {
              const simulationRequest = { ...reviewed, account: address }
              const [{ request: simulated }, estimate] = await Promise.all([
                client.simulateContract(simulationRequest),
                client.estimateContractGas(simulationRequest),
              ])
              return { ...simulated, gas: gasWithHeadroom(estimate) }
            },
            write: simulated =>
              writeContractAsync(simulated as Parameters<typeof writeContractAsync>[0]),
            accountChangedError: 'Connected account changed. Start the media update again.',
          })
          updateStatus(target.chainId, { phase: 'confirming', hash: submitted })
          if (isSafeConnection(config)) {
            submitted = await waitForSafeExecutionHash(targetChain, submitted)
            updateStatus(target.chainId, { hash: submitted })
          }
          const receipt = await waitForTrackedReceipt(client, submitted)
          if (receipt.status !== 'success') throw new Error('The update failed.')
          updateStatus(target.chainId, { phase: 'done' })
        } catch (error) {
          updateStatus(target.chainId, {
            phase: isTransactionReceiptUnavailableError(error) ? 'uncertain' : 'failed',
            error: shortError(error, 'Could not update this chain.'),
          })
          throw error
        }
      }

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['shop721'] }),
        queryClient.invalidateQueries({ queryKey: ['shop721Media'] }),
      ])
      setPhase('done')
    } catch (error) {
      setMessage(shortError(error, 'Could not update the media.'))
      setPhase('form')
    }
  }

  const started = Object.keys(statuses).length > 0
  const footer = (
    <div className="flex justify-end gap-2">
      <button type="button" onClick={onClose} disabled={busy} className="btn-secondary min-h-[44px] px-5 text-sm">
        {started ? 'Close' : 'Cancel'}
      </button>
      <button
        type="button"
        onClick={() => void handleReview()}
        disabled={busy || !file || !targets}
        className="btn-primary min-h-[44px] px-5 text-sm"
      >
        {!isConnected
          ? 'Sign in to continue'
          : phase === 'checking'
            ? 'Checking permission…'
            : started
              ? 'Retry remaining chains'
              : selected.length > 1
                ? `Replace media on ${selected.length} chains`
                : 'Replace media'}
      </button>
    </div>
  )

  return (
    <ModalShell
      title={`Replace media for ${itemName}`}
      subtitle="Pins new media and metadata once, then updates the item on each selected chain."
      footer={footer}
      onClose={onClose}
      busy={busy}
    >
      <div className="space-y-5">
        <div className="callout callout-info text-xs">
          Only the {isRevnet ? 'revnet operator' : 'project owner'} or an address with the SET_721_METADATA permission can do this. Name, description and category carry over.
        </div>
        <label className="block">
          <span className="field-label">New media</span>
          <input
            type="file"
            accept="image/*,video/*,audio/*,application/pdf,text/*"
            disabled={busy || started}
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
                const reason = eligible[target.chainId] ?? null
                const status = statuses[target.chainId]
                const checked = selected.includes(target.chainId)
                return (
                  <li key={target.chainId} className="flex items-center justify-between gap-3 text-sm">
                    <label className={`flex items-center gap-2 ${reason ? 'text-smoke-400' : 'text-ink'}`}>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={!!reason || busy || started}
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
      {plan && file ? (
        <TxConfirmDialog
          open
          title={phase === 'done' ? 'Media replaced' : 'Confirm media update'}
          rows={[
            { label: 'Item', value: itemName },
            { label: 'New media', value: file.name },
            { label: 'On', value: plan.chainIds.map(id => chainName(id)).join(', ') },
          ]}
          steps={plan.chainIds.map(id => {
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
            started || phase !== 'form'
              ? plan.chainIds.filter(id => statuses[id]?.phase === 'done').length
              : -1
          }
          status={
            phase === 'checking'
              ? 'Checking permission…'
              : phase === 'pinning'
                ? 'Pinning the media and metadata…'
                : phase === 'done'
                  ? `${itemName} now points at the new media. Already-minted items update too. Indexers can take a few minutes to catch up.`
                  : undefined
          }
          error={message}
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
                    ? 'Retry remaining chains'
                    : 'Confirm & replace media'
          }
          onConfirm={() => void handleSubmit()}
          onClose={phase === 'done' ? onClose : () => setPlan(null)}
        />
      ) : null}
    </ModalShell>
  )
}

async function readTierUri(client: PublicClient, hook: Address, tierId: number): Promise<Hex> {
  const store = await client.readContract({ address: hook, abi: jb721TiersHookAbi, functionName: 'STORE' })
  const tier = await client.readContract({
    address: store,
    abi: jb721TiersHookStoreAbi,
    functionName: 'tierOf',
    args: [hook, BigInt(tierId), false],
  })
  return Number(tier.id) === tierId ? tier.encodedIpfsUri : ('0x' + '0'.repeat(64)) as Hex
}

async function assertMetadataReady(
  client: PublicClient,
  { chainId, projectId, hook, account }: { chainId: JBChainId; projectId: number; hook: Address; account: Address },
) {
  const owner = await client.readContract({ address: hook, abi: jb721TiersHookAbi, functionName: 'owner' })
  if (owner.toLowerCase() === account.toLowerCase()) return
  const allowed = await hasPermissions(client, {
    chainId,
    operator: account,
    account: owner,
    projectId: BigInt(projectId),
    permissionIds: [JBPermissionIdsV6.SET_721_METADATA],
  })
  if (!allowed) throw new Error(`This wallet cannot edit shop metadata on ${chainName(chainId)}.`)
}
