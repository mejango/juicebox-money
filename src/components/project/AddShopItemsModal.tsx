'use client'

import {
  jb721TiersHookAbi,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import {
  hasPermissions,
  JBPermissionIdsV6,
} from '@bananapus/nana-sdk-core/v6'
import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { type Address, type PublicClient } from 'viem'
import { useConfig, useSwitchChain, useWriteContract } from 'wagmi'
import {
  getAccount,
  getPublicClient,
  waitForTransactionReceipt,
} from 'wagmi/actions'
import { ChainIcon } from '@/components/ChainIcon'
import { ChainPillButton } from '@/components/ui/ChainPillButton'
import {
  TransactionProgressImage,
  usePreloadTransactionAnimation,
} from '@/components/TransactionInProgress'
import {
  StoreEditor,
  itemOk,
  newDraftItem,
  type DraftItem,
  type StoreCategory,
} from '@/components/create/StoreEditor'
import { useWallet } from '@/hooks/useWallet'
import { submitReviewedContractWrite } from '@/lib/contract-write'
import {
  isSafeConnection,
  SAFE_NONCE_GUIDANCE,
  waitForSafeExecutionHash,
} from '@/lib/safe-connector'
import { shortError } from '@/lib/errors'
import { build721TierConfigs } from '@/lib/launch'
import {
  pinStoreItemDrafts,
  storeItemsForChain,
  type PinnedStoreItemDraft,
} from '@/lib/store-items'
import { chainName } from '@/lib/urn'
import { buildAdjustTiersRequest } from '@/lib/transaction-builders'
import { requireContractTransactionReview } from '@/lib/transaction-review'
import { SUPPORTED_CHAINS } from '@/providers/Providers'

type SupportedChainId = (typeof SUPPORTED_CHAINS)[number]['id']

export type ShopWriteTarget = {
  chainId: JBChainId
  projectId: number
  hook: Address | null
  pricing: { currency: number; decimals: number; symbol: string } | null
  error?: string
}

type ChainStatus = {
  phase:
    | 'pending'
    | 'signing'
    | 'confirming'
    | 'uncertain'
    | 'done'
    | 'failed'
  hash?: `0x${string}`
  safeProposalHash?: `0x${string}`
  error?: string
}

type Review = {
  account: Address
  items: DraftItem[]
  categories: StoreCategory[]
  chainIds: JBChainId[]
}

export function AddShopItemsModal({
  targets,
  activePricing,
  existingCategories,
  isRevnet,
  onClose,
}: {
  targets: ShopWriteTarget[]
  activePricing: { currency: number; decimals: number; symbol: string }
  existingCategories: StoreCategory[]
  isRevnet: boolean
  onClose: () => void
}) {
  usePreloadTransactionAnimation()
  const config = useConfig()
  const queryClient = useQueryClient()
  const { switchChainAsync } = useSwitchChain()
  const { writeContractAsync } = useWriteContract()
  const { isConnected, address, openSignIn } = useWallet()

  const compatibleTargets = useMemo(
    () =>
      targets.filter(
        target =>
          target.hook &&
          target.pricing &&
          target.pricing.currency === activePricing.currency &&
          target.pricing.decimals === activePricing.decimals,
      ),
    [targets, activePricing.currency, activePricing.decimals],
  )
  const [selected, setSelected] = useState<JBChainId[]>(() =>
    compatibleTargets.map(target => target.chainId),
  )
  const [items, setItems] = useState<DraftItem[]>(() => [newDraftItem()])
  const [categories, setCategories] = useState<StoreCategory[]>(() =>
    existingCategories.filter(category => category.id !== 0),
  )
  const [review, setReview] = useState<Review | null>(null)
  const [phase, setPhase] = useState<
    'form' | 'checking' | 'review' | 'pinning' | 'writing' | 'failed' | 'done'
  >('form')
  const [message, setMessage] = useState<string | null>(null)
  const [statuses, setStatuses] = useState<Record<number, ChainStatus>>({})
  const statusesRef = useRef<Record<number, ChainStatus>>({})
  const pinnedRef = useRef<PinnedStoreItemDraft[] | null>(null)

  const busy =
    phase === 'checking' || phase === 'pinning' || phase === 'writing'
  const hasSubmittedTransactions = Object.values(statuses).some(
    status => status.phase === 'done' || Boolean(status.hash),
  )
  const hasUncertainTransactions = Object.values(statuses).some(
    status => status.phase === 'uncertain',
  )

  const close = useCallback(() => {
    if (busy) return
    if (
      phase !== 'done' &&
      hasSubmittedTransactions &&
      !window.confirm(
        'Some transactions are already submitted. Closing now discards the status checklist. Close anyway?',
      )
    ) {
      return
    }
    for (const item of items) {
      if (item.mediaPreview) URL.revokeObjectURL(item.mediaPreview)
    }
    onClose()
  }, [busy, hasSubmittedTransactions, items, onClose, phase])

  useEffect(() => {
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.body.style.overflow = previous
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [close])

  const updateStatus = (chainId: number, patch: Partial<ChainStatus>) => {
    const next = {
      ...statusesRef.current,
      [chainId]: {
        ...(statusesRef.current[chainId] ?? { phase: 'pending' as const }),
        ...patch,
      },
    }
    statusesRef.current = next
    setStatuses(next)
  }

  const toggleChain = (chainId: JBChainId) => {
    if (busy || review) return
    setSelected(current =>
      current.includes(chainId)
        ? current.filter(id => id !== chainId)
        : [...current, chainId].sort((a, b) => a - b),
    )
    setMessage(null)
  }

  const handleReview = async () => {
    if (!isConnected || !address) {
      openSignIn()
      return
    }
    setMessage(null)
    if (selected.length === 0) {
      setMessage('Select at least one chain.')
      return
    }
    if (items.length === 0) {
      setMessage('Add at least one item.')
      return
    }
    const invalidIndex = items.findIndex(item => !itemOk(item))
    if (invalidIndex >= 0) {
      setMessage(`Finish the required fields for item ${invalidIndex + 1}.`)
      return
    }
    const badReserve = items.findIndex(
      item =>
        item.reserveN.trim() !== '' &&
        selected.some(chainId => {
          const quantity =
            item.perChainSupply[chainId]?.trim() || item.supply.trim()
          return quantity === '1'
        }),
    )
    if (badReserve >= 0) {
      setMessage(
        `Item ${badReserve + 1} needs at least 2 items on every chain when inventory is reserved.`,
      )
      return
    }

    setPhase('checking')
    try {
      const selectedTargets = compatibleTargets.filter(target =>
        selected.includes(target.chainId),
      )
      await assertAuthorityAcrossTargets(
        config,
        selectedTargets,
        address,
      )
      const frozenItems = items.map(cloneDraftItem)
      const frozenCategories = categories.map(category => ({ ...category }))
      const nextStatuses = Object.fromEntries(
        selected.map(chainId => [chainId, { phase: 'pending' as const }]),
      )
      statusesRef.current = nextStatuses
      setStatuses(nextStatuses)
      setReview({
        account: address,
        items: frozenItems,
        categories: frozenCategories,
        chainIds: [...selected],
      })
      setPhase('review')
    } catch (error) {
      setMessage(shortError(error, 'Could not add the items.'))
      setPhase('form')
    }
  }

  const handleConfirm = async () => {
    if (!review || !address || busy) return
    if (review.account.toLowerCase() !== address.toLowerCase()) {
      setMessage('Your connected account changed — review the items again.')
      setReview(null)
      pinnedRef.current = null
      setPhase('form')
      return
    }

    const selectedTargets = compatibleTargets.filter(target =>
      review.chainIds.includes(target.chainId),
    )
    setMessage(null)
    let activeTarget: ShopWriteTarget | undefined
    let activeHash: `0x${string}` | undefined

    try {
      // Re-check every live role immediately before any irreversible work.
      setPhase('checking')
      await assertAuthorityAcrossTargets(
        config,
        selectedTargets,
        address,
      )

      if (!pinnedRef.current) {
        setPhase('pinning')
        pinnedRef.current = await pinStoreItemDrafts(
          review.items,
          review.categories,
          setMessage,
        )
      }

      setPhase('writing')
      for (const target of selectedTargets) {
        if (statusesRef.current[target.chainId]?.phase === 'done') continue
        activeTarget = target
        const chainId = target.chainId as SupportedChainId
        const client = getPublicClient(config, { chainId }) as PublicClient
        if (!client || !target.hook || !target.pricing) {
          throw new Error(`${chainName(target.chainId)} is not ready.`)
        }

        let hash = statusesRef.current[target.chainId]?.hash
        if (hash) {
          const safeProposalHash =
            statusesRef.current[target.chainId]?.safeProposalHash
          activeHash = hash
          updateStatus(target.chainId, {
            phase: 'confirming',
            error: undefined,
          })
          setMessage(
            `Checking the submitted transaction on ${chainName(target.chainId)}…`,
          )
          if (safeProposalHash) {
            hash = await waitForSafeExecutionHash(chainId, safeProposalHash)
            activeHash = hash
            updateStatus(target.chainId, {
              phase: 'confirming',
              hash,
              safeProposalHash: undefined,
            })
          }
        } else {
          updateStatus(target.chainId, {
            phase: 'signing',
            hash: undefined,
            error: undefined,
          })
          setMessage(`Confirm the items on ${chainName(target.chainId)}…`)
          await assertAuthority(client, target, address)

          const storeItems = storeItemsForChain(
            pinnedRef.current,
            target.pricing.decimals,
            target.chainId,
          )
          const tiers = build721TierConfigs(storeItems, target.chainId)
          const request = buildAdjustTiersRequest({
            chainId,
            hook: target.hook,
            tiers,
          })
          hash = await submitReviewedContractWrite({
            request,
            expectedAccount: address,
            review: reviewed =>
              requireContractTransactionReview(
                { ...reviewed, account: address },
                {
                  title: `Review shop items on ${chainName(target.chainId)}`,
                  label: 'Add shop items',
                  contractName: 'JB721TiersHook',
                  ...(isSafeConnection(config)
                    ? {
                        description: SAFE_NONCE_GUIDANCE,
                        confirmLabel: 'Agree & continue to Safe',
                      }
                    : {}),
                },
              ),
            switchChain: reviewedChainId =>
              switchChainAsync({ chainId: reviewedChainId as SupportedChainId }),
            currentAccount: () => getAccount(config).address,
            simulate: async reviewed => {
              const { request: simulated } = await client.simulateContract({
                ...reviewed,
                account: address,
              })
              return simulated
            },
            // wagmi's generated union cannot retain tuple inference after a
            // runtime chain switch, but this is the exact simulated request.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            write: simulated => writeContractAsync(simulated as any),
            accountChangedError:
              'Connected account changed. Review the shop items again.',
          })
          activeHash = hash
          updateStatus(target.chainId, { phase: 'confirming', hash })
          if (isSafeConnection(config)) {
            updateStatus(target.chainId, {
              phase: 'confirming',
              hash,
              safeProposalHash: hash,
            })
            hash = await waitForSafeExecutionHash(chainId, hash)
            activeHash = hash
            updateStatus(target.chainId, {
              phase: 'confirming',
              hash,
              safeProposalHash: undefined,
            })
          }
        }

        const receipt = await waitForTransactionReceipt(config, {
          chainId,
          hash,
        })
        if (receipt.status !== 'success') {
          updateStatus(target.chainId, {
            phase: 'failed',
            hash: undefined,
            error: `The transaction failed on ${chainName(chainId)}.`,
          })
          activeHash = undefined
          throw new Error(`The transaction failed on ${chainName(chainId)}.`)
        }
        updateStatus(target.chainId, { phase: 'done', hash })
        activeHash = undefined
        activeTarget = undefined

        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: [
              'shop721',
              target.chainId,
              target.projectId,
              isRevnet,
            ],
          }),
          queryClient.invalidateQueries({
            queryKey: ['shop721Media', target.chainId, target.hook],
          }),
        ])
      }

      setMessage(
        `${review.items.length} item${review.items.length === 1 ? '' : 's'} added on ${selectedTargets.length} chain${selectedTargets.length === 1 ? '' : 's'}.`,
      )
      setPhase('done')
    } catch (error) {
      const errorMessage = shortError(error, 'Could not add the items.')
      if (activeTarget) {
        const current = statusesRef.current[activeTarget.chainId]
        if (current?.phase !== 'failed') {
          const submittedHash = current?.hash ?? activeHash
          if (submittedHash) {
            updateStatus(activeTarget.chainId, {
              phase: 'uncertain',
              hash: submittedHash,
              error: errorMessage,
            })
            setMessage(
              `The transaction was submitted on ${chainName(activeTarget.chainId)}, but its status could not be confirmed. Checking again will not send another transaction.`,
            )
          } else {
            updateStatus(activeTarget.chainId, {
              phase: 'failed',
              error: errorMessage,
            })
            setMessage(errorMessage)
          }
        } else {
          setMessage(errorMessage)
        }
      } else {
        setMessage(errorMessage)
      }
      setPhase('failed')
    }
  }

  const backToForm = () => {
    if (busy || hasSubmittedTransactions) return
    setReview(null)
    pinnedRef.current = null
    statusesRef.current = {}
    setStatuses({})
    setMessage(null)
    setPhase('form')
  }

  return (
    <div
      className="fixed inset-0 z-[80] flex items-start justify-center overflow-y-auto bg-slate-950/55 px-3 py-5 sm:px-6 sm:py-10"
      role="dialog"
      aria-modal="true"
      aria-labelledby="add-shop-items-title"
      onMouseDown={event => {
        if (event.target === event.currentTarget) close()
      }}
    >
      <div className="card w-full max-w-2xl overflow-hidden shadow-[0_24px_72px_rgba(19,17,25,0.28)]">
        <div className="flex items-start justify-between gap-4 border-b border-smoke-200 px-5 py-4 sm:px-6">
          <div>
            <h2
              id="add-shop-items-title"
              className="font-agrandir text-xl font-medium text-ink"
            >
              Add items for sale
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-smoke-700">
              Stage one or more items, then add them to the collection.
            </p>
          </div>
          <button
            type="button"
            onClick={close}
            disabled={busy}
            aria-label="Close"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-xl text-smoke-700 hover:bg-smoke-75 hover:text-ink disabled:opacity-50"
          >
            ×
          </button>
        </div>

        <div className="max-h-[calc(100vh-10rem)] overflow-y-auto px-5 py-5 sm:px-6">
          {!review ? (
            <>
              <div className="callout callout-info text-xs">
                {isConnected
                  ? 'Your wallet will be checked as this shop’s owner or authorized manager before anything is pinned or sent.'
                  : 'Sign in with the shop owner or an authorized manager wallet to add items.'}
              </div>

              <StoreEditor
                items={items}
                onChange={next => {
                  setItems(next)
                  setMessage(null)
                }}
                currencyLabel={activePricing.symbol}
                disabled={busy}
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

              <div className="mt-6 border-t border-smoke-200 pt-5">
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
                      target.pricing.currency === activePricing.currency &&
                      target.pricing.decimals === activePricing.decimals
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
                        disabled={!compatible || busy}
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
            </>
          ) : phase === 'done' ? (
            <div className="py-8 text-center">
              <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-melon-100 text-xl text-melon-700">
                ✓
              </span>
              <h3 className="mt-4 font-agrandir text-lg font-medium text-ink">
                Items added
              </h3>
              <p className="mt-2 text-sm text-smoke-700">{message}</p>
            </div>
          ) : (
            <>
              <div className="rounded-xl border border-smoke-200 bg-smoke-25 p-4">
                <span className="field-label">
                  Items to add ({review.items.length})
                </span>
                <div className="mt-2 divide-y divide-smoke-200">
                  {review.items.map((item, index) => (
                    <div
                      key={item.id}
                      className="flex items-center justify-between gap-3 py-2.5 text-sm"
                    >
                      <span className="min-w-0 truncate font-medium text-ink">
                        {index + 1}. {item.name.trim()}
                      </span>
                      <span className="shrink-0 text-smoke-700">
                        {item.price} {activePricing.symbol}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="mt-4 rounded-xl border border-smoke-200 bg-white p-4">
                <span className="field-label">Transactions</span>
                <div className="mt-2 space-y-2">
                  {review.chainIds.map(chainId => {
                    const status = statuses[chainId]?.phase ?? 'pending'
                    return (
                      <div
                        key={chainId}
                        className="flex items-center justify-between gap-3 text-sm"
                      >
                        <span className="flex items-center gap-2 font-medium text-ink">
                          <ChainIcon chainId={chainId} size={24} />
                          {chainName(chainId)}
                        </span>
                        <span
                          className={`flex items-center gap-2 ${
                            status === 'done'
                              ? 'text-melon-700'
                              : status === 'uncertain'
                                ? 'text-split-700'
                              : status === 'failed'
                                ? 'text-error-600'
                                : 'text-smoke-700'
                          }`}
                        >
                          {status === 'signing' || status === 'confirming' ? (
                            <TransactionProgressImage className="h-8 w-8" />
                          ) : null}
                          {chainStatusLabel(status)}
                        </span>
                      </div>
                    )
                  })}
                </div>
              </div>
            </>
          )}

          {message && phase !== 'done' ? (
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
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-smoke-200 px-5 py-4 sm:px-6">
          {phase === 'done' ? (
            <button type="button" onClick={close} className="btn-primary min-h-[44px] px-5 text-sm">
              Done
            </button>
          ) : review ? (
            <>
              {!hasSubmittedTransactions ? (
                <button
                  type="button"
                  onClick={backToForm}
                  disabled={busy}
                  className="btn-secondary min-h-[44px] px-5 text-sm"
                >
                  Back
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => void handleConfirm()}
                disabled={busy}
                className="btn-primary min-h-[44px] px-5 text-sm"
              >
                {phase === 'checking'
                  ? 'Checking permissions…'
                  : phase === 'pinning'
                    ? 'Saving items…'
                    : phase === 'writing'
                      ? 'Adding items…'
                      : phase === 'failed'
                        ? hasUncertainTransactions
                          ? 'Check submitted transactions'
                          : 'Retry unfinished chains'
                        : 'Add items for sale'}
              </button>
            </>
          ) : (
            <>
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
                disabled={busy}
                className="btn-primary min-h-[44px] px-5 text-sm"
              >
                {!isConnected
                  ? 'Sign in to continue'
                  : phase === 'checking'
                    ? 'Checking permissions…'
                    : 'Review items'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

async function assertAuthorityAcrossTargets(
  config: ReturnType<typeof useConfig>,
  targets: ShopWriteTarget[],
  account: Address,
) {
  for (const target of targets) {
    const client = getPublicClient(config, {
      chainId: target.chainId as SupportedChainId,
    }) as PublicClient
    if (!client) throw new Error(`${chainName(target.chainId)} is unavailable.`)
    await assertAuthority(client, target, account)
  }
}

async function assertAuthority(
  client: PublicClient,
  target: ShopWriteTarget,
  account: Address,
) {
  if (!target.hook) {
    throw new Error(`The shop on ${chainName(target.chainId)} is unavailable.`)
  }

  const owner = await client.readContract({
    address: target.hook,
    abi: jb721TiersHookAbi,
    functionName: 'owner',
    args: [],
  })
  if (owner.toLowerCase() === account.toLowerCase()) return

  const allowed = await hasPermissions(client, {
    chainId: target.chainId,
    operator: account,
    account: owner,
    projectId: BigInt(target.projectId),
    permissionIds: [JBPermissionIdsV6.ADJUST_721_TIERS],
  })
  if (!allowed) {
    throw new Error(
      `This wallet cannot manage the shop on ${chainName(target.chainId)}.`,
    )
  }
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

function chainStatusLabel(status: ChainStatus['phase']) {
  if (status === 'signing') return 'Confirm in wallet'
  if (status === 'confirming') return 'Confirming…'
  if (status === 'uncertain') return 'Submitted — status unknown'
  if (status === 'done') return 'Added'
  if (status === 'failed') return 'Needs retry'
  return 'Ready'
}
