'use client'

import {
  JB_CHAINS,
  NATIVE_TOKEN,
  jb721TiersHookAbi,
  jbMultiTerminalAbi,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import {
  build721CashOutMetadata,
  getAccountingContexts,
  resolvePaymentTerminal,
} from '@bananapus/nana-sdk-core/v6'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  erc20Abi,
  zeroAddress,
  type Abi,
  type Address,
  type PublicClient,
} from 'viem'
import { useConfig } from 'wagmi'
import { getAccount, getPublicClient } from 'wagmi/actions'
import { ChainIcon } from '@/components/ChainIcon'
import { useSafeTx } from '@/hooks/useSafeTx'
import { useWallet } from '@/hooks/useWallet'
import {
  cashOutProtocolFee,
  quotedOutputFloor,
} from '@/lib/cashOut'
import { formatTokenAmount, truncateAddress } from '@/lib/format'
import { chainName } from '@/lib/urn'

export type RedeemableShopItem = {
  tokenId: string
  tierId: number
}

export type RedeemableShopTarget = {
  chainId: JBChainId
  projectId: number
  hook: Address
  idTarget: Address
  items: RedeemableShopItem[]
}

type ItemCashOutQuote = {
  chainId: JBChainId
  holder: Address
  terminal: Address
  token: Address
  decimals: number
  symbol: string
  gross: bigint
  net: bigint
  cashOutTaxRate: bigint
  metadata: `0x${string}`
  tokenIdsKey: string
}

const isFeelessForAbi = [
  {
    type: 'function',
    name: 'isFeelessFor',
    stateMutability: 'view',
    inputs: [
      { name: 'addr', type: 'address' },
      { name: 'projectId', type: 'uint256' },
      { name: 'caller', type: 'address' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const

export function RedeemShopItemsModal({
  targets,
  names,
  onClose,
}: {
  targets: RedeemableShopTarget[]
  names: Record<number, string>
  onClose: () => void
}) {
  const config = useConfig()
  const queryClient = useQueryClient()
  const { isConnected, address, openSignIn } = useWallet()
  const [selectedChainId, setSelectedChainId] = useState<JBChainId>(
    targets[0].chainId,
  )
  const target =
    targets.find(candidate => candidate.chainId === selectedChainId) ??
    targets[0]
  const targetItemsKey = target.items.map(item => item.tokenId).join(',')
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(target.items.map(item => item.tokenId)),
  )
  const [preparing, setPreparing] = useState(false)
  const [prepareError, setPrepareError] = useState<string | null>(null)
  const tx = useSafeTx(selectedChainId)

  useEffect(() => {
    setSelected(new Set(target.items.map(item => item.tokenId)))
    setPrepareError(null)
    tx.reset()
    // The joined key deliberately resets selection if ownership changes while
    // the modal is open without depending on a freshly allocated array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedChainId, targetItemsKey])

  const busy =
    preparing ||
    tx.phase === 'simulating' ||
    tx.phase === 'signing' ||
    tx.phase === 'pending'

  const close = useCallback(() => {
    if (!busy) onClose()
  }, [busy, onClose])

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

  const selectedItems = useMemo(
    () => target.items.filter(item => selected.has(item.tokenId)),
    [target.items, selected],
  )
  const selectedTokenIds = useMemo(
    () => selectedItems.map(item => BigInt(item.tokenId)),
    [selectedItems],
  )
  const tokenIdsKey = selectedTokenIds.map(String).join(',')

  const {
    data: quote,
    isFetching: quoteLoading,
    error: quoteError,
    refetch: refetchQuote,
  } = useQuery({
    queryKey: [
      'shop-item-cash-out-quote',
      selectedChainId,
      target.projectId,
      target.hook,
      address,
      tokenIdsKey,
    ],
    enabled: !!address && selectedTokenIds.length > 0,
    retry: false,
    staleTime: 0,
    queryFn: async (): Promise<ItemCashOutQuote> => {
      if (!address || selectedTokenIds.length === 0) {
        throw new Error('Select at least one item.')
      }
      const client = getPublicClient(config, {
        chainId: selectedChainId,
      }) as PublicClient | undefined
      if (!client) throw new Error('This chain is unavailable.')

      // The index is only a candidate set. Verify every selected NFT against
      // its collection immediately before trusting it in a quote.
      const owners = await client.multicall({
        allowFailure: true,
        contracts: selectedTokenIds.map(tokenId => ({
          address: target.hook,
          abi: jb721TiersHookAbi,
          functionName: 'ownerOf' as const,
          args: [tokenId] as const,
        })),
      })
      if (
        owners.some(
          result =>
            result.status !== 'success' ||
            String(result.result).toLowerCase() !== address.toLowerCase(),
        )
      ) {
        throw new Error(
          'Your item ownership changed. Close and reopen this redemption.',
        )
      }

      const contexts = await getAccountingContexts(client, {
        chainId: selectedChainId,
        projectId: BigInt(target.projectId),
      })
      const context = contexts[0]
      if (!context) throw new Error('No reclaim token is configured here.')
      const terminal = await resolvePaymentTerminal(client, {
        chainId: selectedChainId,
        projectId: BigInt(target.projectId),
        token: context.token,
      })
      if (terminal.isRouter) {
        throw new Error('No project cash-out terminal is available here.')
      }

      const metadata = build721CashOutMetadata({
        metadataIdTarget: target.idTarget,
        tokenIds: selectedTokenIds,
      })
      const [preview, feelessAddresses, feeFreeSurplus] = await Promise.all([
        client.readContract({
          address: terminal.address,
          abi: jbMultiTerminalAbi,
          functionName: 'previewCashOutFrom',
          args: [
            address,
            BigInt(target.projectId),
            0n,
            context.token,
            address,
            metadata,
          ],
        }),
        client
          .readContract({
            address: terminal.address,
            abi: jbMultiTerminalAbi,
            functionName: 'FEELESS_ADDRESSES',
          })
          .catch(() => null),
        client
          .readContract({
            address: terminal.address,
            abi: jbMultiTerminalAbi,
            functionName: 'feeFreeSurplusOf',
            args: [BigInt(target.projectId), context.token],
          })
          .catch(() => null),
      ])
      const gross = preview[1] ?? 0n
      const cashOutTaxRate = preview[2] ?? 0n
      const feeless =
        feelessAddresses && feelessAddresses !== zeroAddress
          ? await client
              .readContract({
                address: feelessAddresses,
                abi: isFeelessForAbi,
                functionName: 'isFeelessFor',
                args: [address, BigInt(target.projectId), address],
              })
              .catch(() => null)
          : null
      const fee = cashOutProtocolFee({
        reclaimAmount: gross,
        cashOutTaxRate,
        feeless,
        feeFreeSurplus,
      })
      const net = gross > fee ? gross - fee : 0n
      const native =
        context.token.toLowerCase() === NATIVE_TOKEN.toLowerCase()
      const symbol = native
        ? (JB_CHAINS[selectedChainId]?.nativeTokenSymbol ?? 'ETH')
        : await client
            .readContract({
              address: context.token,
              abi: erc20Abi,
              functionName: 'symbol',
            })
            .catch(() => truncateAddress(context.token))

      return {
        chainId: selectedChainId,
        holder: address,
        terminal: terminal.address,
        token: context.token,
        decimals: context.decimals,
        symbol,
        gross,
        net,
        cashOutTaxRate,
        metadata,
        tokenIdsKey,
      }
    },
  })

  useEffect(() => {
    if (tx.phase !== 'success') return
    queryClient.invalidateQueries({ queryKey: ['shop-owned-items'] })
    queryClient.invalidateQueries({ queryKey: ['shop-redeemable-items'] })
  }, [queryClient, tx.phase])

  const toggle = (tokenId: string) => {
    if (busy) return
    setPrepareError(null)
    setSelected(previous => {
      const next = new Set(previous)
      if (next.has(tokenId)) next.delete(tokenId)
      else next.add(tokenId)
      return next
    })
    tx.reset()
  }

  const toggleAll = () => {
    if (busy) return
    setPrepareError(null)
    setSelected(
      selectedItems.length === target.items.length
        ? new Set()
        : new Set(target.items.map(item => item.tokenId)),
    )
    tx.reset()
  }

  const redeem = async () => {
    if (!isConnected || !address) {
      openSignIn()
      return
    }
    if (busy || selectedTokenIds.length === 0) return
    setPrepareError(null)
    setPreparing(true)
    try {
      // Refresh ownership, hook preview, fee state, and minimum immediately
      // before simulation/signing. The sent request is frozen from this read.
      const refreshed = await refetchQuote()
      if (refreshed.error) {
        throw refreshed.error
      }
      const reviewed = refreshed.data
      if (!reviewed || reviewed.net <= 0n) {
        throw new Error(
          'There is no surplus available for these items right now.',
        )
      }
      const liveAddress = getAccount(config).address
      if (
        !liveAddress ||
        liveAddress.toLowerCase() !== address.toLowerCase() ||
        reviewed.holder.toLowerCase() !== address.toLowerCase() ||
        reviewed.chainId !== selectedChainId ||
        reviewed.tokenIdsKey !== tokenIdsKey
      ) {
        throw new Error('Your account or item selection changed. Review again.')
      }
      const minReclaimed = quotedOutputFloor(reviewed.net, 9900n)
      await tx.send({
        chainId: reviewed.chainId,
        address: reviewed.terminal,
        abi: jbMultiTerminalAbi as Abi,
        functionName: 'cashOutTokensOf',
        args: [
          reviewed.holder,
          BigInt(target.projectId),
          0n,
          reviewed.token,
          minReclaimed,
          reviewed.holder,
          reviewed.metadata,
        ],
      })
    } catch (error) {
      setPrepareError(
        error instanceof Error
          ? error.message
          : 'Could not prepare this redemption.',
      )
    } finally {
      setPreparing(false)
    }
  }

  const groups = useMemo(() => {
    const byTier = new Map<number, RedeemableShopItem[]>()
    for (const item of target.items) {
      byTier.set(item.tierId, [...(byTier.get(item.tierId) ?? []), item])
    }
    return [...byTier.entries()].sort((a, b) => a[0] - b[0])
  }, [target.items])

  const txUrl = tx.hash
    ? `https://${JB_CHAINS[selectedChainId]?.etherscanHostname}/tx/${tx.hash}`
    : null

  return (
    <div
      className="fixed inset-0 z-[80] flex items-start justify-center overflow-y-auto bg-slate-950/55 px-3 py-5 sm:px-6 sm:py-10"
      role="dialog"
      aria-modal="true"
      aria-labelledby="redeem-shop-items-title"
      onMouseDown={event => {
        if (event.target === event.currentTarget) close()
      }}
    >
      <div className="card w-full max-w-lg overflow-hidden shadow-[0_24px_72px_rgba(19,17,25,0.28)]">
        <div className="flex items-start justify-between gap-4 border-b border-smoke-200 px-5 py-4 sm:px-6">
          <div>
            <h2
              id="redeem-shop-items-title"
              className="font-agrandir text-xl font-medium text-ink"
            >
              Redeem items
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-smoke-700">
              Burn selected items for their share of project surplus. A
              cash-out tax and protocol fee may apply.
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
          {targets.length > 1 ? (
            <div>
              <span className="field-label">Redeem on</span>
              <div className="mt-2 flex flex-wrap gap-2" role="group">
                {targets.map(candidate => (
                  <button
                    key={candidate.chainId}
                    type="button"
                    aria-pressed={candidate.chainId === selectedChainId}
                    onClick={() => setSelectedChainId(candidate.chainId)}
                    disabled={busy}
                    className={`inline-flex min-h-[44px] items-center gap-2 rounded-lg border px-3.5 text-sm font-medium transition-colors disabled:opacity-40 ${
                      candidate.chainId === selectedChainId
                        ? 'border-bluebs-500 bg-bluebs-25 text-bluebs-700 shadow-[0_1px_4px_rgba(39,79,245,0.12)]'
                        : 'border-grey-300 bg-white text-grey-700 hover:border-bluebs-300 hover:text-bluebs-600'
                    }`}
                  >
                    <ChainIcon chainId={candidate.chainId} size={24} />
                    {chainName(candidate.chainId)}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <div className={targets.length > 1 ? 'mt-5' : ''}>
            <div className="flex items-center justify-between gap-3">
              <span className="field-label">Your items</span>
              <button
                type="button"
                onClick={toggleAll}
                disabled={busy}
                className="text-xs font-medium text-bluebs-600 hover:text-bluebs-700 disabled:opacity-40"
              >
                {selectedItems.length === target.items.length
                  ? 'Clear all'
                  : `Select all (${target.items.length})`}
              </button>
            </div>
            <div className="mt-2 max-h-64 overflow-y-auto rounded-xl border border-smoke-200 px-3 py-2">
              {groups.map(([tierId, items]) => (
                <div key={tierId} className="py-2 first:pt-0 last:pb-0">
                  <p className="text-[11px] font-medium uppercase tracking-wide text-smoke-500">
                    {names[tierId] ?? `Item #${tierId}`} ({items.length})
                  </p>
                  <div className="mt-1 space-y-1">
                    {items.map(item => (
                      <label
                        key={item.tokenId}
                        className="flex min-h-[36px] cursor-pointer items-center gap-2 rounded-lg px-2 text-sm hover:bg-smoke-50"
                      >
                        <input
                          type="checkbox"
                          checked={selected.has(item.tokenId)}
                          onChange={() => toggle(item.tokenId)}
                          disabled={busy}
                          className="h-4 w-4 accent-bluebs-500"
                        />
                        <span>Token #{item.tokenId}</span>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div
            className="mt-4 min-h-[44px] rounded-xl border border-smoke-200 bg-smoke-25 px-3.5 py-3 text-sm text-smoke-700"
            aria-live="polite"
          >
            {selectedTokenIds.length === 0 ? (
              'Select at least one item.'
            ) : quoteLoading || preparing ? (
              'Estimating your redemption…'
            ) : quoteError ? (
              <span className="text-red-600">
                {quoteError instanceof Error
                  ? quoteError.message
                  : 'Could not estimate this redemption.'}
              </span>
            ) : quote && quote.net > 0n ? (
              <>
                You&apos;ll receive approximately{' '}
                <span className="font-medium text-ink">
                  {formatTokenAmount(quote.net, quote.decimals)} {quote.symbol}
                </span>{' '}
                for {selectedTokenIds.length}{' '}
                {selectedTokenIds.length === 1 ? 'item' : 'items'}.
              </>
            ) : (
              'There is no surplus available for these items right now.'
            )}
          </div>

          {tx.phase === 'success' ? (
            <div className="mt-4 rounded-xl border border-melon-200 bg-melon-50 p-4 text-sm text-melon-700">
              Items redeemed successfully.
              {txUrl ? (
                <>
                  {' '}
                  <a
                    href={txUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium underline underline-offset-2"
                  >
                    View transaction
                  </a>
                </>
              ) : null}
            </div>
          ) : null}

          {prepareError || tx.error ? (
            <p className="mt-4 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
              {prepareError ?? tx.error}
            </p>
          ) : null}

          <button
            type="button"
            onClick={tx.phase === 'success' ? close : redeem}
            disabled={
              tx.phase !== 'success' &&
              (busy || selectedTokenIds.length === 0 || !quote || quote.net <= 0n)
            }
            className="btn-primary mt-5 min-h-[48px] w-full text-sm"
          >
            {tx.phase === 'success'
              ? 'Done'
              : preparing || tx.phase === 'simulating'
                ? 'Double-checking the redemption…'
                : tx.phase === 'signing'
                  ? 'Confirm in your wallet…'
                  : tx.phase === 'pending'
                    ? 'Redeeming items…'
                    : `Redeem ${selectedTokenIds.length || ''} item${selectedTokenIds.length === 1 ? '' : 's'}`}
          </button>

          {quote && quote.net > 0n && tx.phase !== 'success' ? (
            <p className="mt-3 text-center text-xs text-smoke-700">
              You&apos;ll receive at least{' '}
              {formatTokenAmount(
                quotedOutputFloor(quote.net, 9900n),
                quote.decimals,
              )}{' '}
              {quote.symbol}, or the transaction reverts.
            </p>
          ) : null}
        </div>
      </div>
    </div>
  )
}
