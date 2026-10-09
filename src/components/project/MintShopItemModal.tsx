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
  encodeFunctionData,
  isAddress,
  zeroAddress,
  type Address,
  type Hex,
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
  createBrowserWriteRecovery,
  gasWithHeadroom,
  SubmittedWritePersistenceError,
  verifyReviewedWriteReceipt,
  waitForTrackedReceipt,
  type ReviewedWriteRecoveryRecord,
} from '@bananapus/nana-sdk-core/review'
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
  const [pending, setPending] = useState<ReviewedWriteRecoveryRecord | null>(null)

  const busy = ['checking', 'sending', 'confirming'].includes(phase)
  const maxQuantity = Math.max(0, Math.min(50, remaining))

  // The SDK owns the durable scope and release proof; this modal only follows it.
  const trackMint = async (
    recovery: ReturnType<typeof createBrowserWriteRecovery>,
    saved: ReviewedWriteRecoveryRecord,
    client: PublicClient,
    signal: AbortSignal,
  ) => {
    if (signal.aborted) return
    setPending(saved)
    setHash(saved.hash ?? null)
    if (!saved.hash) {
      setPhase('uncertain')
      return
    }
    setPhase('confirming')
    let outcome: 'success' | 'failed'
    try {
      // A recovered in-memory hash may still need to reach durable storage.
      const recorded = recovery.submitted(saved.hash, saved)
      const submitted = saved.safe
        ? await waitForSafeExecutionHash(chainId, saved.hash, { signal })
        : saved.hash
      signal.throwIfAborted()
      setHash(submitted)
      const receipt = await waitForTrackedReceipt(client, submitted)
      outcome = await verifyReviewedWriteReceipt(client, recorded, receipt)
      recovery.clear(recorded)
    } catch {
      if (!signal.aborted) setPhase('uncertain')
      return
    }
    if (signal.aborted) return
    setPending(null)
    if (outcome === 'failed') {
      setMessage('The mint failed.')
      setPhase(review ? 'review' : 'form')
      return
    }
    setPhase('done')
    await Promise.allSettled([
      queryClient.invalidateQueries({ queryKey: ['shop721', chainId, projectId, isRevnet] }),
      queryClient.invalidateQueries({ queryKey: ['shopTierSupply'] }),
    ])
  }

  const handleReview = async () => {
    if (busy || phase === 'done') return
    if (!isConnected || !address) {
      openSignIn()
      return
    }
    const signal = modalSignal()
    let saved: ReviewedWriteRecoveryRecord | null = null
    setPhase('checking')
    setMessage(null)
    try {
      const client = getPublicClient(config, {
        chainId: chainId as SupportedChainId,
      }) as PublicClient | undefined
      if (!client) throw new Error(`${chainName(chainId)} is unavailable.`)
      // Look up the action before checking current inventory or form values:
      // an earlier mint can consume inventory or have different arguments.
      const recovery = createBrowserWriteRecovery({
        chainId, account: address, safe: isSafeConnection(config),
        call: { to: hook, data: encodeFunctionData(buildMint721TierRequest({
          chainId, hook, tierIds: [tierId], beneficiary: address,
        })) },
      })
      saved = recovery.read()
      if (saved) {
        setReview(null)
        setPending(saved)
        setHash(saved.hash ?? null)
        await recovery.withLock(async () => {
          signal.throwIfAborted()
          const current = recovery.read()
          if (!current) throw new Error('The earlier mint changed. Check it again.')
          const known = pending?.hash && pending.id === current.id
            ? pending
            : current
          await trackMint(recovery, known, client, signal)
        })
        return
      }
      setPending(null)
      setHash(null)
      const normalizedBeneficiary = beneficiary.trim()
      const parsedQuantity = Number(quantity)
      if (!isAddress(normalizedBeneficiary) || normalizedBeneficiary.toLowerCase() === zeroAddress) {
        throw new Error('Enter a valid, non-zero beneficiary address.')
      }
      if (!Number.isSafeInteger(parsedQuantity) || parsedQuantity < 1 || parsedQuantity > maxQuantity) {
        throw new Error(`Choose between 1 and ${maxQuantity} items.`)
      }
      await assertMintReady(client, {
        chainId, projectId, hook, account: address, tierId,
        quantity: parsedQuantity, isRevnet,
      })
      signal.throwIfAborted()
      setReview({ account: address, beneficiary: normalizedBeneficiary, quantity: parsedQuantity })
      setPhase('review')
    } catch (error) {
      if (signal.aborted) return
      setMessage(shortError(error, 'This wallet cannot mint this item.'))
      setPhase(saved || pending ? 'uncertain' : 'form')
    }
  }

  const handleConfirm = async () => {
    if (!review || !address || phase !== 'review') return
    if (review.account.toLowerCase() !== address.toLowerCase()) {
      setReview(null)
      setPhase('form')
      setMessage('Your connected account changed. Review the mint again.')
      return
    }

    const signal = modalSignal()
    let reserved = false
    setMessage(null)
    try {
      setPhase('checking')
      const assertOriginalWallet = captureWalletContext(config, { account: address, chainId })
      const viaSafe = isSafeConnection(config)
      const client = getPublicClient(config, {
        chainId: chainId as SupportedChainId,
      }) as PublicClient | undefined
      if (!client) throw new Error(`${chainName(chainId)} is unavailable.`)
      const request = buildMint721TierRequest({
        chainId,
        hook,
        tierIds: Array.from({ length: review.quantity }, () => tierId),
        beneficiary: review.beneficiary,
      })
      const recovery = createBrowserWriteRecovery({
        chainId, account: address, safe: viaSafe,
        call: { to: request.address, data: encodeFunctionData(request) },
      })
      await recovery.withLock(async () => {
        signal.throwIfAborted()
        const saved = recovery.read()
        if (saved) {
          reserved = true
          setReview(null)
          await trackMint(recovery, saved, client, signal)
          return
        }
        setPending(null)
        setHash(null)
        await assertMintReady(client, {
          chainId, projectId, hook, account: address, tierId,
          quantity: review.quantity, isRevnet,
        })
        signal.throwIfAborted()
        setPhase('sending')
        // Read once: the review, the sent gas and the tracking must agree on
        // whether a Safe proposes this mint.
        await submitReviewedContractWrite({
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
          beforeWrite: () => {
            signal.throwIfAborted()
            const record = recovery.reserve()
            reserved = true
            setPending(record)
          },
          onBeforeWriteAborted: () => {
            recovery.rejected()
            reserved = false
            if (!signal.aborted) setPending(null)
          },
          onWriteRejected: () => {
            recovery.rejected()
            reserved = false
            if (!signal.aborted) setPending(null)
          },
          onWriteSubmitted: (submitted: Hex) => {
            // Keep the identity visible even if the subsequent storage write fails.
            if (!signal.aborted) setHash(submitted)
            try {
              const record = recovery.submitted(submitted)
              if (!signal.aborted) setPending(record)
            } catch (error) {
              if (!signal.aborted && error instanceof SubmittedWritePersistenceError) setPending(error.record)
              throw error
            }
          },
          beforeSend: () => {
            signal.throwIfAborted()
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
        const submitted = recovery.read()
        if (!submitted) throw new Error('Mint recovery is unavailable. Keep this action pending.')
        await trackMint(recovery, submitted, client, signal)
      })
    } catch (error) {
      if (signal.aborted) return
      setMessage(shortError(error, 'Could not mint this item.'))
      setPhase(reserved ? 'uncertain' : 'review')
    }
  }

  const settled = phase === 'done' || phase === 'uncertain'
  const footer = (
    <div className="flex justify-end gap-2">
      <button type="button" onClick={onClose} disabled={busy} className="btn-secondary min-h-[44px] px-5 text-sm">
        Cancel
      </button>
      <button type="button" onClick={() => void handleReview()} disabled={busy || phase === 'done'} className="btn-primary min-h-[44px] px-5 text-sm">
        {!isConnected ? 'Sign in to continue' : pending ? 'Check existing mint' : 'Mint without payment'}
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
      {review || pending || phase === 'checking' || phase === 'done' ? (
        <TxConfirmDialog
          open
          preparing={phase === 'checking' && !review && !pending}
          title={phase === 'done' ? 'Items minted' : phase === 'uncertain' ? hash ? 'Mint submitted' : 'Mint status unknown' : 'Confirm mint'}
          rows={
            review
              ? [
                  { label: 'Item', value: `${review.quantity} × ${itemName}`, strong: true },
                  { label: 'Beneficiary', value: review.beneficiary, mono: true },
                  { label: 'On', value: chainName(chainId) },
                  ...(hash ? [{ label: 'Transaction', value: hash, mono: true }] : []),
                ]
              : hash ? [{ label: 'Transaction', value: hash, mono: true }] : []
          }
          steps={review ? [{ title: `Mint ${review.quantity} × ${itemName}` }] : []}
          activeIndex={busy ? 0 : -1}
          action={busy ? 'Checking & minting…' : 'Mint without payment'}
          onConfirm={() => void handleConfirm()}
          busy={busy}
          complete={settled}
          status={
            phase === 'checking' && !review
              ? 'Checking your mint permission…'
              : phase === 'uncertain'
                ? hash
                  ? 'An earlier mint is awaiting confirmation. Check its transaction before minting more inventory.'
                  : 'The wallet may have submitted this mint without returning its transaction. This mint stays pending, including after reopening the page.'
                : undefined
          }
          error={phase === 'uncertain' ? undefined : message}
          onClose={() => {
            if (busy) return
            if (settled) {
              onClose()
              return
            }
            setReview(null)
            setPhase('form')
            setMessage(null)
          }}
        >
          {phase === 'uncertain' && pending?.hash ? (
            <button type="button" onClick={() => void handleReview()} className="btn-secondary min-h-[44px] px-5 text-sm">
              Check existing mint
            </button>
          ) : null}
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
