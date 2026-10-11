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
  encodeFunctionData,
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
import { TxConfirmDialog } from '@/components/ui/TxConfirmDialog'
import { useUnmountSignal } from '@/hooks/useUnmountSignal'
import { useWallet } from '@/hooks/useWallet'
import { submitReviewedContractWrite } from '@/lib/contract-write'
import { captureWalletContext } from '@/lib/wallet-context'
import {
  gasWithHeadroom,
  isTransactionReceiptUnavailableError,
  waitForTrackedReceipt,
} from '@bananapus/nana-sdk-core/review'
import { shortError } from '@/lib/errors'
import {
  isSafeConnection,
  readSafeAppExecution,
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
  // Closing the modal ends its wait for a Safe to execute the mint.
  const modalSignal = useUnmountSignal()
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
      const assertOriginalWallet = captureWalletContext(config, { account: address, chainId })
      const viaSafe = isSafeConnection(config)
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
      // Read once: the review, the sent gas and the tracking must agree on
      // whether a Safe proposes this mint.
      let submitted = await submitReviewedContractWrite({
        request,
        expectedAccount: address,
        review: reviewed =>
          requireContractTransactionReview(
            {
              ...reviewed,
              account: address,
              // A Safe app signs the sent gas as safeTxGas; 0 makes a failed call revert.
              ...(viaSafe ? { safeTxGas: 0n } : {}),
            },
            {
              title: `Review free mint on ${chainName(chainId)}`,
              label: `Mint ${review.quantity} × ${itemName}`,
              contractName: 'JB721TiersHook',
              description: viaSafe
                ? SAFE_NONCE_GUIDANCE
                : 'This consumes shop inventory and collects no payment. It cannot be undone.',
              ...(viaSafe
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
          return {
            ...simulated,
            chainId: reviewed.chainId,
            gas: viaSafe ? 0n : gasWithHeadroom(estimate),
          }
        },
        beforeSend: () => {
          assertOriginalWallet()
          if (isSafeConnection(config) !== viaSafe) {
            throw new Error('Wallet connection changed. Review the transaction again.')
          }
        },
        write: simulated => writeContractAsync(
          simulated as Parameters<typeof writeContractAsync>[0],
        ),
        accountChangedError:
          'Connected account changed. Review the free mint again.',
      })
      setHash(submitted)
      setPhase('confirming')
      const proposal = viaSafe ? submitted : null
      if (proposal) {
        try {
          submitted = await waitForSafeExecutionHash(chainId, proposal, { signal: modalSignal() })
        } catch {
          // The Safe may still execute it: the mint stays submitted, never
          // offered again from this form.
          setPhase('uncertain')
          return
        }
        setHash(submitted)
      }
      const receipt = await waitForTrackedReceipt(client, submitted)
      if (receipt.status !== 'success') throw new Error('The mint failed.')
      if (proposal) {
        // Only the Safe's ExecutionSuccess for this proposal confirms the
        // mint. A receipt without it may still have minted, so the form will
        // not submit it again.
        const { status: outcome } = await readSafeAppExecution({
          client,
          receipt,
          safe: address,
          proposalHash: proposal,
          calls: [{ to: request.address, data: encodeFunctionData(request) }],
        })
        if (outcome === 'unproven') {
          setPhase('uncertain')
          return
        }
        if (outcome !== 'success') throw new Error('The mint failed.')
      }

      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: shop721QueryKey(chainId, projectId, isRevnet),
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

  const settled = phase === 'done' || phase === 'uncertain'
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
          title={phase === 'done' ? 'Items minted' : phase === 'uncertain' ? 'Mint submitted' : 'Confirm mint'}
          rows={
            review
              ? [
                  { label: 'Item', value: `${review.quantity} × ${itemName}`, strong: true },
                  { label: 'Beneficiary', value: review.beneficiary, mono: true },
                  { label: 'On', value: chainName(chainId) },
                  ...(hash ? [{ label: 'Transaction', value: hash, mono: true }] : []),
                ]
              : []
          }
          steps={review ? [{ title: `Mint ${review.quantity} × ${itemName}` }] : []}
          activeIndex={busy ? 0 : -1}
          action={busy ? 'Checking & minting…' : 'Mint without payment'}
          onConfirm={() => void handleConfirm()}
          busy={busy}
          complete={settled}
          status={
            !review
              ? 'Checking your mint permission…'
              : phase === 'uncertain'
                ? 'The mint was submitted. Its confirmation could not be read, so this form will not submit it again. Check the transaction before minting more inventory.'
                : undefined
          }
          error={phase === 'uncertain' ? undefined : message}
          onClose={() => {
            if (settled) {
              onClose()
              return
            }
            setReview(null)
            setPhase('form')
            setMessage(null)
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
  if (liveShop?.protocol === 'defifa') throw new Error('Enter this market in Metalog.')
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
