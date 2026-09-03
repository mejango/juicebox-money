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
  buildCashOutTx,
  cashOutProtocolFee,
  getAccountingContexts,
  resolvePaymentTerminal,
  slippageFloor,
} from '@bananapus/nana-sdk-core/v6'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import {
  erc20Abi,
  zeroAddress,
  type Address,
  type PublicClient,
} from 'viem'
import { useConfig } from 'wagmi'
import { getAccount, getPublicClient } from 'wagmi/actions'
import { ChainPillButton } from '@/components/ui/ChainPillButton'
import { ModalShell } from '@/components/ui/ModalShell'
import { TxConfirmDialog } from '@/components/ui/TxConfirmDialog'
import { TxError } from '@/components/ui/TxError'
import { useSafeTx } from '@/hooks/useSafeTx'
import { useWallet } from '@/hooks/useWallet'
import {
  etherscanTxUrl,
  formatTokenAmount,
  truncateAddress,
} from '@/lib/format'
import { minimumDropNotice } from '@/lib/cashOut'
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

type RedeemPlan = {
  quote: ItemCashOutQuote
  minReclaimed: bigint
  request: ReturnType<typeof buildCashOutTx>
  reviewNotice: ReturnType<typeof minimumDropNotice>
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
  const [plan, setPlan] = useState<RedeemPlan | null>(null)
  const tx = useSafeTx(selectedChainId)

  useEffect(() => {
    setSelected(new Set(target.items.map(item => item.tokenId)))
    setPrepareError(null)
    setPlan(null)
    tx.reset()
    // The joined key deliberately resets selection if ownership changes while
    // the modal is open without depending on a freshly allocated array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedChainId, targetItemsKey])

  const busy = preparing || tx.busy

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
      // Unknown feeless/surplus reads conservatively assume the full fee,
      // keeping the submitted minimum safely below what the terminal pays.
      const fee = cashOutProtocolFee({
        reclaimAmount: gross,
        cashOutTaxRate,
        beneficiaryIsFeeless: feeless === true,
        feeFreeSurplus: feeFreeSurplus ?? gross,
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

  const prepare = async () => {
    if (!isConnected || !address) {
      openSignIn()
      return
    }
    if (busy || selectedTokenIds.length === 0) return
    setPrepareError(null)
    setPreparing(true)
    // What the panel promised, captured before the re-quote below replaces it.
    const displayedMinimum = quote ? slippageFloor(quote.net) : null
    try {
      // Refresh ownership, hook preview, fee state, and minimum immediately
      // before the review. The reviewed request is frozen from this read.
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
      const minReclaimed = slippageFloor(reviewed.net)
      setPlan({
        quote: reviewed,
        minReclaimed,
        request: buildCashOutTx({
          chainId: reviewed.chainId,
          terminal: reviewed.terminal,
          holder: reviewed.holder,
          projectId: BigInt(target.projectId),
          cashOutCount: 0n,
          tokenToReclaim: reviewed.token,
          minTokensReclaimed: minReclaimed,
          beneficiary: reviewed.holder,
          metadata: reviewed.metadata,
        }),
        reviewNotice: minimumDropNotice({
          displayedMinimum,
          freshMinimum: minReclaimed,
          decimals: reviewed.decimals,
          symbol: reviewed.symbol,
        }),
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

  const redeem = async () => {
    if (!plan || busy) return
    setPrepareError(null)
    try {
      await tx.send(plan.request, { reviewNotice: plan.reviewNotice })
    } catch (error) {
      setPrepareError(
        error instanceof Error
          ? error.message
          : 'Could not redeem these items.',
      )
    }
  }

  const groups = useMemo(() => {
    const byTier = new Map<number, RedeemableShopItem[]>()
    for (const item of target.items) {
      byTier.set(item.tierId, [...(byTier.get(item.tierId) ?? []), item])
    }
    return [...byTier.entries()].sort((a, b) => a[0] - b[0])
  }, [target.items])

  const txUrl = tx.hash ? etherscanTxUrl(selectedChainId, tx.hash) : null
  const itemsSummary = groups
    .map(([tierId, items]) => [
      tierId,
      items.filter(item => selected.has(item.tokenId)).length,
    ])
    .filter(([, count]) => count > 0)
    .map(([tierId, count]) => `${count} × ${names[tierId] ?? `Item #${tierId}`}`)
    .join(', ')

  return (
    <ModalShell
      title="Redeem items"
      subtitle="Burn selected items for their share of project surplus. A cash-out tax and protocol fee may apply."
      onClose={onClose}
      busy={busy}
      maxWidth="max-w-lg"
    >
      {targets.length > 1 ? (
        <div>
          <span className="field-label">Redeem on</span>
          <div className="mt-2 flex flex-wrap gap-2" role="group">
            {targets.map(candidate => (
              <ChainPillButton
                key={candidate.chainId}
                chainId={candidate.chainId}
                selected={candidate.chainId === selectedChainId}
                onClick={() => setSelectedChainId(candidate.chainId)}
                disabled={busy}
              >
                {chainName(candidate.chainId)}
              </ChainPillButton>
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

      <TxError
        error={plan ? null : prepareError}
        className="mt-4 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700"
      />

      <button
        type="button"
        onClick={tx.phase === 'success' ? onClose : prepare}
        disabled={
          tx.phase !== 'success' &&
          (busy || selectedTokenIds.length === 0 || !quote || quote.net <= 0n)
        }
        className="btn-primary mt-5 min-h-[48px] w-full text-sm"
      >
        {tx.phase === 'success'
          ? 'Done'
          : preparing
            ? 'Double-checking the redemption…'
            : `Redeem ${selectedTokenIds.length || ''} item${selectedTokenIds.length === 1 ? '' : 's'}`}
      </button>

      {quote && quote.net > 0n && tx.phase !== 'success' ? (
        <p className="mt-3 text-center text-xs text-smoke-700">
          You&apos;ll receive at least{' '}
          {formatTokenAmount(slippageFloor(quote.net), quote.decimals)}{' '}
          {quote.symbol}, or the transaction reverts.
        </p>
      ) : null}

      {plan ? (
        <TxConfirmDialog
          open
          title={tx.phase === 'success' ? 'Items redeemed' : 'Confirm redemption'}
          rows={[
            { label: 'Items', value: itemsSummary },
            {
              label: 'You get',
              value: `~${formatTokenAmount(plan.quote.net, plan.quote.decimals)} ${plan.quote.symbol}`,
            },
            {
              label: 'At least',
              value: `${formatTokenAmount(plan.minReclaimed, plan.quote.decimals)} ${plan.quote.symbol}`,
              strong: true,
            },
            { label: 'On', value: chainName(selectedChainId) },
          ]}
          steps={[
            {
              title: `Redeem ${selectedTokenIds.length} item${selectedTokenIds.length === 1 ? '' : 's'}`,
            },
          ]}
          activeIndex={tx.busy || tx.phase === 'error' ? 0 : -1}
          action={tx.phase === 'error' ? 'Retry' : 'Confirm & redeem'}
          onConfirm={() => void redeem()}
          busy={tx.busy}
          complete={tx.phase === 'success'}
          status={tx.safeNonceGuidance}
          error={prepareError ?? tx.error}
          onClose={() => {
            setPlan(null)
            setPrepareError(null)
            if (tx.phase !== 'success') tx.reset()
          }}
        />
      ) : null}
    </ModalShell>
  )
}
