'use client'

import {
  jb721TiersHookAbi,
  jb721TiersHookStoreAbi,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import {
  getProject721Shop,
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
import { useConfig, useSwitchChain, useWriteContract } from 'wagmi'
import {
  getAccount,
  getPublicClient,
} from 'wagmi/actions'
import { ModalShell } from '@/components/ui/ModalShell'
import { useWallet } from '@/hooks/useWallet'
import { submitReviewedContractWrite } from '@/lib/contract-write'
import { gasWithHeadroom } from '@/lib/gas'
import {
  isTransactionReceiptUnavailableError,
  waitForTrackedReceipt,
} from '@/lib/receipt'
import { shortError } from '@/lib/errors'
import {
  isSafeConnection,
  SAFE_NONCE_GUIDANCE,
  waitForSafeExecutionHash,
} from '@/lib/safe-connector'
import { buildMint721TierRequest } from '@/lib/transaction-builders'
import { requireContractTransactionReview } from '@/lib/transaction-review'
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
  const { switchChainAsync } = useSwitchChain()
  const { writeContractAsync } = useWriteContract()
  const { isConnected, address, openSignIn } = useWallet()
  const [beneficiary, setBeneficiary] = useState(address ?? '')
  const [quantity, setQuantity] = useState('1')
  const [review, setReview] = useState<MintReview | null>(null)
  const [phase, setPhase] = useState<
    'form' | 'checking' | 'review' | 'sending' | 'confirming' | 'uncertain' | 'done'
  >('form')
  const [message, setMessage] = useState<string | null>(null)
  const [hash, setHash] = useState<`0x${string}` | null>(null)

  const busy = ['checking', 'sending', 'confirming'].includes(phase)
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
    try {
      setPhase('checking')
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
        quantity: review.quantity,
        isRevnet,
      })

      const request = buildMint721TierRequest({
        chainId,
        hook,
        tierIds: Array.from({ length: review.quantity }, () => tierId),
        beneficiary: review.beneficiary,
      })
      setPhase('sending')
      let submitted = await submitReviewedContractWrite({
        request,
        expectedAccount: address,
        review: reviewed =>
          requireContractTransactionReview(
            { ...reviewed, account: address },
            {
              title: `Review free mint on ${chainName(chainId)}`,
              label: `Mint ${review.quantity} × ${itemName}`,
              contractName: 'JB721TiersHook',
              description: isSafeConnection(config)
                ? SAFE_NONCE_GUIDANCE
                : 'This consumes shop inventory and collects no payment. It cannot be undone.',
              ...(isSafeConnection(config)
                ? { confirmLabel: 'Agree & continue to Safe' }
                : {}),
            },
          ),
        switchChain: reviewedChainId =>
          switchChainAsync({ chainId: reviewedChainId as SupportedChainId }),
        currentAccount: () => getAccount(config).address,
        reverify: () =>
          assertMintReady(client, {
            chainId,
            projectId,
            hook,
            account: address,
            tierId,
            quantity: review.quantity,
            isRevnet,
          }),
        simulate: async reviewed => {
          const simulationRequest = {
            ...reviewed,
            account: address,
          }
          const [{ request: simulated }, estimate] = await Promise.all([
            client.simulateContract(simulationRequest),
            client.estimateContractGas(simulationRequest),
          ])
          return { ...simulated, gas: gasWithHeadroom(estimate) }
        },
        write: simulated =>
          writeContractAsync(
            simulated as Parameters<typeof writeContractAsync>[0],
          ),
        accountChangedError:
          'Connected account changed. Review the free mint again.',
      })
      setHash(submitted)
      setPhase('confirming')
      if (isSafeConnection(config)) {
        submitted = await waitForSafeExecutionHash(chainId, submitted)
        setHash(submitted)
      }
      const receipt = await waitForTrackedReceipt(client, submitted)
      if (receipt.status !== 'success') throw new Error('The mint failed.')

      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ['shop721', chainId, projectId, isRevnet],
        }),
        queryClient.invalidateQueries({
          queryKey: ['shopTierSupply'],
        }),
      ])
      setPhase('done')
    } catch (error) {
      setMessage(shortError(error, 'Could not mint this item.'))
      setPhase(isTransactionReceiptUnavailableError(error) ? 'uncertain' : review ? 'review' : 'form')
    }
  }

  const footer = phase === 'done' || phase === 'uncertain' ? (
    <button type="button" onClick={onClose} className="btn-primary min-h-[44px] px-5 text-sm">
      {phase === 'done' ? 'Done' : 'Close'}
    </button>
  ) : review ? (
    <div className="flex justify-end gap-2">
      <button
        type="button"
        onClick={() => {
          setReview(null)
          setPhase('form')
          setMessage(null)
        }}
        disabled={busy}
        className="btn-secondary min-h-[44px] px-5 text-sm"
      >
        Back
      </button>
      <button
        type="button"
        onClick={() => void handleConfirm()}
        disabled={busy}
        className="btn-primary min-h-[44px] px-5 text-sm"
      >
        {busy ? 'Checking & minting…' : 'Mint without payment'}
      </button>
    </div>
  ) : (
    <div className="flex justify-end gap-2">
      <button type="button" onClick={onClose} disabled={busy} className="btn-secondary min-h-[44px] px-5 text-sm">
        Cancel
      </button>
      <button type="button" onClick={() => void handleReview()} disabled={busy || maxQuantity === 0} className="btn-primary min-h-[44px] px-5 text-sm">
        {!isConnected ? 'Sign in to continue' : busy ? 'Checking permission…' : 'Review mint'}
      </button>
    </div>
  )

  return (
    <ModalShell
      title={`Mint ${itemName}`}
      subtitle={`Send inventory from item #${tierId} on ${chainName(chainId)} without collecting payment.`}
      footer={footer}
      onClose={onClose}
      busy={busy}
    >
      {phase === 'done' ? (
        <div className="py-8 text-center">
          <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-melon-100 text-xl text-melon-700">✓</span>
          <h3 className="mt-4 font-agrandir text-lg font-medium text-ink">Items minted</h3>
          <p className="mt-2 text-sm text-smoke-700">
            {review?.quantity} × {itemName} sent to {review?.beneficiary}.
          </p>
          {hash ? <p className="mt-2 break-all font-mono text-xs text-smoke-500">{hash}</p> : null}
        </div>
      ) : phase === 'uncertain' ? (
        <div className="callout callout-info text-sm">
          The mint was submitted. Its confirmation could not be read, so this form will not submit it again. Check the transaction before minting more inventory.
          {hash ? <p className="mt-2 break-all font-mono text-xs">{hash}</p> : null}
        </div>
      ) : review ? (
        <div className="space-y-4">
          <div className="callout callout-warning text-xs">
            This free mint consumes {review.quantity} item{review.quantity === 1 ? '' : 's'} of inventory, collects no payment, and cannot be undone.
          </div>
          <dl className="space-y-2 rounded-xl border border-smoke-200 bg-white p-4 text-sm">
            <ReviewRow label="Item" value={`${review.quantity} × ${itemName}`} />
            <ReviewRow label="Beneficiary" value={review.beneficiary} mono />
            <ReviewRow label="Chain" value={chainName(chainId)} />
          </dl>
        </div>
      ) : (
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
      )}
      {message ? <p role="alert" className="mt-4 rounded-lg bg-error-50 px-3.5 py-2.5 text-xs text-error-700">{message}</p> : null}
    </ModalShell>
  )
}

function ReviewRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <dt className="text-smoke-600">{label}</dt>
      <dd className={`break-all text-right text-ink ${mono ? 'font-mono text-xs' : 'font-medium'}`}>{value}</dd>
    </div>
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
  const liveShop = await getProject721Shop(client, {
    chainId,
    projectId: BigInt(projectId),
    isRevnet,
    tierLimit: 0,
  })
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
