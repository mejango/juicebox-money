'use client'

import { shop721QueryKey } from '@/hooks/useShop721'

import {
  jb721TiersHookAbi,
  jb721TiersHookStoreAbi,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import {
  getProjectNftInventory,
  hasPermissions,
  JBPermissionIdsV6,
} from '@bananapus/nana-sdk-core/v6'
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import {
  isAddress,
  zeroAddress,
  type Address,
  type PublicClient,
} from 'viem'
import { useConfig } from 'wagmi'
import { getPublicClient } from 'wagmi/actions'
import { ModalShell } from '@/components/ui/ModalShell'
import { TxConfirmDialog } from '@/components/ui/TxConfirmDialog'
import { useWallet } from '@/hooks/useWallet'
import { reviewedCall, useReviewedAction } from '@/hooks/useReviewedAction'
import { captureWalletContext } from '@/lib/wallet-context'
import { shortError } from '@/lib/errors'
import { buildMint721TierRequest } from '@/lib/transaction-builders'
import { chainName } from '@/lib/urn'
import { SUPPORTED_CHAINS } from '@/providers/Providers'

type SupportedChainId = (typeof SUPPORTED_CHAINS)[number]['id']

type MintReview = {
  account: Address
  beneficiary: Address
  quantity: number
}

export function MintShopItemModal({
  chainId,
  projectId,
  hook,
  tierId,
  itemName,
  remaining,
  isRevnet,
  onClose,
}: {
  chainId: JBChainId
  projectId: number
  hook: Address
  tierId: number
  itemName: string
  remaining: number
  isRevnet: boolean
  onClose: () => void
}) {
  const config = useConfig()
  const queryClient = useQueryClient()
  const { isConnected, address, openSignIn } = useWallet()
  const [beneficiary, setBeneficiary] = useState(address ?? '')
  const [quantity, setQuantity] = useState('1')
  const [review, setReview] = useState<MintReview | null>(null)
  const [phase, setPhase] = useState<'form' | 'checking' | 'review'>('form')
  const [message, setMessage] = useState<string | null>(null)
  const tx = useReviewedAction(chainId)
  const busy = phase === 'checking' || tx.busy
  const settled = tx.settled
  const maxQuantity = Math.max(0, Math.min(50, remaining))

  const handleReview = async () => {
    if (!isConnected || !address) {
      openSignIn()
      return
    }
    const normalizedBeneficiary = beneficiary.trim()
    const parsedQuantity = Number(quantity)
    if (
      !isAddress(normalizedBeneficiary) ||
      normalizedBeneficiary.toLowerCase() === zeroAddress
    ) {
      setMessage('Enter a valid, non-zero beneficiary address.')
      return
    }
    if (
      !Number.isSafeInteger(parsedQuantity) ||
      parsedQuantity < 1 ||
      parsedQuantity > maxQuantity
    ) {
      setMessage(`Choose between 1 and ${maxQuantity} items.`)
      return
    }

    setPhase('checking')
    setMessage(null)
    try {
      const client = getPublicClient(config, {
        chainId: chainId as SupportedChainId,
      }) as PublicClient | undefined
      if (!client) throw new Error(`${chainName(chainId)} is unavailable.`)
      await assertMintReady(client, {
        chainId,
        projectId,
        hook,
        account: address,
        tierId,
        quantity: parsedQuantity,
        isRevnet,
      })
      setReview({
        account: address,
        beneficiary: normalizedBeneficiary,
        quantity: parsedQuantity,
      })
      setPhase('review')
    } catch (error) {
      setMessage(shortError(error, 'This wallet cannot mint this item.'))
      setPhase('form')
    }
  }

  const handleConfirm = async () => {
    if (!review || !address || busy) return
    if (review.account.toLowerCase() !== address.toLowerCase()) {
      setReview(null)
      setPhase('form')
      setMessage('Your connected account changed. Review the mint again.')
      return
    }
    setMessage(null)
    const client = getPublicClient(config, { chainId: chainId as SupportedChainId }) as PublicClient | undefined
    if (!client) {
      setMessage(`${chainName(chainId)} is unavailable.`)
      return
    }
    const request = buildMint721TierRequest({
      chainId, hook, tierIds: Array.from({ length: review.quantity }, () => tierId), beneficiary: review.beneficiary,
    })
    const result = await tx.run({
      account: review.account,
      calls: [{ ...reviewedCall({ ...request, label: `Mint ${review.quantity} × ${itemName}` }), contractName: 'JB721TiersHook' }],
      title: `Review free mint on ${chainName(chainId)}`,
      description: 'This consumes shop inventory and collects no payment. It cannot be undone.',
      // The wallet that reviewed it, on the mint's chain, right before it opens.
      assertWriteState: captureWalletContext(config, { account: review.account, chainId }),
      reverify: () => assertMintReady(client, {
        chainId, projectId, hook, account: review.account, tierId, quantity: review.quantity, isRevnet,
      }),
    })
    if (result?.status === 'done') {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: shop721QueryKey(chainId, projectId, isRevnet) }),
        queryClient.invalidateQueries({ queryKey: ['shopTierSupply'] }),
      ])
    }
  }

  const footer = (
    <div className="flex justify-end gap-2">
      <button type="button" onClick={onClose} disabled={busy} className="btn-secondary min-h-[44px] px-5 text-sm">
        Cancel
      </button>
      <button type="button" onClick={() => void handleReview()} disabled={busy || maxQuantity === 0} className="btn-primary min-h-[44px] px-5 text-sm">
        {!isConnected ? 'Sign in to continue' : 'Mint without payment'}
      </button>
    </div>
  )

  return (
    <ModalShell
      title={`Mint ${itemName}`}
      subtitle={`Send inventory from item #${tierId} on ${chainName(chainId)} without collecting payment.`}
      footer={footer}
      onClose={onClose}
    >
      <div className="space-y-5">
        <div className="callout callout-info text-xs">
          Only the {isRevnet ? 'revnet operator' : 'project owner'} or an address with the MINT_721 permission can use this. The contract will reject tiers that did not enable free minting or lack inventory.
        </div>
        <label className="block">
          <span className="field-label">Beneficiary address</span>
          <input
            value={beneficiary}
            onChange={event => {
              setBeneficiary(event.target.value.slice(0, 64))
              setMessage(null)
            }}
            placeholder="0x…"
            disabled={busy}
            autoComplete="off"
            spellCheck={false}
            className="input-well mt-2 min-h-[44px] w-full px-3 font-mono text-sm"
          />
        </label>
        <label className="block">
          <span className="field-label">Quantity</span>
          <input
            type="number"
            min={1}
            max={maxQuantity}
            step={1}
            value={quantity}
            onChange={event => {
              setQuantity(event.target.value.slice(0, 2))
              setMessage(null)
            }}
            disabled={busy}
            className="input-well mt-2 min-h-[44px] w-28 px-3 text-sm tabular-nums"
          />
          <p className="mt-1 text-xs text-smoke-500">Up to {maxQuantity} per transaction and no more than current inventory.</p>
        </label>
      </div>
      {message && !review ? <p role="alert" className="mt-4 rounded-lg bg-error-50 px-3.5 py-2.5 text-xs text-error-700">{message}</p> : null}
      {review || phase === 'checking' ? (
        <TxConfirmDialog
          open
          preparing={!review}
          title={tx.phase === 'success' ? 'Items minted' : settled ? 'Mint submitted' : 'Confirm mint'}
          rows={
            review
              ? [
                  { label: 'Item', value: `${review.quantity} × ${itemName}`, strong: true },
                  { label: 'Beneficiary', value: review.beneficiary, mono: true },
                  { label: 'On', value: chainName(chainId) },
                  ...(tx.hash ? [{ label: 'Transaction', value: tx.hash, mono: true }] : []),
                ]
              : []
          }
          steps={review ? [{ title: `Mint ${review.quantity} × ${itemName}` }] : []}
          activeIndex={busy ? 0 : -1}
          action={busy ? 'Checking & minting…' : 'Mint without payment'}
          onConfirm={() => void handleConfirm()}
          busy={busy}
          complete={settled}
          status={!review ? 'Checking your mint permission…' : tx.notice ?? undefined}
          error={tx.error ?? message}
          onClose={() => {
            if (settled) {
              onClose()
              return
            }
            setReview(null)
            setPhase('form')
            setMessage(null)
            tx.reset()
          }}
        >
          {settled || !review ? null : (
            <div className="callout callout-warning text-xs">
              This free mint consumes {review.quantity} item{review.quantity === 1 ? '' : 's'} of inventory, collects no payment, and cannot be undone.
            </div>
          )}
        </TxConfirmDialog>
      ) : null}
    </ModalShell>
  )
}

async function assertMintReady(
  client: PublicClient,
  {
    chainId,
    projectId,
    hook,
    account,
    tierId,
    quantity,
    isRevnet,
  }: {
    chainId: JBChainId
    projectId: number
    hook: Address
    account: Address
    tierId: number
    quantity: number
    isRevnet: boolean
  },
) {
  const liveShop = await getProjectNftInventory(client, {
    chainId,
    projectId: BigInt(projectId),
    isRevnet,
    tierLimit: 1,
  })
  if (liveShop?.protocol === 'defifa') throw new Error('Use the collection’s native NFT checkout.')
  if (!liveShop || liveShop.hook.toLowerCase() !== hook.toLowerCase()) {
    throw new Error('The project’s live shop hook changed. Review the mint again.')
  }

  const owner = await client.readContract({
    address: hook,
    abi: jb721TiersHookAbi,
    functionName: 'owner',
  })
  if (owner.toLowerCase() !== account.toLowerCase()) {
    const allowed = await hasPermissions(client, {
      chainId,
      operator: account,
      account: owner,
      projectId: BigInt(projectId),
      permissionIds: [JBPermissionIdsV6.MINT_721],
    })
    if (!allowed) {
      throw new Error(
        `This wallet cannot mint shop items on ${chainName(chainId)}.`,
      )
    }
  }

  const store = await client.readContract({
    address: hook,
    abi: jb721TiersHookAbi,
    functionName: 'STORE',
  })
  const liveTier = await client.readContract({
    address: store,
    abi: jb721TiersHookStoreAbi,
    functionName: 'tierOf',
    args: [hook, BigInt(tierId), false],
  })
  if (Number(liveTier.id) !== tierId || !liveTier.flags.allowOwnerMint) {
    throw new Error('This item does not allow owner/operator free mints.')
  }
  if (Number(liveTier.remainingSupply) < quantity) {
    throw new Error(
      `Only ${liveTier.remainingSupply.toString()} item${liveTier.remainingSupply === 1 ? '' : 's'} remain on ${chainName(chainId)}.`,
    )
  }
}
