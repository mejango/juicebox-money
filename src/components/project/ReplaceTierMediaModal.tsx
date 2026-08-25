'use client'

import {
  cidV0ToBytes32,
  jb721TiersHookAbi,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import {
  getProject721Shop,
  hasPermissions,
  JBPermissionIdsV6,
} from '@bananapus/nana-sdk-core/v6'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import type { Address, PublicClient } from 'viem'
import { useConfig, useSwitchChain, useWriteContract } from 'wagmi'
import { getAccount, getPublicClient } from 'wagmi/actions'
import { ModalShell } from '@/components/ui/ModalShell'
import { useWallet } from '@/hooks/useWallet'
import { submitReviewedContractWrite } from '@/lib/contract-write'
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
 * JB721TiersHook.setMetadata, on this chain only. Name, description and
 * category carry over from the current metadata; the rest of setMetadata's
 * arguments use the contract's "leave unchanged" sentinels.
 */
export function ReplaceTierMediaModal({
  chainId,
  projectId,
  hook,
  tierId,
  current,
  isRevnet,
  onClose,
}: {
  chainId: JBChainId
  projectId: number
  hook: Address
  tierId: number
  current: { name?: string; description?: string; categoryName?: string } | undefined
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
  const [phase, setPhase] = useState<
    'form' | 'checking' | 'pinning' | 'sending' | 'confirming' | 'uncertain' | 'done'
  >('form')
  const [message, setMessage] = useState<string | null>(null)
  const [hash, setHash] = useState<`0x${string}` | null>(null)

  const itemName = current?.name ?? `Item #${tierId}`
  const busy = ['checking', 'pinning', 'sending', 'confirming'].includes(phase)

  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview)
  }, [preview])

  const pick = (next: File | null) => {
    if (preview) URL.revokeObjectURL(preview)
    setMessage(null)
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

  const handleSubmit = async () => {
    if (!isConnected || !address) {
      openSignIn()
      return
    }
    if (!file || busy) return
    setMessage(null)
    try {
      setPhase('checking')
      const client = getPublicClient(config, {
        chainId: chainId as SupportedChainId,
      }) as PublicClient | undefined
      if (!client) throw new Error(`${chainName(chainId)} is unavailable.`)
      await assertMetadataReady(client, { chainId, projectId, hook, account: address, isRevnet })

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

      const request = {
        chainId,
        address: hook,
        abi: jb721TiersHookAbi,
        functionName: 'setMetadata' as const,
        // Empty strings and the hook's own address are the contract's
        // "leave unchanged" sentinels for everything but the tier URI.
        args: ['', '', '', '', hook, BigInt(tierId), cidV0ToBytes32(metadataPin.cid)] as const,
      }

      setPhase('sending')
      let submitted = await submitReviewedContractWrite({
        request,
        expectedAccount: address,
        review: reviewed =>
          requireContractTransactionReview(
            { ...reviewed, account: address },
            {
              title: `Review media update on ${chainName(chainId)}`,
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
          assertMetadataReady(client, { chainId, projectId, hook, account: address, isRevnet }),
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
      setHash(submitted)
      setPhase('confirming')
      if (isSafeConnection(config)) {
        submitted = await waitForSafeExecutionHash(chainId, submitted)
        setHash(submitted)
      }
      const receipt = await waitForTrackedReceipt(client, submitted)
      if (receipt.status !== 'success') throw new Error('The update failed.')

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['shop721', chainId, projectId, isRevnet] }),
        queryClient.invalidateQueries({ queryKey: ['shop721Media'] }),
      ])
      setPhase('done')
    } catch (error) {
      setMessage(shortError(error, 'Could not update the media.'))
      setPhase(isTransactionReceiptUnavailableError(error) ? 'uncertain' : 'form')
    }
  }

  const footer =
    phase === 'done' || phase === 'uncertain' ? (
      <button type="button" onClick={onClose} className="btn-primary min-h-[44px] px-5 text-sm">
        {phase === 'done' ? 'Done' : 'Close'}
      </button>
    ) : (
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} disabled={busy} className="btn-secondary min-h-[44px] px-5 text-sm">
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void handleSubmit()}
          disabled={busy || !file}
          className="btn-primary min-h-[44px] px-5 text-sm"
        >
          {!isConnected
            ? 'Sign in to continue'
            : phase === 'checking'
              ? 'Checking permission…'
              : phase === 'pinning'
                ? 'Uploading…'
                : phase === 'sending' || phase === 'confirming'
                  ? 'Updating…'
                  : 'Replace media'}
        </button>
      </div>
    )

  return (
    <ModalShell
      title={`Replace media for ${itemName}`}
      subtitle={`Pins new media and metadata, then updates item #${tierId} on ${chainName(chainId)}.`}
      footer={footer}
      onClose={onClose}
      busy={busy}
    >
      {phase === 'done' ? (
        <div className="py-8 text-center">
          <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-melon-100 text-xl text-melon-700">✓</span>
          <h3 className="mt-4 font-agrandir text-lg font-medium text-ink">Media replaced</h3>
          <p className="mt-2 text-sm text-smoke-700">
            {itemName} now points at the new media. Indexers can take a few minutes to catch up.
          </p>
          {hash ? <p className="mt-2 break-all font-mono text-xs text-smoke-500">{hash}</p> : null}
        </div>
      ) : phase === 'uncertain' ? (
        <div className="callout callout-info text-sm">
          The update was submitted. Its confirmation could not be read, so this form will not submit it again. Check the transaction before retrying.
          {hash ? <p className="mt-2 break-all font-mono text-xs">{hash}</p> : null}
        </div>
      ) : (
        <div className="space-y-5">
          <div className="callout callout-info text-xs">
            Only the {isRevnet ? 'revnet operator' : 'project owner'} or an address with the SET_721_METADATA permission can do this. Name, description and category carry over; only this chain&apos;s copy of the item is updated.
          </div>
          <label className="block">
            <span className="field-label">New media</span>
            <input
              type="file"
              accept="image/*,video/*,audio/*,application/pdf,text/*"
              disabled={busy}
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
        </div>
      )}
      {message ? (
        <p role="alert" className="mt-4 rounded-lg bg-error-50 px-3.5 py-2.5 text-xs text-error-700">
          {message}
        </p>
      ) : null}
    </ModalShell>
  )
}

async function assertMetadataReady(
  client: PublicClient,
  {
    chainId,
    projectId,
    hook,
    account,
    isRevnet,
  }: { chainId: JBChainId; projectId: number; hook: Address; account: Address; isRevnet: boolean },
) {
  const liveShop = await getProject721Shop(client, {
    chainId,
    projectId: BigInt(projectId),
    isRevnet,
    tierLimit: 0,
  })
  if (!liveShop || liveShop.hook.toLowerCase() !== hook.toLowerCase()) {
    throw new Error('The project’s live shop hook changed. Start again.')
  }
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
