'use client'

import {
  JB_CHAINS,
  JBCoreContracts,
  JBOmnichainDeployerContracts,
  NATIVE_TOKEN,
  jb721TiersHookAbi,
  jb721TiersHookStoreAbi,
  jbContractAddress,
  jbMultiTerminalAbi,
  jbOmnichainDeployerAbi,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import {
  build721PayMetadata,
  buildPayTx,
  getAccountingContexts,
  getCurrentRuleset,
  getRevnetTiered721Hook,
  previewPay,
} from '@bananapus/nana-sdk-core/v6'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import {
  erc20Abi,
  formatUnits,
  parseUnits,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem'
import { usePublicClient } from 'wagmi'
import { useSafeTx } from '@/hooks/useSafeTx'
import { useWallet } from '@/hooks/useWallet'
import { formatTokenAmount, ipfsUrl } from '@/lib/format'

const TIER_UNLIMITED_SUPPLY = 999_999_999

type PayContext = {
  token: Address
  decimals: number
  currency: number
  symbol: string
}

type ShopInfo = {
  hook: Address
  /** The metadata id target — the hook's METADATA_ID_TARGET (the shared
   *  implementation), NOT the clone. Keying by the clone address makes the
   *  hook miss the tier ids entirely: payment goes through, no NFT mints. */
  idTarget: Address
  pricingCurrency: number
  pricingDecimals: number
  tiers: {
    id: number
    price: bigint
    discountPercent: number
    remaining: number
    unlimited: boolean
    name: string | null
    image: string | null
  }[]
}

/** Discounted tier price (store math: denominator 200, floor division). */
function effectivePrice(price: bigint, discountPercent: number): bigint {
  return price - (price * BigInt(discountPercent)) / 200n
}

/**
 * The pay side of the treasury card (website/ pay-card parity, jbm shape):
 * mode select (Pay / Add to balance), the project's real accepted tokens
 * with their own decimals, item checkout via 721 metadata, an exact
 * previewed minimum, and simulate-first sends.
 */
export function PayPanel({
  chainId,
  projectId,
  projectName,
  isRevnet,
  payDisclosure,
}: {
  chainId: JBChainId
  projectId: number
  projectName: string
  isRevnet: boolean
  payDisclosure?: string
}) {
  const { isConnected, address, openSignIn } = useWallet()
  const publicClient = usePublicClient({ chainId }) as PublicClient | undefined
  const tx = useSafeTx(chainId)
  const approveTx = useSafeTx(chainId)

  const [mode, setMode] = useState<'pay' | 'addbalance'>('pay')
  const [amount, setAmount] = useState('')
  const [debouncedAmount, setDebouncedAmount] = useState('')
  const [tokenIndex, setTokenIndex] = useState(0)
  const [memo, setMemo] = useState('')
  const [showMemo, setShowMemo] = useState(false)
  const [cart, setCart] = useState<Record<number, number>>({})

  useEffect(() => {
    const t = setTimeout(() => setDebouncedAmount(amount), 400)
    return () => clearTimeout(t)
  }, [amount])

  const chainMeta = JB_CHAINS[chainId]
  const nativeSymbol = chainMeta?.nativeTokenSymbol ?? 'ETH'

  // ---- The project's payment surface: accepted tokens + live ruleset ----
  const { data: surface, isError: surfaceError } = useQuery({
    queryKey: ['paySurface', chainId, projectId],
    enabled: !!publicClient,
    staleTime: 60_000,
    retry: 1,
    queryFn: async () => {
      const args = { chainId, projectId: BigInt(projectId) }
      const [contexts, ruleset] = await Promise.all([
        getAccountingContexts(publicClient!, args),
        getCurrentRuleset(publicClient!, args).catch(() => null),
      ])
      const withSymbols: PayContext[] = await Promise.all(
        contexts.map(async ctx => ({
          token: ctx.token,
          decimals: ctx.decimals,
          currency: ctx.currency,
          symbol:
            ctx.token.toLowerCase() === NATIVE_TOKEN.toLowerCase()
              ? nativeSymbol
              : await publicClient!
                  .readContract({
                    address: ctx.token,
                    abi: erc20Abi,
                    functionName: 'symbol',
                  })
                  .catch(() => 'TOKEN'),
        })),
      )
      return {
        contexts: withSymbols,
        rulesetStart: ruleset ? ruleset.ruleset.start : 0,
        pausePay: ruleset ? ruleset.metadata.pausePay : false,
      }
    },
  })

  const contexts = surface?.contexts ?? []
  const context = contexts[Math.min(tokenIndex, contexts.length - 1)] as
    | PayContext
    | undefined
  const symbol = context?.symbol ?? nativeSymbol
  const decimals = context?.decimals ?? 18
  const isNative =
    context?.token.toLowerCase() === NATIVE_TOKEN.toLowerCase() || !context

  const startsAt = surface?.rulesetStart ?? 0
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))
  useEffect(() => {
    if (!startsAt || startsAt <= now) return
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000)
    return () => clearInterval(t)
  }, [startsAt, now])
  const notStarted = startsAt > now

  const amountRaw = useMemo(() => {
    try {
      const trimmed = debouncedAmount.trim()
      if (!trimmed || Number(trimmed) <= 0) return 0n
      return parseUnits(trimmed, decimals)
    } catch {
      return 0n
    }
  }, [debouncedAmount, decimals])

  // ---- 721 shop strip: hook + tiers, priced in the shop's currency ----
  const { data: shop } = useQuery({
    queryKey: ['payShop', chainId, projectId, isRevnet],
    enabled: !!publicClient,
    staleTime: 120_000,
    retry: 1,
    queryFn: async (): Promise<ShopInfo | null> => {
      const client = publicClient!
      // Resolve the hook (mirrors ShopTab): REVOwner for revnets, else the
      // ruleset data hook / omnichain deployer record, verified via STORE().
      let hook: Address | null = null
      if (isRevnet) {
        const fromRev = await getRevnetTiered721Hook(client, {
          chainId,
          revnetId: BigInt(projectId),
        }).catch(() => null)
        if (fromRev && fromRev !== zeroAddress) hook = fromRev
      } else {
        const ruleset = await getCurrentRuleset(client, {
          chainId,
          projectId: BigInt(projectId),
        }).catch(() => null)
        const dataHook = ruleset?.metadata.dataHook
        if (
          ruleset &&
          ruleset.metadata.useDataHookForPay &&
          dataHook &&
          dataHook !== zeroAddress
        ) {
          const omnichain = jbContractAddress['6'][
            JBOmnichainDeployerContracts.JBOmnichainDeployer
          ]?.[chainId] as Address | undefined
          if (omnichain && dataHook.toLowerCase() === omnichain.toLowerCase()) {
            const recorded = await client
              .readContract({
                address: omnichain,
                abi: jbOmnichainDeployerAbi,
                functionName: 'tiered721HookOf',
                args: [BigInt(projectId), BigInt(ruleset.ruleset.id)],
              })
              .catch(() => null)
            const recordedHook = recorded ? recorded[0] : null
            if (recordedHook && recordedHook !== zeroAddress)
              hook = recordedHook
          } else {
            hook = dataHook as Address
          }
        }
      }
      if (!hook) return null
      const store = (await client
        .readContract({
          address: hook,
          abi: jb721TiersHookAbi,
          functionName: 'STORE',
        })
        .catch(() => null)) as Address | null
      if (!store) return null
      const [idTarget, pricing, tiers] = await Promise.all([
        client
          .readContract({
            address: hook,
            abi: jb721TiersHookAbi,
            functionName: 'METADATA_ID_TARGET',
          })
          .catch(() => hook!),
        client.readContract({
          address: hook,
          abi: jb721TiersHookAbi,
          functionName: 'pricingContext',
        }),
        client.readContract({
          address: store,
          abi: jb721TiersHookStoreAbi,
          functionName: 'tiersOf',
          args: [hook, [], true, 0n, 12n],
        }),
      ])
      return {
        hook,
        idTarget: idTarget as Address,
        pricingCurrency: Number(pricing[0]),
        pricingDecimals: Number(pricing[1]),
        tiers: tiers
          .filter(t => t.initialSupply > 0)
          .map(t => {
            let name: string | null = null
            let image: string | null = null
            try {
              const uri = t.resolvedUri
              if (uri?.startsWith('data:application/json')) {
                const json = JSON.parse(
                  uri.includes('base64,')
                    ? decodeURIComponent(escape(atob(uri.split('base64,')[1])))
                    : decodeURIComponent(uri.split(',').slice(1).join(',')),
                ) as { name?: string; image?: string }
                name = json.name ?? null
                image = json.image?.startsWith('ipfs://')
                  ? ipfsUrl(json.image)
                  : (json.image ?? null)
              }
            } catch {
              // Metadata is cosmetic — a tier without it still sells.
            }
            return {
              id: t.id,
              price: t.price,
              discountPercent: t.discountPercent,
              remaining: t.remainingSupply,
              unlimited: t.initialSupply >= TIER_UNLIMITED_SUPPLY,
              name,
              image,
            }
          }),
      }
    },
  })

  // Item checkout requires paying in the shop's own pricing currency —
  // cross-currency checkout needs a price-feed conversion (follow-up), so
  // fail closed rather than guess.
  const cartCount = Object.values(cart).reduce((a, b) => a + b, 0)
  const shopMatchesToken =
    !!shop && !!context && shop.pricingCurrency === context.currency
  const cartTotal = useMemo(() => {
    if (!shop || cartCount === 0) return 0n
    return shop.tiers.reduce(
      (sum, tier) =>
        sum +
        effectivePrice(tier.price, tier.discountPercent) *
          BigInt(cart[tier.id] ?? 0),
      0n,
    )
  }, [shop, cart, cartCount])

  // Keep the amount at least the cart total (in the pay token's decimals —
  // same currency, but the shop prices in its own fixed point).
  const cartTotalInToken = useMemo(() => {
    if (!shop || cartTotal === 0n || !context) return 0n
    if (shop.pricingDecimals === context.decimals) return cartTotal
    return shop.pricingDecimals > context.decimals
      ? cartTotal / 10n ** BigInt(shop.pricingDecimals - context.decimals)
      : cartTotal * 10n ** BigInt(context.decimals - shop.pricingDecimals)
  }, [shop, cartTotal, context])

  useEffect(() => {
    if (cartTotalInToken === 0n) return
    const current = (() => {
      try {
        return parseUnits(amount.trim() || '0', decimals)
      } catch {
        return 0n
      }
    })()
    if (current < cartTotalInToken) {
      const next = formatUnits(cartTotalInToken, decimals)
      setAmount(next)
      setDebouncedAmount(next)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cartTotalInToken])

  const tierIds = useMemo(
    () =>
      Object.entries(cart).flatMap(([id, qty]) =>
        Array.from({ length: qty }, () => BigInt(id)),
      ),
    [cart],
  )
  const metadata: Hex | undefined =
    shop && tierIds.length > 0 && shopMatchesToken
      ? build721PayMetadata({
          hookAddress: shop.idTarget,
          tierIdsToMint: tierIds,
        })
      : undefined

  // ---- Terminal + preview ----
  const terminalAddress = context
    ? jbContractAddress['6'][JBCoreContracts.JBMultiTerminal][chainId]
    : undefined

  const {
    data: preview,
    isFetching: previewLoading,
    isError: previewError,
  } = useQuery({
    queryKey: [
      'previewPay',
      chainId,
      projectId,
      context?.token,
      amountRaw.toString(),
      metadata ?? '0x',
    ],
    enabled:
      !!publicClient &&
      !!context &&
      !!terminalAddress &&
      amountRaw > 0n &&
      mode === 'pay',
    retry: false,
    queryFn: () =>
      previewPay(publicClient!, {
        chainId,
        terminal: terminalAddress!,
        projectId: BigInt(projectId),
        token: context!.token,
        amount: amountRaw,
        beneficiary: address ?? zeroAddress,
        metadata,
      }),
  })

  // A VERIFIED zero preview may submit (min 0 — zero-issuance pay is
  // legitimate); an unavailable preview blocks (never send blind).
  const previewReady = mode === 'addbalance' || (!!preview && !previewError)
  const minReturned = preview?.beneficiaryTokenCount ?? 0n

  // ---- ERC-20 allowance (direct pays approve the terminal) ----
  const { data: allowance, refetch: refetchAllowance } = useQuery({
    queryKey: ['payAllowance', chainId, context?.token, address],
    enabled:
      !!publicClient && !!context && !isNative && !!address && amountRaw > 0n,
    staleTime: 15_000,
    queryFn: () =>
      publicClient!.readContract({
        address: context!.token,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [address!, terminalAddress!],
      }),
  })
  const needsApproval = !isNative && (allowance ?? 0n) < amountRaw

  useEffect(() => {
    if (approveTx.phase === 'success') void refetchAllowance()
  }, [approveTx.phase, refetchAllowance])

  const busy =
    tx.phase === 'simulating' ||
    tx.phase === 'signing' ||
    tx.phase === 'pending' ||
    approveTx.phase === 'simulating' ||
    approveTx.phase === 'signing' ||
    approveTx.phase === 'pending'

  const submit = () => {
    if (!isConnected || !address) {
      openSignIn()
      return
    }
    if (!context || !terminalAddress || amountRaw <= 0n || busy) return
    if (needsApproval) {
      void approveTx.send({
        chainId,
        address: context.token,
        abi: erc20Abi,
        functionName: 'approve',
        args: [terminalAddress, amountRaw],
      })
      return
    }
    if (mode === 'pay') {
      const request = buildPayTx({
        chainId,
        terminal: terminalAddress,
        projectId: BigInt(projectId),
        token: context.token,
        amount: amountRaw,
        beneficiary: address,
        minReturnedTokens: minReturned,
        memo: memo.trim() || undefined,
        metadata,
      })
      void tx.send({
        chainId,
        address: request.address,
        abi: request.abi,
        functionName: request.functionName,
        args: request.args as unknown as readonly unknown[],
        value: request.value,
      })
    } else {
      void tx.send({
        chainId,
        address: terminalAddress,
        abi: jbMultiTerminalAbi,
        functionName: 'addToBalanceOf',
        args: [
          BigInt(projectId),
          context.token,
          amountRaw,
          false,
          memo.trim(),
          '0x',
        ],
        value: isNative ? amountRaw : undefined,
      })
    }
  }

  const reset = () => {
    tx.reset()
    approveTx.reset()
    setAmount('')
    setDebouncedAmount('')
    setMemo('')
    setShowMemo(false)
    setCart({})
  }

  // ---- Success view ----
  if (tx.phase === 'success') {
    return (
      <div className="flex flex-col items-center py-4 text-center">
        <span className="flex h-14 w-14 items-center justify-center rounded-full bg-melon-400">
          <svg
            viewBox="0 0 24 24"
            className="h-7 w-7 text-ink"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="m5 13 4 4L19 7" />
          </svg>
        </span>
        <p className="mt-3 font-agrandir text-lg font-medium">
          {mode === 'pay' ? 'Payment confirmed' : 'Added to the balance'}
        </p>
        <p className="mt-1 text-sm text-smoke-700">
          {mode === 'pay'
            ? `You supported ${projectName}.`
            : `${projectName}'s balance grew — no tokens minted.`}
        </p>
        {tx.hash && chainMeta ? (
          <a
            href={`https://${chainMeta.etherscanHostname}/tx/${tx.hash}`}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 text-xs text-smoke-500 underline underline-offset-2 hover:text-ink"
          >
            View the transaction
          </a>
        ) : null}
        <button
          onClick={reset}
          className="btn-secondary mt-5 min-h-[40px] px-5 text-sm"
        >
          Done
        </button>
      </div>
    )
  }

  return (
    <div>
      <h3 className="font-agrandir text-lg font-medium">
        Support this project
      </h3>

      {/* Mode + token row */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <select
          value={mode}
          onChange={e => setMode(e.target.value as 'pay' | 'addbalance')}
          disabled={busy}
          aria-label="Payment mode"
          className="select-caret input-well min-h-[40px] !w-auto pl-3 pr-7 text-sm disabled:opacity-60"
        >
          <option value="pay">Pay</option>
          <option value="addbalance">Add to balance</option>
        </select>
        {contexts.length > 1 ? (
          <>
            <span className="text-sm text-smoke-700">with</span>
            <select
              // Valued by INDEX, not address — the option must stay in
              // lock-step with the selected context (website/ parity).
              value={tokenIndex}
              onChange={e => {
                setTokenIndex(Number(e.target.value))
                setCart({})
              }}
              disabled={busy}
              aria-label="Payment token"
              className="select-caret input-well min-h-[40px] !w-auto pl-3 pr-7 text-sm disabled:opacity-60"
            >
              {contexts.map((ctx, i) => (
                <option key={`${ctx.token}-${i}`} value={i}>
                  {ctx.symbol}
                </option>
              ))}
            </select>
          </>
        ) : null}
      </div>
      {mode === 'addbalance' ? (
        <p className="mt-1.5 text-xs leading-relaxed text-smoke-700">
          Adds funds without minting tokens — useful for refills and refunds.
        </p>
      ) : null}

      {/* Shop strip */}
      {shop && shop.tiers.length > 0 && mode === 'pay' ? (
        <div className="mt-4">
          <span className="field-label">Items</span>
          {!shopMatchesToken ? (
            <p className="mt-1 text-xs leading-relaxed text-smoke-700">
              Items are priced in a different currency than {symbol} — switch
              the payment token to buy them.
            </p>
          ) : (
            <div className="scrollbar-none mt-2 flex gap-2 overflow-x-auto pb-1">
              {shop.tiers.map(tier => {
                const qty = cart[tier.id] ?? 0
                const soldOut = !tier.unlimited && tier.remaining === 0
                const price = effectivePrice(tier.price, tier.discountPercent)
                return (
                  <div
                    key={tier.id}
                    className={`w-24 shrink-0 rounded-lg border p-2 text-center ${
                      qty > 0
                        ? 'border-ink bg-split-50'
                        : 'border-smoke-200 bg-white'
                    } ${soldOut ? 'opacity-40' : ''}`}
                  >
                    {tier.image ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={tier.image}
                        alt={tier.name ?? `Item ${tier.id}`}
                        className="mx-auto h-14 w-14 rounded object-cover"
                      />
                    ) : (
                      <span className="mx-auto flex h-14 w-14 items-center justify-center rounded bg-smoke-75 text-xs text-smoke-500">
                        #{tier.id}
                      </span>
                    )}
                    <p className="mt-1 truncate text-[11px] text-ink">
                      {tier.name ?? `Item ${tier.id}`}
                    </p>
                    <p className="text-[11px] text-smoke-700">
                      {formatTokenAmount(price, shop.pricingDecimals)} {symbol}
                    </p>
                    {soldOut ? (
                      <p className="text-[10px] text-smoke-500">Sold out</p>
                    ) : (
                      <div className="mt-1 flex items-center justify-center gap-1.5">
                        <button
                          onClick={() =>
                            setCart(c => ({
                              ...c,
                              [tier.id]: Math.max(0, (c[tier.id] ?? 0) - 1),
                            }))
                          }
                          disabled={busy || qty === 0}
                          aria-label="Remove one"
                          className="h-5 w-5 rounded-full border border-smoke-300 text-xs leading-none text-smoke-700 disabled:opacity-40"
                        >
                          −
                        </button>
                        <span className="min-w-[1ch] text-xs tabular-nums">
                          {qty}
                        </span>
                        <button
                          onClick={() =>
                            setCart(c => ({
                              ...c,
                              [tier.id]: Math.min(
                                tier.unlimited ? 99 : tier.remaining,
                                (c[tier.id] ?? 0) + 1,
                              ),
                            }))
                          }
                          disabled={busy}
                          aria-label="Add one"
                          className="h-5 w-5 rounded-full border border-smoke-300 text-xs leading-none text-smoke-700 disabled:opacity-40"
                        >
                          +
                        </button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      ) : null}

      {/* Amount */}
      <label className="mt-4 block">
        <span className="field-label">Amount</span>
        <span className="input-well mt-1.5 flex min-h-[52px] items-center gap-2 px-4">
          <input
            type="text"
            inputMode="decimal"
            value={amount}
            onChange={e => setAmount(e.target.value)}
            disabled={busy}
            placeholder="0.01"
            className="min-w-0 flex-1 bg-transparent text-lg font-medium outline-none placeholder:text-smoke-500 disabled:opacity-60"
          />
          <span className="shrink-0 text-sm font-medium text-smoke-700">
            {symbol}
          </span>
        </span>
      </label>

      {/* Preview */}
      {mode === 'pay' && amountRaw > 0n ? (
        <div className="mt-2.5 text-sm text-smoke-700">
          {previewLoading ? (
            <p>Checking what you&apos;ll get…</p>
          ) : previewError ? (
            <p className="text-red-600">
              Couldn&apos;t verify what this payment returns — paying is
              disabled until the preview works.
            </p>
          ) : preview ? (
            <>
              {preview.beneficiaryTokenCount > 0n ? (
                <p>
                  You get{' '}
                  <span className="font-bold text-ink">
                    {formatTokenAmount(preview.beneficiaryTokenCount, 18)}{' '}
                    tokens
                  </span>{' '}
                  — guaranteed, or the payment reverts.
                </p>
              ) : cartCount > 0 ? null : (
                <p>This payment mints no tokens right now.</p>
              )}
              {preview.reservedTokenCount > 0n ? (
                <p className="mt-0.5 text-xs">
                  Splits get{' '}
                  {formatTokenAmount(preview.reservedTokenCount, 18)} tokens.
                </p>
              ) : null}
              {cartCount > 0 ? (
                <p className="mt-0.5 text-xs">
                  + {cartCount} item{cartCount === 1 ? '' : 's'} from the shop.
                </p>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}

      {/* Memo */}
      {showMemo ? (
        <input
          type="text"
          value={memo}
          onChange={e => setMemo(e.target.value.slice(0, 256))}
          disabled={busy}
          placeholder="Add a note (optional)"
          className="input-well mt-3 min-h-[44px] px-3.5 text-sm disabled:opacity-60"
        />
      ) : (
        <button
          onClick={() => setShowMemo(true)}
          disabled={busy}
          className="mt-3 text-xs font-medium text-bluebs-600 hover:text-bluebs-700"
        >
          + Add a note
        </button>
      )}

      {payDisclosure ? (
        <p className="mt-3 rounded-lg bg-smoke-75 px-3.5 py-2.5 text-xs leading-relaxed text-smoke-700">
          {payDisclosure}
        </p>
      ) : null}

      {surfaceError ? (
        <p className="mt-3 text-sm text-red-600">
          Couldn&apos;t verify this project&apos;s accepted tokens — payments
          are disabled.
        </p>
      ) : null}
      {surface?.pausePay && mode === 'pay' ? (
        <p className="mt-3 text-sm text-smoke-700">
          Payments are paused under the current rules.
        </p>
      ) : null}
      {(approveTx.error ?? tx.error) ? (
        <p className="mt-3 text-sm text-red-600">
          {approveTx.error ?? tx.error}
        </p>
      ) : null}

      <button
        onClick={submit}
        disabled={
          busy ||
          notStarted ||
          surfaceError ||
          (surface?.pausePay && mode === 'pay') ||
          (isConnected &&
            (amountRaw <= 0n || (mode === 'pay' && !previewReady)))
        }
        className="btn-primary mt-4 min-h-[48px] w-full text-sm disabled:opacity-60"
      >
        {notStarted
          ? `Starts in ${formatStartCountdown(startsAt - now)}`
          : !isConnected
            ? 'Sign in to pay'
            : busy
              ? approveTx.phase === 'signing' || tx.phase === 'signing'
                ? 'Confirm in your wallet…'
                : approveTx.phase === 'pending' || tx.phase === 'pending'
                  ? 'Sending…'
                  : 'Double-checking…'
              : needsApproval
                ? `Allow ${symbol} — step 1 of 2`
                : mode === 'pay'
                  ? 'Pay'
                  : 'Add to balance'}
      </button>
    </div>
  )
}

function formatStartCountdown(secs: number): string {
  if (secs <= 0) return 'moments'
  const d = Math.floor(secs / 86400)
  if (d >= 1) return `${d}d ${Math.floor((secs % 86400) / 3600)}h`
  const h = Math.floor(secs / 3600)
  if (h >= 1) return `${h}h ${Math.floor((secs % 3600) / 60)}m`
  return `${Math.max(1, Math.floor(secs / 60))}m`
}
