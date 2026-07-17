'use client'

import {
  JB_CHAINS,
  JBCoreContracts,
  JBOmnichainDeployerContracts,
  JBRouterTerminalContracts,
  NATIVE_TOKEN,
  jb721TiersHookAbi,
  jb721TiersHookStoreAbi,
  jbContractAddress,
  jbDirectoryAbi,
  jbMultiTerminalAbi,
  jbOmnichainDeployerAbi,
  jbRouterTerminalRegistryAbi,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import {
  build721PayMetadata,
  buildPayTx,
  getAccountingContexts,
  getCurrentRuleset,
  getRevnetTiered721Hook,
  getTokenAddress,
  previewPay,
} from '@bananapus/nana-sdk-core/v6'
import { useQuery } from '@tanstack/react-query'
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
import { useSafeTx } from '@/hooks/useSafeTx'
import { useWallet } from '@/hooks/useWallet'
import { formatTokenAmount, ipfsUrl } from '@/lib/format'
import { chainName } from '@/lib/urn'

const TIER_UNLIMITED_SUPPLY = 999_999_999

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

// Canonical Circle USDC per chain (lowercased to skip viem checksum
// validation). Offered as a swap-via-router pay currency on projects that have
// the router terminal — website/ USDC_BY_CHAIN parity.
const USDC_BY_CHAIN: Record<number, Address> = {
  1: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  10: '0x0b2c639c533813f4aa9d7837caf62653d097ff85',
  8453: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  42161: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
  84532: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
  11155111: '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238',
  11155420: '0x5fd84259d66cd46123540766be93dfe6d43130d7',
  421614: '0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d',
}

const ROUTER_PROBE_BENEFICIARY: Address =
  '0x0000000000000000000000000000000000000001'

/** The accounting-context currency id of a token: `uint32(uint160(token))`.
 *  Used for router candidates (direct tokens carry the context's own currency). */
function tokenCurrencyId(token: Address): number {
  return Number(BigInt(token) & 0xffffffffn)
}

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

  // The chain being paid — a project lives on every linked chain, and the
  // payer picks which one. projectId can differ per chain (sucker groups).
  const [chainId, setChainId] = useState<JBChainId>(initialChainId)
  const projectId =
    chains.find(([c]) => c === chainId)?.[1] ?? initialProjectId

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
  const [cart, setCart] = useState<Record<number, number>>({})

  useEffect(() => {
    const t = setTimeout(() => setDebouncedAmount(amount), 400)
    return () => clearTimeout(t)
  }, [amount])

  const chainMeta = JB_CHAINS[chainId]
  const nativeSymbol = chainMeta?.nativeTokenSymbol ?? 'ETH'

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
          symbol:
            ctx.token.toLowerCase() === NATIVE_TOKEN.toLowerCase()
              ? nativeSymbol
              : await client
                  .readContract({
                    address: ctx.token,
                    abi: erc20Abi,
                    functionName: 'symbol',
                  })
                  .catch(() => 'TOKEN'),
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
        const usdc = USDC_BY_CHAIN[chainId]
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
  const { data: projectSymbol } = useQuery({
    queryKey: ['payProjectSymbol', chainId, projectId],
    enabled: !!publicClient,
    staleTime: 5 * 60_000,
    retry: 1,
    queryFn: async (): Promise<string | null> => {
      const token = await getTokenAddress(publicClient!, {
        chainId,
        projectId: BigInt(projectId),
      })
      if (!token) return null
      return (await publicClient!.readContract({
        address: token,
        abi: erc20Abi,
        functionName: 'symbol',
      })) as string
    },
  })
  const projectTokenLabel = projectSymbol || 'tokens'

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
    if (!context || !terminalAddress || amountRaw <= 0n || busy) return
    // Fail-closed guards: never send to an unlisted terminal, and never try to
    // top up a balance with a router swap (no min-output bound).
    if (terminalBlocked || addBalanceViaRouter) return
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
      {/* Mode on chain — subtle underlined text dropdowns (website/ parity) */}
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-base text-smoke-700">
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
        {chains.length > 1 ? (
          <>
            <span>on</span>
            <TextSelect
              value={String(chainId)}
              onChange={v => {
                setChainId(Number(v) as JBChainId)
                setTokenIndex(0)
                setTokenTouched(false)
                selectedKeyRef.current = null
                setCart({})
                setAmount('')
                setDebouncedAmount('')
              }}
              disabled={busy}
              ariaLabel="Chain"
              options={chains.map(([cid]) => ({
                value: String(cid),
                label: chainName(cid),
              }))}
            />
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
                        ? 'border-bluebs-500 bg-bluebs-25'
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
            <select
              // Valued by INDEX, not address — a token can appear direct and
              // via-router, so the option must stay in lock-step with the
              // selected context (website/ fund-loss fix).
              value={tokenIndex}
              onChange={e => {
                const i = Number(e.target.value)
                setTokenIndex(i)
                // Remember the explicit pick so a refetch/chain-switch remaps to
                // this exact token instead of snapping back to list[0].
                const picked = contexts[i]
                if (picked) selectedKeyRef.current = payTokenKey(picked)
                setTokenTouched(true)
                setCart({})
              }}
              disabled={busy}
              aria-label="Payment token"
              className="select-caret !w-auto shrink-0 border-0 bg-transparent pl-2 pr-7 text-sm font-medium text-smoke-700 focus:outline-none disabled:opacity-60"
            >
              {contexts.map((ctx, i) => (
                <option key={`${ctx.token}-${i}`} value={i}>
                  {ctx.symbol}
                </option>
              ))}
            </select>
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
              (surface?.pausePay && mode === 'pay') ||
              (isConnected &&
                (amountRaw <= 0n || (mode === 'pay' && !previewReady)))
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

      {/* You get — only once an amount mints a non-zero token count */}
      {mode === 'pay' &&
      amountRaw > 0n &&
      !previewLoading &&
      !previewError &&
      preview &&
      preview.beneficiaryTokenCount > 0n ? (
        <div className="mt-4">
          <p className="text-xs text-smoke-500">You get</p>
          <p className="font-agrandir text-xl font-medium text-ink">
            {formatTokenAmount(preview.beneficiaryTokenCount, 18)}{' '}
            {projectTokenLabel}
          </p>
          {preview.reservedTokenCount > 0n ? (
            <p className="mt-0.5 text-xs text-smoke-500">
              Splits get {formatTokenAmount(preview.reservedTokenCount, 18)}{' '}
              {projectTokenLabel}
            </p>
          ) : null}
          {cartCount > 0 ? (
            <p className="mt-0.5 text-xs text-smoke-500">
              + {cartCount} item{cartCount === 1 ? '' : 's'} from the shop.
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
 *  a native select styled as bold underlined text with a caret. */
function TextSelect({
  value,
  onChange,
  options,
  disabled,
  ariaLabel,
}: {
  value: string
  onChange: (value: string) => void
  options: { value: string; label: string }[]
  disabled?: boolean
  ariaLabel: string
}) {
  // A native <select> sizes to its WIDEST option, which would leave a gap
  // between a short label and the caret. So show the current label + caret as
  // tight visible text and overlay a transparent, full-cover select for the
  // real (native) dropdown.
  const current = options.find(o => o.value === value)?.label ?? ''
  return (
    <span
      className={`relative inline-flex items-center gap-1 ${
        disabled ? 'opacity-60' : ''
      }`}
    >
      <span className="font-medium text-ink underline decoration-smoke-300 decoration-1 underline-offset-4">
        {current}
      </span>
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
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-default"
      >
        {options.map(o => (
          <option key={o.value} value={o.value}>
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
