'use client'

import {
  bytes32ToCidV0,
  JB_CHAINS,
  JBCoreContracts,
  JBRouterTerminalContracts,
  NATIVE_TOKEN,
  USDC_ADDRESSES,
  jbContractAddress,
  jb721TiersHookAbi,
  jb721TiersHookStoreAbi,
  jbDirectoryAbi,
  jbPricesAbi,
  jbRouterTerminalRegistryAbi,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import {
  BASE_CURRENCY_ETH,
  BASE_CURRENCY_USD,
  build721PayMetadata,
  buildPayTx,
  effectiveTierPrice,
  getAccountingContexts,
  getCurrentRuleset,
  getProject721Shop,
  previewPay,
  tokenCurrencyId,
} from '@bananapus/nana-sdk-core/v6'
import { useQuery } from '@tanstack/react-query'
import { Skeleton } from '@/components/ui/Skeleton'
import { useEffect, useMemo, useRef, useState } from 'react'
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
import { useProjectTokenSymbol } from '@/hooks/useProjectTokenSymbol'
import { useSafeTx } from '@/hooks/useSafeTx'
import { useWallet } from '@/hooks/useWallet'
import { useShopCart } from '@/components/project/ShopCartProvider'
import { QuantityStepper } from '@/components/ui/QuantityStepper'
import { formatTokenAmount } from '@/lib/format'
import {
  TIER_UNLIMITED_SUPPLY,
  parseTierMetadataJson,
  pickTierMetadata,
  tierMediaImageUrl,
} from '@/lib/tier-metadata'
import { tokenSymbol } from '@/lib/token-symbol'
import {
  buildAddToBalanceRequest,
  buildErc20ApproveRequest,
} from '@/lib/transaction-builders'
import { chainName } from '@/lib/urn'

function payChainName(chainId: JBChainId): string {
  const compactNames: Partial<Record<JBChainId, string>> = {
    11155420: 'OP Sep',
    84532: 'Base Sep',
    421614: 'Arb Sep',
  }
  return compactNames[chainId] ?? chainName(chainId)
}

type PayContext = {
  token: Address
  decimals: number
  currency: number
  symbol: string
  /** True when this token is NOT accepted directly and is paid through the
   *  JBRouterTerminalRegistry, which swaps it into the project's accounting
   *  token. False for the project's own directly-accepted accounting tokens. */
  viaRouter: boolean
}

type PaySurface = {
  contexts: PayContext[]
  rulesetStart: number
  pausePay: boolean
  /** The project's payment terminals (JBDirectory.terminalsOf) — the surface a
   *  pay is fail-closed against: the target terminal MUST appear here. */
  terminals: Address[]
  /** Listed terminals this form doesn't recognize — a non-blocking note. */
  unknown: Address[]
}

const ROUTER_PROBE_BENEFICIARY: Address =
  '0x0000000000000000000000000000000000000001'

/** A stable identity for a pay token — a token can appear both directly AND
 *  via-router, so the key must include the route. */
function payTokenKey(t: Pick<PayContext, 'token' | 'viaRouter'>): string {
  return `${t.token.toLowerCase()}:${t.viaRouter}`
}

// Whether the router registry can actually route a pay of `token` into
// `projectId` right now (direct forward, swap, or cash-out loop). A listed
// router with no pool/feed path reverts at pay time — offering ETH/USDC there
// is a trap, not a convenience — so a dead route previews an all-zero ruleset
// (ruleset.id == 0). Cached (as a promise) per (chain, project, token), exactly
// like website/ _payRouteCache. Fail-soft: any error resolves false.
const _payRouteCache = new Map<string, Promise<boolean>>()

async function resolvePayTierMetadata(tier: {
  resolvedUri?: string
  encodedIpfsUri: `0x${string}`
}) {
  const resolved = tier.resolvedUri
    ? parseTierMetadataJson(tier.resolvedUri)
    : null
  if (resolved && Object.keys(resolved).length > 0) {
    return pickTierMetadata(resolved)
  }

  const cid = bytes32ToCidV0(tier.encodedIpfsUri)
  if (!cid) return null
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8_000)
    const response = await fetch(`/api/ipfs/${cid}`, {
      signal: controller.signal,
    }).finally(() => clearTimeout(timer))
    if (!response.ok) return null
    const json = (await response.json()) as unknown
    return json && typeof json === 'object'
      ? pickTierMetadata(json as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}
function routerPayRouteWorks(
  client: PublicClient,
  chainId: number,
  projectId: number,
  registry: Address,
  token: Address,
  decimals: number,
): Promise<boolean> {
  const key = `${chainId}:${projectId}:${token.toLowerCase()}`
  let cached = _payRouteCache.get(key)
  if (!cached) {
    cached = client
      .readContract({
        address: registry,
        abi: jbRouterTerminalRegistryAbi,
        functionName: 'previewPayFor',
        args: [
          BigInt(projectId),
          token,
          10n ** BigInt(decimals),
          ROUTER_PROBE_BENEFICIARY,
          '0x',
        ],
      })
      .then(out => {
        // previewPayFor returns [ruleset, ...]; a dead route yields ruleset.id == 0.
        const ruleset = (out as readonly [{ id: number }, ...unknown[]])[0]
        return Number(ruleset?.id ?? 0) !== 0
      })
      .catch(() => false)
    _payRouteCache.set(key, cached)
  }
  return cached
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
    initial: number
    unlimited: boolean
    cantBuyWithCredits: boolean
    name: string | null
    description: string | null
    image: string | null
  }[]
}

type ShopPayRoute = {
  supported: boolean
  /** Payment-token units per one whole shop-pricing unit. */
  pricePerUnit: bigint | null
  reason?: string
}

/**
 * The pay side of the treasury card (website/ pay-card parity, jbm shape):
 * mode select (Pay / Add to balance), the project's real accepted tokens
 * with their own decimals, item checkout via 721 metadata, an exact
 * previewed minimum, and simulate-first sends.
 */
export function PayPanel({
  chainId: initialChainId,
  projectId: initialProjectId,
  projectName,
  isRevnet,
  chains,
  payDisclosure,
}: {
  chainId: JBChainId
  projectId: number
  projectName: string
  isRevnet: boolean
  /** [chainId, projectId] pairs across the sucker group (chain selector). */
  chains: [number, number][]
  payDisclosure?: string
}) {
  const { isConnected, address, openSignIn } = useWallet()
  const {
    quantities: cart,
    items: cartItems,
    count: cartCount,
    setQuantity,
    registerItem,
    clear: clearCart,
  } = useShopCart()

  // The chain being paid — a project lives on every linked chain, and the
  // payer picks which one. projectId can differ per chain (sucker groups).
  const [deployment, setDeployment] = useState<{
    chainId: JBChainId
    projectId: number
  }>(() => ({ chainId: initialChainId, projectId: initialProjectId }))
  const { chainId, projectId } = deployment

  useEffect(() => {
    setDeployment({ chainId: initialChainId, projectId: initialProjectId })
  }, [initialChainId, initialProjectId])

  const publicClient = usePublicClient({ chainId }) as PublicClient | undefined
  const tx = useSafeTx(chainId)
  const approveTx = useSafeTx(chainId)

  const [mode, setMode] = useState<'pay' | 'addbalance'>('pay')
  const [amount, setAmount] = useState('')
  const [debouncedAmount, setDebouncedAmount] = useState('')
  const [tokenIndex, setTokenIndex] = useState(0)
  // True once the user explicitly picks a pay token. Until then the selection
  // auto-defaults to the project's first accounting token (list[0]) so an
  // ETH/USDC router option never shadows a USDC/ETH project's real token — the
  // documented fund-loss desync. (website/ chooseRefinedPayToken parity.)
  const [tokenTouched, setTokenTouched] = useState(false)
  // The (address+route) identity of the user's pick, so a background refetch or
  // chain switch remaps the index to the same token rather than clobbering it.
  const selectedKeyRef = useRef<string | null>(null)
  const [memo, setMemo] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setDebouncedAmount(amount), 400)
    return () => clearTimeout(t)
  }, [amount])

  const chainMeta = JB_CHAINS[chainId]
  const nativeSymbol = 'ETH'

  // ---- The project's payment surface: accepted tokens + live ruleset ----
  // Direct tokens = the project's accounting contexts (viaRouter:false). When
  // the project also lists the router terminal, native ETH and/or USDC that
  // it does NOT accept directly are offered as swap-via-router options — but
  // ONLY when `routerPayRouteWorks` confirms the router can route them (else a
  // dead route reverts at pay time). Built atomically so the token list is
  // never a partial/desynced snapshot.
  const { data: surface, isError: surfaceError } = useQuery<PaySurface>({
    queryKey: ['paySurface', chainId, projectId],
    enabled: !!publicClient,
    staleTime: 60_000,
    retry: 1,
    queryFn: async (): Promise<PaySurface> => {
      const client = publicClient!
      const pid = BigInt(projectId)
      const args = { chainId, projectId: pid }
      const directory =
        jbContractAddress['6'][JBCoreContracts.JBDirectory][chainId]
      const multiTerminal =
        jbContractAddress['6'][JBCoreContracts.JBMultiTerminal][chainId]
      const routerRegistry = jbContractAddress['6'][
        JBRouterTerminalContracts.JBRouterTerminalRegistry
      ]?.[chainId] as Address | undefined
      const directRouter = (
        jbContractAddress['6'][JBRouterTerminalContracts.JBRouterTerminal] as
          | Record<number, Address>
          | undefined
      )?.[chainId]

      const [contexts, ruleset, terminalsRaw] = await Promise.all([
        getAccountingContexts(client, args),
        getCurrentRuleset(client, args).catch(() => null),
        client
          .readContract({
            address: directory,
            abi: jbDirectoryAbi,
            functionName: 'terminalsOf',
            args: [pid],
          })
          .catch(() => [] as readonly Address[]),
      ])

      const direct: PayContext[] = await Promise.all(
        contexts.map(async ctx => ({
          token: ctx.token,
          decimals: ctx.decimals,
          currency: ctx.currency,
          viaRouter: false,
          symbol: await tokenSymbol(client, ctx.token, { nativeSymbol }),
        })),
      )

      const terminals = (terminalsRaw ?? []).filter(Boolean) as Address[]
      const sameAddr = (a?: Address, b?: Address) =>
        !!a && !!b && a.toLowerCase() === b.toLowerCase()
      const hasRouter = terminals.some(
        t => sameAddr(t, routerRegistry) || sameAddr(t, directRouter),
      )
      const known = new Set(
        [multiTerminal, routerRegistry, directRouter]
          .filter(Boolean)
          .map(a => (a as Address).toLowerCase()),
      )
      const unknown = terminals.filter(t => !known.has(t.toLowerCase()))

      // Router candidates: ETH/USDC that aren't already accepted directly,
      // each gated by an actual previewPayFor route probe.
      const has = (a: Address) =>
        direct.some(t => t.token.toLowerCase() === a.toLowerCase())
      let routable: PayContext[] = []
      if (hasRouter && routerRegistry) {
        const candidates: PayContext[] = []
        if (!has(NATIVE_TOKEN)) {
          candidates.push({
            token: NATIVE_TOKEN,
            decimals: 18,
            currency: tokenCurrencyId(NATIVE_TOKEN),
            symbol: nativeSymbol,
            viaRouter: true,
          })
        }
        const usdc = USDC_ADDRESSES[chainId as JBChainId]
        if (usdc && !has(usdc)) {
          candidates.push({
            token: usdc,
            decimals: 6,
            currency: tokenCurrencyId(usdc),
            symbol: 'USDC',
            viaRouter: true,
          })
        }
        const gated = await Promise.all(
          candidates.map(async c =>
            (await routerPayRouteWorks(
              client,
              chainId,
              projectId,
              routerRegistry,
              c.token,
              c.decimals,
            ))
              ? c
              : null,
          ),
        )
        routable = gated.filter((c): c is PayContext => c !== null)
      }

      return {
        contexts: [...direct, ...routable],
        rulesetStart: ruleset ? ruleset.ruleset.start : 0,
        pausePay: ruleset ? ruleset.metadata.pausePay : false,
        terminals,
        unknown,
      }
    },
  })

  // The project's OWN token symbol ("You get X MARKEE") — resolved on-chain,
  // NOT bendystraw's accounting symbol.
  const { data: projectToken } = useProjectTokenSymbol(chainId, projectId)
  const projectTokenLabel = projectToken?.symbol || 'tokens'

  // The empty fallback is only used before the queried pay surface exists.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const contexts = surface?.contexts ?? []
  const context = contexts[Math.min(tokenIndex, contexts.length - 1)] as
    | PayContext
    | undefined
  const symbol = context?.symbol ?? nativeSymbol
  const decimals = context?.decimals ?? 18
  const isNative =
    context?.token.toLowerCase() === NATIVE_TOKEN.toLowerCase() || !context

  // Keep the index in lock-step with the token list as it (re)resolves. If the
  // user hasn't touched the selector, always default to list[0] (the real
  // accounting token). If they have, re-find their exact pick (address+route);
  // if it's gone, fall back to list[0] and forget the touch.
  useEffect(() => {
    const list = surface?.contexts
    if (!list || list.length === 0) return
    if (!tokenTouched) {
      if (tokenIndex !== 0) setTokenIndex(0)
      return
    }
    const key = selectedKeyRef.current
    const idx = key ? list.findIndex(t => payTokenKey(t) === key) : -1
    if (idx >= 0) {
      if (idx !== tokenIndex) setTokenIndex(idx)
    } else {
      selectedKeyRef.current = null
      setTokenTouched(false)
      setTokenIndex(0)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surface, tokenTouched])

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
      const resolved = await getProject721Shop(client, {
        chainId,
        projectId: BigInt(projectId),
        isRevnet,
        tierLimit: 200,
      })
      if (!resolved) return null
      const rawTiers = await client
        .readContract({
          address: resolved.store,
          abi: jb721TiersHookStoreAbi,
          functionName: 'tiersOf',
          args: [resolved.hook, [], true, 0n, 200n],
        })
        .catch(() => [])
      const flagsById = new Map(
        rawTiers.map(rawTier => [rawTier.id, rawTier.flags] as const),
      )
      return {
        hook: resolved.hook,
        idTarget: resolved.metadataIdTarget,
        pricingCurrency: resolved.pricing.currency,
        pricingDecimals: resolved.pricing.decimals,
        tiers: await Promise.all(
          resolved.tiers.map(async t => {
            // Metadata is cosmetic — a tier without it still sells.
            const meta = await resolvePayTierMetadata(t)
            const name = meta?.name ?? null
            const description = meta?.description ?? null
            const image = tierMediaImageUrl(meta?.image) ?? null
            return {
              id: t.id,
              price: t.price,
              discountPercent: t.discountPercent,
              remaining: t.remainingSupply,
              initial: t.initialSupply,
              unlimited: t.initialSupply >= TIER_UNLIMITED_SUPPLY,
              // Fail closed if a legacy store does not return flags: charging
              // fresh funds is safer than underfunding a credit-restricted mint.
              cantBuyWithCredits:
                flagsById.get(t.id)?.cantBuyWithCredits ?? true,
              name,
              description,
              image,
            }
          }),
        ),
      }
    },
  })

  // Keep the shared cart's presentation metadata fresh even before the user
  // opens the Shop tab. Clamp stale quantities against live per-chain supply.
  useEffect(() => {
    if (!shop) return
    const liveIds = new Set(shop.tiers.map(tier => tier.id))
    for (const tier of shop.tiers) {
      registerItem({
        tierId: tier.id,
        name: tier.name ?? `Item #${tier.id}`,
        image: tier.image ?? undefined,
      })
      const quantity = cart[tier.id] ?? 0
      const cap = tier.unlimited ? 99 : tier.remaining
      if (quantity > cap) setQuantity(tier.id, cap)
    }
    for (const id of Object.keys(cart).map(Number)) {
      if (!liveIds.has(id)) setQuantity(id, 0)
    }
  }, [shop, cart, registerItem, setQuantity])

  const { data: shopCredits = 0n, isLoading: shopCreditsLoading } = useQuery({
    queryKey: ['payShopCredits', chainId, shop?.hook, address],
    enabled: !!publicClient && !!shop && !!address,
    staleTime: 15_000,
    retry: 1,
    queryFn: () =>
      publicClient!.readContract({
        address: shop!.hook,
        abi: jb721TiersHookAbi,
        functionName: 'payCreditsOf',
        args: [address!],
      }),
  })

  // Verify every direct accounting token against the shop's pricing context.
  // JBPrices returns payment-token units per one whole shop-pricing unit;
  // router inputs stay disabled because the hook only sees the post-swap token.
  const { data: shopRoutes, isLoading: shopRoutesLoading } = useQuery({
    queryKey: [
      'payShopRoutes',
      chainId,
      projectId,
      shop?.pricingCurrency,
      shop?.pricingDecimals,
      contexts.map(payTokenKey).join(','),
    ],
    enabled: !!publicClient && !!shop && contexts.length > 0,
    staleTime: 60_000,
    retry: 1,
    queryFn: async (): Promise<Record<string, ShopPayRoute>> => {
      const prices = jbContractAddress['6'][JBCoreContracts.JBPrices][chainId]
      const entries = await Promise.all(
        contexts.map(async payContext => {
          const key = payTokenKey(payContext)
          if (payContext.viaRouter) {
            return [
              key,
              {
                supported: false,
                pricePerUnit: null,
                reason: 'Item checkout requires a directly accepted token.',
              },
            ] as const
          }

          const sameCurrency =
            payContext.currency === shop!.pricingCurrency ||
            (shop!.pricingCurrency === BASE_CURRENCY_ETH &&
              payContext.token.toLowerCase() === NATIVE_TOKEN.toLowerCase())
          if (sameCurrency) {
            return [
              key,
              {
                supported: true,
                pricePerUnit: 10n ** BigInt(payContext.decimals),
              },
            ] as const
          }

          if (!prices) {
            return [
              key,
              {
                supported: false,
                pricePerUnit: null,
                reason: 'No price contract is available on this chain.',
              },
            ] as const
          }
          const pricePerUnit = await publicClient!
            .readContract({
              address: prices,
              abi: jbPricesAbi,
              functionName: 'pricePerUnitOf',
              args: [
                BigInt(projectId),
                BigInt(payContext.currency),
                BigInt(shop!.pricingCurrency),
                BigInt(payContext.decimals),
              ],
            })
            .catch(() => 0n)
          return [
            key,
            pricePerUnit > 0n
              ? { supported: true, pricePerUnit }
              : {
                  supported: false,
                  pricePerUnit: null,
                  reason: 'No price feed converts this payment token.',
                },
          ] as const
        }),
      )
      return Object.fromEntries(entries)
    },
  })
  const selectedShopRoute = context
    ? shopRoutes?.[payTokenKey(context)]
    : undefined
  const shopMatchesToken = !!selectedShopRoute?.supported
  const supportedShopContextIndexes = useMemo(
    () =>
      contexts.flatMap((payContext, index) =>
        shopRoutes?.[payTokenKey(payContext)]?.supported ? [index] : [],
      ),
    [contexts, shopRoutes],
  )

  // Selecting an item from either surface moves the currency selector to the
  // best verified checkout token instead of silently discarding the cart.
  useEffect(() => {
    if (cartCount === 0 || shopRoutesLoading || shopMatchesToken) return
    const preferred = supportedShopContextIndexes
      .map(index => ({ index, context: contexts[index] }))
      .sort((a, b) => {
        const score = (candidate: PayContext) =>
          candidate.currency === shop?.pricingCurrency
            ? 3
            : shop?.pricingCurrency === BASE_CURRENCY_ETH &&
                candidate.token.toLowerCase() === NATIVE_TOKEN.toLowerCase()
              ? 2
              : shop?.pricingCurrency === BASE_CURRENCY_USD &&
                  candidate.symbol.toUpperCase() === 'USDC'
                ? 2
                : 1
        return score(b.context) - score(a.context)
      })[0]
    if (!preferred) return
    setTokenIndex(preferred.index)
    selectedKeyRef.current = payTokenKey(preferred.context)
    setTokenTouched(true)
  }, [
    cartCount,
    shopRoutesLoading,
    shopMatchesToken,
    supportedShopContextIndexes,
    contexts,
    shop?.pricingCurrency,
  ])

  const shopPricingSymbol =
    shop?.pricingCurrency === BASE_CURRENCY_ETH
      ? nativeSymbol
      : shop?.pricingCurrency === BASE_CURRENCY_USD
        ? 'USD'
        : (contexts.find(c => c.currency === shop?.pricingCurrency)?.symbol ??
          'units')
  const cartTotal = useMemo(() => {
    if (!shop || cartCount === 0) return 0n
    return shop.tiers.reduce(
      (sum, tier) =>
        sum +
        effectiveTierPrice(tier.price, tier.discountPercent) *
          BigInt(cart[tier.id] ?? 0),
      0n,
    )
  }, [shop, cart, cartCount])
  const restrictedCartTotal = useMemo(() => {
    if (!shop) return 0n
    return shop.tiers.reduce(
      (sum, tier) =>
        sum +
        (tier.cantBuyWithCredits
          ? effectiveTierPrice(tier.price, tier.discountPercent) *
            BigInt(cart[tier.id] ?? 0)
          : 0n),
      0n,
    )
  }, [shop, cart])
  const shopCreditApplied = useMemo(() => {
    const eligible = cartTotal - restrictedCartTotal
    if (eligible <= 0n || shopCredits <= 0n) return 0n
    return shopCredits < eligible ? shopCredits : eligible
  }, [cartTotal, restrictedCartTotal, shopCredits])
  const cartAmountDue = cartTotal - shopCreditApplied
  const selectedCartRows = useMemo(
    () =>
      Object.entries(cart)
        .filter(([, quantity]) => quantity > 0)
        .map(([rawId, quantity]) => {
          const tierId = Number(rawId)
          const tier = shop?.tiers.find(candidate => candidate.id === tierId)
          const registered = cartItems[tierId]
          return {
            tierId,
            quantity,
            name:
              registered?.name ?? tier?.name ?? `Item #${tierId}`,
            image: registered?.image ?? tier?.image ?? undefined,
            cap: tier ? (tier.unlimited ? 99 : tier.remaining) : quantity,
          }
        })
        .sort((a, b) => a.tierId - b.tierId),
    [cart, cartItems, shop],
  )

  // Keep the entered amount at least the verified checkout total. The price
  // feed is expressed in payment-token units and this direction rounds up,
  // exactly matching the hook's fail-safe normalization.
  const cartTotalInToken = useMemo(() => {
    const pricePerUnit = selectedShopRoute?.pricePerUnit
    if (
      !shop ||
      mode !== 'pay' ||
      cartAmountDue === 0n ||
      !context ||
      !selectedShopRoute?.supported ||
      !pricePerUnit
    ) {
      return 0n
    }
    const denominator = 10n ** BigInt(shop.pricingDecimals)
    return (cartAmountDue * pricePerUnit + denominator - 1n) / denominator
  }, [shop, mode, cartAmountDue, context, selectedShopRoute])

  useEffect(() => {
    if (mode !== 'pay' || cartCount === 0 || !shopMatchesToken) return
    const current = (() => {
      try {
        return parseUnits(amount.trim() || '0', decimals)
      } catch {
        return 0n
      }
    })()
    if (current === cartTotalInToken) return
    const next = formatUnits(cartTotalInToken, decimals)
    setAmount(next)
    setDebouncedAmount(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cartTotalInToken, cartCount, shopMatchesToken, mode])

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
          metadataIdTarget: shop.idTarget,
          tierIdsToMint: tierIds,
        })
      : undefined

  // ---- Terminal + preview ----
  // viaRouter tokens are paid through the JBRouterTerminalRegistry (which swaps
  // them into the project's accounting token); direct tokens go to the
  // JBMultiTerminal. Preview, allowance, approval, and pay all target this.
  const multiTerminal =
    jbContractAddress['6'][JBCoreContracts.JBMultiTerminal][chainId]
  const routerRegistry = jbContractAddress['6'][
    JBRouterTerminalContracts.JBRouterTerminalRegistry
  ]?.[chainId] as Address | undefined
  const terminalAddress = !context
    ? undefined
    : context.viaRouter
      ? routerRegistry
      : multiTerminal

  const {
    data: preview,
    isFetching: previewLoading,
    isError: previewError,
    isPlaceholderData: previewIsPrevious,
  } = useQuery({
    queryKey: [
      'previewPay',
      chainId,
      projectId,
      context?.token,
      context?.viaRouter,
      terminalAddress,
      amountRaw.toString(),
      metadata ?? '0x',
    ],
    enabled:
      !!publicClient &&
      !!context &&
      !!terminalAddress &&
      (amountRaw > 0n || cartCount > 0) &&
      mode === 'pay',
    // Keep the last verified quote mounted while the next amount is quoted.
    // The receipt gently dims it below, and submission stays blocked until the
    // fresh quote arrives.
    placeholderData: previous => previous,
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
  const previewReady =
    mode === 'addbalance' ||
    (!!preview && !previewError && !previewLoading && !previewIsPrevious)
  // Floor the guaranteed minimum at 99% of the preview (website parity): a
  // buyback-routed or USD-issuance pay legitimately drifts between preview
  // and inclusion, and an exact min would make ordinary pays revert. A
  // verified zero stays zero.
  const minReturned = ((preview?.beneficiaryTokenCount ?? 0n) * 99n) / 100n

  // ---- ERC-20 allowance ----
  // Direct pays approve the JBMultiTerminal; swap-via-router ERC-20 pays approve
  // the JBRouterTerminalRegistry. The registry's _transferFrom checks a plain
  // ERC-20 allowance FIRST (JBRouterTerminalRegistry.sol) and pulls via
  // safeTransferFrom when it covers the amount — so a single simulated
  // approve(terminal, amount), identical to the direct path, satisfies it. No
  // Permit2 signature is needed, so nothing bypasses useSafeTx.
  const { data: allowance, refetch: refetchAllowance } = useQuery({
    queryKey: [
      'payAllowance',
      chainId,
      context?.token,
      terminalAddress,
      address,
    ],
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

  // ---- Terminal-surface safety (website/ renderTerminalNotice parity) ----
  // Fail closed: the target terminal MUST be listed among the project's
  // terminals (JBDirectory.terminalsOf), or paying is blocked. Listed
  // terminals we don't recognize are a non-blocking note (surface.unknown).
  const surfaceTerminals = surface?.terminals ?? []
  const terminalListed =
    !terminalAddress ||
    surfaceTerminals.some(t => t.toLowerCase() === terminalAddress.toLowerCase())
  const terminalBlocked = !!surface && !!terminalAddress && !terminalListed
  // Add-to-balance has no on-chain minimum-output field, so a router swap can't
  // be bounded — refuse it (website/ 6439 parity), only direct tokens top up.
  const addBalanceViaRouter = mode === 'addbalance' && !!context?.viaRouter

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
    const creditOnlyCheckout =
      mode === 'pay' && cartCount > 0 && cartAmountDue === 0n
    if (
      !context ||
      !terminalAddress ||
      (amountRaw <= 0n && !creditOnlyCheckout) ||
      busy ||
      (cartCount > 0 && shopCreditsLoading)
    ) {
      return
    }
    // Fail-closed guards: never send to an unlisted terminal, and never try to
    // top up a balance with a router swap (no min-output bound).
    if (terminalBlocked || addBalanceViaRouter) return
    if (needsApproval) {
      void approveTx.send(
        buildErc20ApproveRequest({
          chainId,
          token: context.token,
          spender: terminalAddress,
          amount: amountRaw,
        }),
      )
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
      void tx.send(
        buildAddToBalanceRequest({
          chainId,
          terminal: terminalAddress,
          projectId: BigInt(projectId),
          token: context.token,
          amount: amountRaw,
          memo: memo.trim(),
        }),
      )
    }
  }

  const reset = () => {
    tx.reset()
    approveTx.reset()
    setAmount('')
    setDebouncedAmount('')
    setMemo('')
    clearCart()
  }

  useEffect(() => {
    if (tx.phase === 'success' && cartCount > 0) clearCart()
  }, [tx.phase, cartCount, clearCart])

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
      {/* Shop strip */}
      {shop && shop.tiers.length > 0 && mode === 'pay' ? (
        <div className="mt-4">
          <div className="flex items-center justify-between gap-3">
            <span className="field-label">Shop</span>
            <button
              type="button"
              onClick={() => {
                window.location.hash = 'shop'
              }}
              className="text-xs font-medium text-bluebs-600 hover:underline"
            >
              All →
            </button>
          </div>
          {cartCount > 0 && shopRoutesLoading ? (
            <Skeleton className="mt-2 h-3 w-40 rounded" role="status" aria-label="Loading checkout currencies" />
          ) : cartCount > 0 && supportedShopContextIndexes.length === 0 ? (
            <p className="mt-1 text-xs leading-relaxed text-red-600">
              No directly accepted payment token has a verified price feed for
              these items on {chainName(chainId)}.
            </p>
          ) : cartCount > 0 && !shopMatchesToken ? (
            <p className="mt-1 text-xs leading-relaxed text-smoke-700">
              Switching to a supported checkout currency…
            </p>
          ) : null}

          <div className="mt-2 flex gap-2 overflow-x-auto pb-3">
            {shop.tiers.slice(0, 12).map(tier => {
                const qty = cart[tier.id] ?? 0
                const soldOut = !tier.unlimited && tier.remaining === 0
                const cap = tier.unlimited ? 99 : tier.remaining
                const price = effectiveTierPrice(
                  tier.price,
                  tier.discountPercent,
                )
                const item = {
                  tierId: tier.id,
                  name: tier.name ?? `Item #${tier.id}`,
                  image: tier.image ?? undefined,
                }
                return (
                  <div
                    key={tier.id}
                    className={`relative w-24 shrink-0 overflow-hidden rounded-lg border bg-white text-center transition ${
                      qty > 0
                        ? 'border-bluebs-500 bg-bluebs-25'
                        : 'border-smoke-200 hover:border-bluebs-300'
                    } ${soldOut ? 'opacity-40' : ''}`}
                  >
                    {qty > 0 ? (
                      <span className="absolute right-1.5 top-1.5 z-10 flex h-5 min-w-5 items-center justify-center rounded-full bg-bluebs-600 px-1 text-[10px] font-medium text-white">
                        {qty}
                      </span>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => {
                        if (soldOut || qty > 0) return
                        setQuantity(tier.id, 1, item)
                      }}
                      disabled={busy || soldOut}
                      className="block w-full disabled:cursor-not-allowed"
                      title={
                        soldOut
                          ? `${item.name} is sold out`
                          : `Add ${item.name} to cart`
                      }
                    >
                      {tier.image ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={tier.image}
                          alt={item.name}
                          loading="lazy"
                          decoding="async"
                          className="block aspect-square w-full object-contain"
                        />
                      ) : (
                        <span className="flex aspect-square w-full items-center justify-center bg-smoke-75 text-xs text-smoke-500">
                          #{tier.id}
                        </span>
                      )}
                    </button>
                    {soldOut ? (
                      <p className="px-2 pb-2 text-[10px] text-smoke-500">
                        Sold out
                      </p>
                    ) : qty === 0 ? (
                      <button
                        type="button"
                        onClick={() => setQuantity(tier.id, 1, item)}
                        disabled={busy}
                        className="w-full px-2 pb-2 text-[11px] text-smoke-700"
                      >
                        {formatTokenAmount(price, shop.pricingDecimals)}{' '}
                        {shopPricingSymbol}
                      </button>
                    ) : (
                      <QuantityStepper
                        size="sm"
                        quantity={qty}
                        itemName={item.name}
                        onRemove={() => setQuantity(tier.id, qty - 1, item)}
                        onAdd={() =>
                          setQuantity(tier.id, Math.min(cap, qty + 1), item)
                        }
                        disabledRemove={busy || qty === 0}
                        disabledAdd={busy || qty >= cap}
                      />
                    )}
                  </div>
                )
            })}
          </div>
        </div>
      ) : null}

      {/* Mode on chain — subtle underlined text dropdowns (website/ parity) */}
      <div className={`${shop && shop.tiers.length > 0 && mode === 'pay' ? 'mt-4' : ''} flex flex-wrap items-center gap-x-1.5 gap-y-1 text-base text-smoke-700`}>
        <TextSelect
          value={mode}
          onChange={v => setMode(v as 'pay' | 'addbalance')}
          disabled={busy}
          ariaLabel="Payment mode"
          options={[
            { value: 'pay', label: 'Pay' },
            { value: 'addbalance', label: 'Add to balance' },
          ]}
        />
        <span>on</span>
        {chains.length > 1 ? (
            <TextSelect
              value={String(chainId)}
              onChange={v => {
                const next = chains.find(([cid]) => cid === Number(v))
                if (!next) return
                setDeployment({
                  chainId: next[0] as JBChainId,
                  projectId: next[1],
                })
                setTokenIndex(0)
                setTokenTouched(false)
                selectedKeyRef.current = null
                clearCart()
                setAmount('')
                setDebouncedAmount('')
              }}
              disabled={busy}
              ariaLabel="Chain"
              options={chains.map(([cid]) => ({
                value: String(cid),
                label: payChainName(cid as JBChainId),
              }))}
            />
        ) : (
          <span className="whitespace-nowrap">{payChainName(chainId)}</span>
        )}
      </div>
      {mode === 'addbalance' ? (
        <p className="mt-1.5 text-xs leading-relaxed text-smoke-700">
          Adds funds without minting tokens — useful for refills and refunds.
        </p>
      ) : null}

      {/* Amount + token + pay, inline (website/ parity) */}
      <div className="mt-3">
        <div className="input-well flex items-stretch overflow-hidden !p-0">
          <input
            type="text"
            inputMode="decimal"
            value={amount}
            onChange={e => setAmount(e.target.value)}
            disabled={busy}
            placeholder="0.00"
            aria-label="Amount"
            className="min-w-0 flex-1 bg-transparent px-4 py-3 text-lg font-medium outline-none placeholder:text-smoke-500 disabled:opacity-60"
          />
          {contexts.length > 1 ? (
            // Valued by INDEX, not address — a token can appear direct and
            // via-router, so the option must stay in lock-step with the
            // selected context (website/ fund-loss fix).
            <TextSelect
              value={String(tokenIndex)}
              onChange={value => {
                const i = Number(value)
                setTokenIndex(i)
                // Remember the explicit pick so a refetch/chain-switch remaps
                // to this exact token instead of snapping back to list[0].
                const picked = contexts[i]
                if (picked) selectedKeyRef.current = payTokenKey(picked)
                setTokenTouched(true)
              }}
              disabled={busy}
              ariaLabel="Payment token"
              className="relative flex min-h-11 shrink-0 items-center gap-1 px-2 text-sm font-medium text-smoke-700"
              labelClassName=""
              selectClassName="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
              options={contexts.map((ctx, i) => ({
                value: String(i),
                label: ctx.symbol,
                disabled:
                  cartCount > 0 &&
                  !shopRoutes?.[payTokenKey(ctx)]?.supported,
              }))}
            />
          ) : (
            <span className="flex shrink-0 items-center pr-3 text-sm font-medium text-smoke-700">
              {symbol}
            </span>
          )}
          <button
            onClick={submit}
            disabled={
              busy ||
              notStarted ||
              surfaceError ||
              terminalBlocked ||
              addBalanceViaRouter ||
              (isConnected &&
                cartCount > 0 &&
                (shopRoutesLoading ||
                  shopCreditsLoading ||
                  !shopMatchesToken)) ||
              (surface?.pausePay && mode === 'pay') ||
              (isConnected &&
                ((amountRaw <= 0n &&
                  !(
                    mode === 'pay' &&
                    cartCount > 0 &&
                    cartAmountDue === 0n
                  )) ||
                  (mode === 'pay' && !previewReady)))
            }
            className="btn-primary shrink-0 rounded-l-none px-5 text-sm disabled:opacity-60"
          >
            {notStarted
              ? 'Soon'
              : !isConnected
                ? 'Sign in'
                : busy
                  ? '…'
                  : needsApproval
                    ? 'Approve'
                    : mode === 'pay'
                      ? 'Pay'
                      : 'Add'}
          </button>
        </div>
        {notStarted ? (
          <p className="mt-1.5 text-xs text-smoke-700">
            Starts in {formatStartCountdown(startsAt - now)}.
          </p>
        ) : null}
      </div>

      {/* Note — always present, optional */}
      <input
        type="text"
        value={memo}
        onChange={e => setMemo(e.target.value.slice(0, 256))}
        disabled={busy}
        placeholder="Add a note (optional)"
        aria-label="Note"
        className="input-well mt-3 min-h-[44px] px-3.5 text-sm disabled:opacity-60"
      />

      {/* One receipt for project tokens and every selected shop item. */}
      {mode === 'pay' &&
      (cartCount > 0 ||
        (amountRaw > 0n &&
          !previewError &&
          (previewLoading ||
            (preview && preview.beneficiaryTokenCount > 0n)))) ? (
        <div className="mt-4">
          <p className="text-xs text-smoke-500">You get</p>
          {preview && preview.beneficiaryTokenCount > 0n ? (
            <p
              aria-live="polite"
              aria-busy={previewLoading}
              className={`font-agrandir text-xl font-medium transition-colors duration-200 ${
                previewLoading ? 'text-smoke-500' : 'text-ink'
              }`}
            >
              {formatTokenAmount(preview.beneficiaryTokenCount, 18)}{' '}
              {projectTokenLabel}
            </p>
          ) : amountRaw > 0n && previewLoading ? (
            <Skeleton
              className="mt-1 h-7 w-28 rounded"
              role="status"
              aria-label="Calculating token return"
            />
          ) : null}

          {selectedCartRows.length > 0 ? (
            <div className="mt-2 space-y-2 rounded-lg border border-smoke-200 bg-smoke-50 p-2.5">
              {selectedCartRows.map(row => (
                <div
                  key={row.tierId}
                  className="flex min-w-0 items-center gap-2"
                >
                  <span className="text-sm text-smoke-500">+</span>
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded bg-white text-[10px] text-smoke-500">
                    {row.image ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={row.image}
                        alt=""
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      `#${row.tierId}`
                    )}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-xs font-medium text-ink">
                    {row.name}
                  </span>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() =>
                        setQuantity(row.tierId, row.quantity - 1)
                      }
                      disabled={busy}
                      aria-label={`Remove one ${row.name}`}
                      className="flex h-6 w-6 items-center justify-center rounded-full border border-smoke-300 text-xs text-smoke-700 disabled:opacity-40"
                    >
                      −
                    </button>
                    <span className="min-w-4 text-center text-xs tabular-nums text-ink">
                      {row.quantity}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        setQuantity(
                          row.tierId,
                          Math.min(row.cap, row.quantity + 1),
                        )
                      }
                      disabled={busy || row.quantity >= row.cap}
                      aria-label={`Add one ${row.name}`}
                      className="flex h-6 w-6 items-center justify-center rounded-full border border-smoke-300 text-xs text-smoke-700 disabled:opacity-40"
                    >
                      +
                    </button>
                  </div>
                </div>
              ))}
              <div className="space-y-1 border-t border-smoke-200 pt-2 text-xs">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-smoke-600">
                    {cartCount} item{cartCount === 1 ? '' : 's'}
                  </span>
                  <span className="tabular-nums text-ink">
                    {formatTokenAmount(cartTotal, shop?.pricingDecimals ?? 18)}{' '}
                    {shopPricingSymbol}
                  </span>
                </div>
                {address && shopCreditsLoading ? (
                  <div className="flex items-center justify-between gap-3 text-smoke-500">
                    <span>Shop credit</span>
                    <Skeleton className="h-4 w-16 rounded" role="status" aria-label="Loading shop credit" />
                  </div>
                ) : shopCreditApplied > 0n ? (
                  <div className="flex items-center justify-between gap-3 text-emerald-700">
                    <span>Shop credit applied</span>
                    <span className="tabular-nums">
                      −
                      {formatTokenAmount(
                        shopCreditApplied,
                        shop?.pricingDecimals ?? 18,
                      )}{' '}
                      {shopPricingSymbol}
                    </span>
                  </div>
                ) : null}
                {restrictedCartTotal > 0n ? (
                  <div className="flex items-center justify-between gap-3 text-smoke-500">
                    <span>Fresh payment required</span>
                    <span className="tabular-nums">
                      {formatTokenAmount(
                        restrictedCartTotal,
                        shop?.pricingDecimals ?? 18,
                      )}{' '}
                      {shopPricingSymbol}
                    </span>
                  </div>
                ) : null}
                <div className="flex items-center justify-between gap-3 pt-0.5 font-medium">
                  <span className="text-ink">Amount due</span>
                  <span className="tabular-nums text-ink">
                    {formatTokenAmount(
                      cartAmountDue,
                      shop?.pricingDecimals ?? 18,
                    )}{' '}
                    {shopPricingSymbol}
                  </span>
                </div>
              </div>
            </div>
          ) : null}

          {preview && preview.reservedTokenCount > 0n ? (
            <p className="mt-1.5 text-xs text-smoke-500">
              Splits get {formatTokenAmount(preview.reservedTokenCount, 18)}{' '}
              {projectTokenLabel}
            </p>
          ) : null}
        </div>
      ) : null}
      {mode === 'pay' && amountRaw > 0n && previewError ? (
        <p className="mt-2 text-sm text-red-600">
          Couldn&apos;t verify what this payment returns — paying is disabled
          until the preview works.
        </p>
      ) : null}

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
      {addBalanceViaRouter ? (
        <p className="mt-3 text-sm text-smoke-700">
          Add to balance only supports tokens the project accepts directly —
          switch to a direct token, or use Pay to route this one.
        </p>
      ) : null}
      {terminalBlocked ? (
        <p className="mt-3 text-sm text-red-600">
          This project doesn&apos;t list the{' '}
          {context?.viaRouter ? 'router' : 'direct'} payment terminal on{' '}
          {chainName(chainId)}. Review the project contracts before paying.
        </p>
      ) : null}
      {!terminalBlocked && surface?.unknown && surface.unknown.length > 0 ? (
        <p className="mt-3 text-xs leading-relaxed text-smoke-700">
          This project also lists unknown payment terminal
          {surface.unknown.length > 1 ? 's' : ''}:{' '}
          {surface.unknown
            .map(a => `${a.slice(0, 6)}…${a.slice(-4)}`)
            .join(', ')}
          . This form only sends to a recognized Juicebox terminal.
        </p>
      ) : null}
      {(approveTx.error ?? tx.error) ? (
        <p className="mt-3 text-sm text-red-600">
          {approveTx.error ?? tx.error}
        </p>
      ) : null}
    </div>
  )
}

/** A subtle underlined-text dropdown (website/ parity: sizeSelectToText) —
 *  a native select styled as bold underlined text with a caret. The class
 *  overrides let the pay-token selector restyle the same structure (plain
 *  label, not-allowed disabled cursor) without duplicating the overlay. */
function TextSelect({
  value,
  onChange,
  options,
  disabled,
  ariaLabel,
  className = 'relative inline-flex min-h-11 items-center gap-1',
  labelClassName = 'font-medium text-ink underline decoration-smoke-300 decoration-1 underline-offset-4',
  selectClassName = 'absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-default',
}: {
  value: string
  onChange: (value: string) => void
  options: { value: string; label: string; disabled?: boolean }[]
  disabled?: boolean
  ariaLabel: string
  className?: string
  labelClassName?: string
  selectClassName?: string
}) {
  // A native <select> sizes to its WIDEST option, which would leave a gap
  // between a short label and the caret. So show the current label + caret as
  // tight visible text and overlay a transparent, full-cover select for the
  // real (native) dropdown.
  const current = options.find(o => o.value === value)?.label ?? ''
  return (
    <span className={`${className} ${disabled ? 'opacity-60' : ''}`}>
      <span className={labelClassName || undefined}>{current}</span>
      <svg
        viewBox="0 0 24 24"
        className="h-3.5 w-3.5 shrink-0 text-smoke-500"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="m6 9 6 6 6-6" />
      </svg>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        disabled={disabled}
        aria-label={ariaLabel}
        className={selectClassName}
      >
        {options.map(o => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
    </span>
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
