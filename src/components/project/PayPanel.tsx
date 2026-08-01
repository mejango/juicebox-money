"use client";

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
} from "@bananapus/nana-sdk-core";
import {
  BASE_CURRENCY_ETH,
  BASE_CURRENCY_USD,
  build721PayMetadata,
  buildPermit2ApproveTx,
  buildPayTx,
  buildUniswapV4ExactInputSwapTx,
  chooseBestPayRoute,
  effectiveTierPrice,
  getAccountingContexts,
  getCurrentRuleset,
  getProject721Shop,
  previewPay,
  quoteUniswapV4ExactInputSingle,
  tokenCurrencyId,
  uniswapV4Deployment,
} from "@bananapus/nana-sdk-core/v6";
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/Skeleton";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  parseUnits,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { usePublicClient } from "wagmi";
import { useProjectTokenSymbol } from "@/hooks/useProjectTokenSymbol";
import { useSafeTx, type TxRequest } from "@/hooks/useSafeTx";
import { useWallet } from "@/hooks/useWallet";
import { useShopCart } from "@/components/project/ShopCartProvider";
import { QuantityStepper } from "@/components/ui/QuantityStepper";
import { formatTokenAmount } from "@/lib/format";
import {
  TIER_UNLIMITED_SUPPLY,
  parseTierMetadataJson,
  pickTierMetadata,
  tierMediaImageUrl,
} from "@/lib/tier-metadata";
import { tokenSymbol } from "@/lib/token-symbol";
import {
  buildAddToBalanceRequest,
  buildErc20ApproveRequest,
} from "@/lib/transaction-builders";
import { chainName } from "@/lib/urn";
import { isSafeConnection, swapDeadline } from "@/lib/safe-connector";
import { wagmiConfig } from "@/providers/Providers";
import { resolveMarket } from "@/components/project/MarketSection";
import {
  buildTransactionReviewPrompt,
  type TransactionReviewRequest,
} from "@/lib/transaction-review";

function payChainName(chainId: JBChainId): string {
  const compactNames: Partial<Record<JBChainId, string>> = {
    11155420: "OP Sep",
    84532: "Base Sep",
    421614: "Arb Sep",
  };
  return compactNames[chainId] ?? chainName(chainId);
}

type PayContext = {
  token: Address;
  decimals: number;
  currency: number;
  symbol: string;
  /** True when this token is NOT accepted directly and is paid through the
   *  JBRouterTerminalRegistry, which swaps it into the project's accounting
   *  token. False for the project's own directly-accepted accounting tokens. */
  viaRouter: boolean;
};

type PaymentSequenceAction = {
  kind: "token-approval" | "router-approval" | "payment";
  label: string;
  request: TxRequest;
};

type PaySurface = {
  contexts: PayContext[];
  rulesetStart: number;
  pausePay: boolean;
  /** The project's payment terminals (JBDirectory.terminalsOf) — the surface a
   *  pay is fail-closed against: the target terminal MUST appear here. */
  terminals: Address[];
  /** Listed terminals this form doesn't recognize — a non-blocking note. */
  unknown: Address[];
};

const ROUTER_PROBE_BENEFICIARY: Address =
  "0x0000000000000000000000000000000000000001";

/** A stable identity for a pay token — a token can appear both directly AND
 *  via-router, so the key must include the route. */
function payTokenKey(t: Pick<PayContext, "token" | "viaRouter">): string {
  return `${t.token.toLowerCase()}:${t.viaRouter}`;
}

// Whether the router registry can actually route a pay of `token` into
// `projectId` right now (direct forward, swap, or cash-out loop). A listed
// router with no pool/feed path reverts at pay time — offering ETH/USDC there
// is a trap, not a convenience — so a dead route previews an all-zero ruleset
// (ruleset.id == 0). Cached (as a promise) per (chain, project, token), exactly
// like website/ _payRouteCache. Fail-soft: any error resolves false.
const _payRouteCache = new Map<string, Promise<boolean>>();

async function resolvePayTierMetadata(tier: {
  resolvedUri?: string;
  encodedIpfsUri: `0x${string}`;
}) {
  const resolved = tier.resolvedUri
    ? parseTierMetadataJson(tier.resolvedUri)
    : null;
  if (resolved && Object.keys(resolved).length > 0) {
    return pickTierMetadata(resolved);
  }

  const cid = bytes32ToCidV0(tier.encodedIpfsUri);
  if (!cid) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    const response = await fetch(`/api/ipfs/${cid}`, {
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
    if (!response.ok) return null;
    const json = (await response.json()) as unknown;
    return json && typeof json === "object"
      ? pickTierMetadata(json as Record<string, unknown>)
      : null;
  } catch {
    return null;
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
  const key = `${chainId}:${projectId}:${token.toLowerCase()}`;
  let cached = _payRouteCache.get(key);
  if (!cached) {
    cached = client
      .readContract({
        address: registry,
        abi: jbRouterTerminalRegistryAbi,
        functionName: "previewPayFor",
        args: [
          BigInt(projectId),
          token,
          10n ** BigInt(decimals),
          ROUTER_PROBE_BENEFICIARY,
          "0x",
        ],
      })
      .then((out) => {
        // previewPayFor returns [ruleset, ...]; a dead route yields ruleset.id == 0.
        const ruleset = (out as readonly [{ id: number }, ...unknown[]])[0];
        return Number(ruleset?.id ?? 0) !== 0;
      })
      .catch(() => false);
    _payRouteCache.set(key, cached);
  }
  return cached;
}

type ShopInfo = {
  hook: Address;
  /** The metadata id target — the hook's METADATA_ID_TARGET (the shared
   *  implementation), NOT the clone. Keying by the clone address makes the
   *  hook miss the tier ids entirely: payment goes through, no NFT mints. */
  idTarget: Address;
  pricingCurrency: number;
  pricingDecimals: number;
  tiers: {
    id: number;
    price: bigint;
    discountPercent: number;
    remaining: number;
    initial: number;
    unlimited: boolean;
    cantBuyWithCredits: boolean;
    name: string | null;
    description: string | null;
    image: string | null;
  }[];
};

type ShopPayRoute = {
  supported: boolean;
  /** Payment-token units per one whole shop-pricing unit. */
  pricePerUnit: bigint | null;
  reason?: string;
};

const permit2AllowanceAbi = [
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "token", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [
      { name: "amount", type: "uint160" },
      { name: "expiration", type: "uint48" },
      { name: "nonce", type: "uint48" },
    ],
  },
] as const;

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
  chainId: JBChainId;
  projectId: number;
  projectName: string;
  isRevnet: boolean;
  /** [chainId, projectId] pairs across the sucker group (chain selector). */
  chains: [number, number][];
  payDisclosure?: string;
}) {
  const { isConnected, address, openSignIn } = useWallet();
  const {
    quantities: cart,
    items: cartItems,
    count: cartCount,
    setQuantity,
    registerItem,
    clear: clearCart,
  } = useShopCart();

  // The chain being paid — a project lives on every linked chain, and the
  // payer picks which one. projectId can differ per chain (sucker groups).
  const [deployment, setDeployment] = useState<{
    chainId: JBChainId;
    projectId: number;
  }>(() => ({ chainId: initialChainId, projectId: initialProjectId }));
  const { chainId, projectId } = deployment;

  useEffect(() => {
    setDeployment({ chainId: initialChainId, projectId: initialProjectId });
  }, [initialChainId, initialProjectId]);

  const publicClient = usePublicClient({ chainId }) as PublicClient | undefined;
  const tx = useSafeTx(chainId);
  const approveTx = useSafeTx(chainId);
  const routerApproveTx = useSafeTx(chainId);
  // Once an approval is confirmed, every dependent allowance read and final
  // simulation is anchored to that receipt block. Base providers are load
  // balanced, so an unpinned `latest` call can otherwise land on a sibling
  // backend that still sees an expired Permit2 allowance.
  const approvalBlock = [approveTx.receipt, routerApproveTx.receipt].reduce<bigint | undefined>(
    (latest, receipt) =>
      receipt?.status === "success" && (latest === undefined || receipt.blockNumber > latest)
        ? receipt.blockNumber
        : latest,
    undefined,
  );

  const [mode, setMode] = useState<"pay" | "addbalance">("pay");
  const [amount, setAmount] = useState("");
  const [debouncedAmount, setDebouncedAmount] = useState("");
  const [tokenIndex, setTokenIndex] = useState(0);
  // True once the user explicitly picks a pay token. Until then the selection
  // auto-defaults to the project's first accounting token (list[0]) so an
  // ETH/USDC router option never shadows a USDC/ETH project's real token — the
  // documented fund-loss desync. (website/ chooseRefinedPayToken parity.)
  const [tokenTouched, setTokenTouched] = useState(false);
  // The (address+route) identity of the user's pick, so a background refetch or
  // chain switch remaps the index to the same token rather than clobbering it.
  const selectedKeyRef = useRef<string | null>(null);
  const [memo, setMemo] = useState("");
  const [showRouteComparison, setShowRouteComparison] = useState(false);
  const [sequenceOpen, setSequenceOpen] = useState(false);
  const [sequenceStarted, setSequenceStarted] = useState(false);
  const [sequenceComplete, setSequenceComplete] = useState(false);
  const [sequenceStatus, setSequenceStatus] = useState<string | null>(null);
  const [sequenceError, setSequenceError] = useState<string | null>(null);
  const [sequenceSafeStage, setSequenceSafeStage] = useState<
    "token-approval" | "router-approval" | "payment" | null
  >(null);
  const [sequenceActions, setSequenceActions] = useState<PaymentSequenceAction[]>([]);
  const [sequenceActionIndex, setSequenceActionIndex] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedAmount(amount), 400);
    return () => clearTimeout(t);
  }, [amount]);

  const chainMeta = JB_CHAINS[chainId];
  const nativeSymbol = "ETH";

  // ---- The project's payment surface: accepted tokens + live ruleset ----
  // Direct tokens = the project's accounting contexts (viaRouter:false). When
  // the project also lists the router terminal, native ETH and/or USDC that
  // it does NOT accept directly are offered as swap-via-router options — but
  // ONLY when `routerPayRouteWorks` confirms the router can route them (else a
  // dead route reverts at pay time). Built atomically so the token list is
  // never a partial/desynced snapshot.
  const { data: surface, isError: surfaceError } = useQuery<PaySurface>({
    queryKey: ["paySurface", chainId, projectId],
    enabled: !!publicClient,
    staleTime: 60_000,
    retry: 1,
    queryFn: async (): Promise<PaySurface> => {
      const client = publicClient!;
      const pid = BigInt(projectId);
      const args = { chainId, projectId: pid };
      const directory =
        jbContractAddress["6"][JBCoreContracts.JBDirectory][chainId];
      const multiTerminal =
        jbContractAddress["6"][JBCoreContracts.JBMultiTerminal][chainId];
      const routerRegistry = jbContractAddress["6"][
        JBRouterTerminalContracts.JBRouterTerminalRegistry
      ]?.[chainId] as Address | undefined;
      const directRouter = (
        jbContractAddress["6"][JBRouterTerminalContracts.JBRouterTerminal] as
          Record<number, Address> | undefined
      )?.[chainId];

      const [contexts, ruleset, terminalsRaw] = await Promise.all([
        getAccountingContexts(client, args),
        getCurrentRuleset(client, args).catch(() => null),
        client
          .readContract({
            address: directory,
            abi: jbDirectoryAbi,
            functionName: "terminalsOf",
            args: [pid],
          })
          .catch(() => [] as readonly Address[]),
      ]);

      const direct: PayContext[] = await Promise.all(
        contexts.map(async (ctx) => ({
          token: ctx.token,
          decimals: ctx.decimals,
          currency: ctx.currency,
          viaRouter: false,
          symbol: await tokenSymbol(client, ctx.token, { nativeSymbol }),
        })),
      );

      const terminals = (terminalsRaw ?? []).filter(Boolean) as Address[];
      const sameAddr = (a?: Address, b?: Address) =>
        !!a && !!b && a.toLowerCase() === b.toLowerCase();
      const hasRouter = terminals.some(
        (t) => sameAddr(t, routerRegistry) || sameAddr(t, directRouter),
      );
      const known = new Set(
        [multiTerminal, routerRegistry, directRouter]
          .filter(Boolean)
          .map((a) => (a as Address).toLowerCase()),
      );
      const unknown = terminals.filter((t) => !known.has(t.toLowerCase()));

      // Router candidates: ETH/USDC that aren't already accepted directly,
      // each gated by an actual previewPayFor route probe.
      const has = (a: Address) =>
        direct.some((t) => t.token.toLowerCase() === a.toLowerCase());
      let routable: PayContext[] = [];
      if (hasRouter && routerRegistry) {
        const candidates: PayContext[] = [];
        if (!has(NATIVE_TOKEN)) {
          candidates.push({
            token: NATIVE_TOKEN,
            decimals: 18,
            currency: tokenCurrencyId(NATIVE_TOKEN),
            symbol: nativeSymbol,
            viaRouter: true,
          });
        }
        const usdc = USDC_ADDRESSES[chainId as JBChainId];
        if (usdc && !has(usdc)) {
          candidates.push({
            token: usdc,
            decimals: 6,
            currency: tokenCurrencyId(usdc),
            symbol: "USDC",
            viaRouter: true,
          });
        }
        const gated = await Promise.all(
          candidates.map(async (c) =>
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
        );
        routable = gated.filter((c): c is PayContext => c !== null);
      }

      return {
        contexts: [...direct, ...routable],
        rulesetStart: ruleset ? ruleset.ruleset.start : 0,
        pausePay: ruleset ? ruleset.metadata.pausePay : false,
        terminals,
        unknown,
      };
    },
  });

  // The project's OWN token symbol ("You get X MARKEE") — resolved on-chain,
  // NOT bendystraw's accounting symbol.
  const { data: projectToken } = useProjectTokenSymbol(chainId, projectId);
  const projectTokenLabel = projectToken?.symbol || "tokens";

  // The empty fallback is only used before the queried pay surface exists.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const contexts = surface?.contexts ?? [];
  const context = contexts[Math.min(tokenIndex, contexts.length - 1)] as
    PayContext | undefined;
  const symbol = context?.symbol ?? nativeSymbol;
  const decimals = context?.decimals ?? 18;
  const isNative =
    context?.token.toLowerCase() === NATIVE_TOKEN.toLowerCase() || !context;

  // Keep the index in lock-step with the token list as it (re)resolves. If the
  // user hasn't touched the selector, always default to list[0] (the real
  // accounting token). If they have, re-find their exact pick (address+route);
  // if it's gone, fall back to list[0] and forget the touch.
  useEffect(() => {
    const list = surface?.contexts;
    if (!list || list.length === 0) return;
    if (!tokenTouched) {
      if (tokenIndex !== 0) setTokenIndex(0);
      return;
    }
    const key = selectedKeyRef.current;
    const idx = key ? list.findIndex((t) => payTokenKey(t) === key) : -1;
    if (idx >= 0) {
      if (idx !== tokenIndex) setTokenIndex(idx);
    } else {
      selectedKeyRef.current = null;
      setTokenTouched(false);
      setTokenIndex(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surface, tokenTouched]);

  const startsAt = surface?.rulesetStart ?? 0;
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    if (!startsAt || startsAt <= now) return;
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, [startsAt, now]);
  const notStarted = startsAt > now;

  const amountRaw = useMemo(() => {
    try {
      const trimmed = debouncedAmount.trim();
      if (!trimmed || Number(trimmed) <= 0) return 0n;
      return parseUnits(trimmed, decimals);
    } catch {
      return 0n;
    }
  }, [debouncedAmount, decimals]);

  // ---- 721 shop strip: hook + tiers, priced in the shop's currency ----
  const { data: shop } = useQuery({
    queryKey: ["payShop", chainId, projectId, isRevnet],
    enabled: !!publicClient,
    staleTime: 120_000,
    retry: 1,
    queryFn: async (): Promise<ShopInfo | null> => {
      const client = publicClient!;
      const resolved = await getProject721Shop(client, {
        chainId,
        projectId: BigInt(projectId),
        isRevnet,
        tierLimit: 200,
      });
      if (!resolved) return null;
      const rawTiers = await client
        .readContract({
          address: resolved.store,
          abi: jb721TiersHookStoreAbi,
          functionName: "tiersOf",
          args: [resolved.hook, [], true, 0n, 200n],
        })
        .catch(() => []);
      const flagsById = new Map(
        rawTiers.map((rawTier) => [rawTier.id, rawTier.flags] as const),
      );
      return {
        hook: resolved.hook,
        idTarget: resolved.metadataIdTarget,
        pricingCurrency: resolved.pricing.currency,
        pricingDecimals: resolved.pricing.decimals,
        tiers: await Promise.all(
          resolved.tiers.map(async (t) => {
            // Metadata is cosmetic — a tier without it still sells.
            const meta = await resolvePayTierMetadata(t);
            const name = meta?.name ?? null;
            const description = meta?.description ?? null;
            const image = tierMediaImageUrl(meta?.image) ?? null;
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
            };
          }),
        ),
      };
    },
  });

  // Keep the shared cart's presentation metadata fresh even before the user
  // opens the Shop tab. Clamp stale quantities against live per-chain supply.
  useEffect(() => {
    if (!shop) return;
    const liveIds = new Set(shop.tiers.map((tier) => tier.id));
    for (const tier of shop.tiers) {
      registerItem({
        tierId: tier.id,
        name: tier.name ?? `Item #${tier.id}`,
        image: tier.image ?? undefined,
      });
      const quantity = cart[tier.id] ?? 0;
      const cap = tier.unlimited ? 99 : tier.remaining;
      if (quantity > cap) setQuantity(tier.id, cap);
    }
    for (const id of Object.keys(cart).map(Number)) {
      if (!liveIds.has(id)) setQuantity(id, 0);
    }
  }, [shop, cart, registerItem, setQuantity]);

  const { data: shopCredits = 0n, isLoading: shopCreditsLoading } = useQuery({
    queryKey: ["payShopCredits", chainId, shop?.hook, address],
    enabled: !!publicClient && !!shop && !!address,
    staleTime: 15_000,
    retry: 1,
    queryFn: () =>
      publicClient!.readContract({
        address: shop!.hook,
        abi: jb721TiersHookAbi,
        functionName: "payCreditsOf",
        args: [address!],
      }),
  });

  // Verify every direct accounting token against the shop's pricing context.
  // JBPrices returns payment-token units per one whole shop-pricing unit;
  // router inputs stay disabled because the hook only sees the post-swap token.
  const { data: shopRoutes, isLoading: shopRoutesLoading } = useQuery({
    queryKey: [
      "payShopRoutes",
      chainId,
      projectId,
      shop?.pricingCurrency,
      shop?.pricingDecimals,
      contexts.map(payTokenKey).join(","),
    ],
    enabled: !!publicClient && !!shop && contexts.length > 0,
    staleTime: 60_000,
    retry: 1,
    queryFn: async (): Promise<Record<string, ShopPayRoute>> => {
      const prices = jbContractAddress["6"][JBCoreContracts.JBPrices][chainId];
      const entries = await Promise.all(
        contexts.map(async (payContext) => {
          const key = payTokenKey(payContext);
          if (payContext.viaRouter) {
            return [
              key,
              {
                supported: false,
                pricePerUnit: null,
                reason: "Item checkout requires a directly accepted token.",
              },
            ] as const;
          }

          const sameCurrency =
            payContext.currency === shop!.pricingCurrency ||
            (shop!.pricingCurrency === BASE_CURRENCY_ETH &&
              payContext.token.toLowerCase() === NATIVE_TOKEN.toLowerCase());
          if (sameCurrency) {
            return [
              key,
              {
                supported: true,
                pricePerUnit: 10n ** BigInt(payContext.decimals),
              },
            ] as const;
          }

          if (!prices) {
            return [
              key,
              {
                supported: false,
                pricePerUnit: null,
                reason: "No price contract is available on this chain.",
              },
            ] as const;
          }
          const pricePerUnit = await publicClient!
            .readContract({
              address: prices,
              abi: jbPricesAbi,
              functionName: "pricePerUnitOf",
              args: [
                BigInt(projectId),
                BigInt(payContext.currency),
                BigInt(shop!.pricingCurrency),
                BigInt(payContext.decimals),
              ],
            })
            .catch(() => 0n);
          return [
            key,
            pricePerUnit > 0n
              ? { supported: true, pricePerUnit }
              : {
                  supported: false,
                  pricePerUnit: null,
                  reason: "No price feed converts this payment token.",
                },
          ] as const;
        }),
      );
      return Object.fromEntries(entries);
    },
  });
  const selectedShopRoute = context
    ? shopRoutes?.[payTokenKey(context)]
    : undefined;
  const shopMatchesToken = !!selectedShopRoute?.supported;
  const supportedShopContextIndexes = useMemo(
    () =>
      contexts.flatMap((payContext, index) =>
        shopRoutes?.[payTokenKey(payContext)]?.supported ? [index] : [],
      ),
    [contexts, shopRoutes],
  );

  // Selecting an item from either surface moves the currency selector to the
  // best verified checkout token instead of silently discarding the cart.
  useEffect(() => {
    if (cartCount === 0 || shopRoutesLoading || shopMatchesToken) return;
    const preferred = supportedShopContextIndexes
      .map((index) => ({ index, context: contexts[index] }))
      .sort((a, b) => {
        const score = (candidate: PayContext) =>
          candidate.currency === shop?.pricingCurrency
            ? 3
            : shop?.pricingCurrency === BASE_CURRENCY_ETH &&
                candidate.token.toLowerCase() === NATIVE_TOKEN.toLowerCase()
              ? 2
              : shop?.pricingCurrency === BASE_CURRENCY_USD &&
                  candidate.symbol.toUpperCase() === "USDC"
                ? 2
                : 1;
        return score(b.context) - score(a.context);
      })[0];
    if (!preferred) return;
    setTokenIndex(preferred.index);
    selectedKeyRef.current = payTokenKey(preferred.context);
    setTokenTouched(true);
  }, [
    cartCount,
    shopRoutesLoading,
    shopMatchesToken,
    supportedShopContextIndexes,
    contexts,
    shop?.pricingCurrency,
  ]);

  const shopPricingSymbol =
    shop?.pricingCurrency === BASE_CURRENCY_ETH
      ? nativeSymbol
      : shop?.pricingCurrency === BASE_CURRENCY_USD
        ? "USD"
        : (contexts.find((c) => c.currency === shop?.pricingCurrency)?.symbol ??
          "units");
  const cartTotal = useMemo(() => {
    if (!shop || cartCount === 0) return 0n;
    return shop.tiers.reduce(
      (sum, tier) =>
        sum +
        effectiveTierPrice(tier.price, tier.discountPercent) *
          BigInt(cart[tier.id] ?? 0),
      0n,
    );
  }, [shop, cart, cartCount]);
  const restrictedCartTotal = useMemo(() => {
    if (!shop) return 0n;
    return shop.tiers.reduce(
      (sum, tier) =>
        sum +
        (tier.cantBuyWithCredits
          ? effectiveTierPrice(tier.price, tier.discountPercent) *
            BigInt(cart[tier.id] ?? 0)
          : 0n),
      0n,
    );
  }, [shop, cart]);
  const shopCreditApplied = useMemo(() => {
    const eligible = cartTotal - restrictedCartTotal;
    if (eligible <= 0n || shopCredits <= 0n) return 0n;
    return shopCredits < eligible ? shopCredits : eligible;
  }, [cartTotal, restrictedCartTotal, shopCredits]);
  const cartAmountDue = cartTotal - shopCreditApplied;
  const selectedCartRows = useMemo(
    () =>
      Object.entries(cart)
        .filter(([, quantity]) => quantity > 0)
        .map(([rawId, quantity]) => {
          const tierId = Number(rawId);
          const tier = shop?.tiers.find((candidate) => candidate.id === tierId);
          const registered = cartItems[tierId];
          return {
            tierId,
            quantity,
            name: registered?.name ?? tier?.name ?? `Item #${tierId}`,
            image: registered?.image ?? tier?.image ?? undefined,
            cap: tier ? (tier.unlimited ? 99 : tier.remaining) : quantity,
          };
        })
        .sort((a, b) => a.tierId - b.tierId),
    [cart, cartItems, shop],
  );

  // Keep the entered amount at least the verified checkout total. The price
  // feed is expressed in payment-token units and this direction rounds up,
  // exactly matching the hook's fail-safe normalization.
  const cartTotalInToken = useMemo(() => {
    const pricePerUnit = selectedShopRoute?.pricePerUnit;
    if (
      !shop ||
      mode !== "pay" ||
      cartAmountDue === 0n ||
      !context ||
      !selectedShopRoute?.supported ||
      !pricePerUnit
    ) {
      return 0n;
    }
    const denominator = 10n ** BigInt(shop.pricingDecimals);
    return (cartAmountDue * pricePerUnit + denominator - 1n) / denominator;
  }, [shop, mode, cartAmountDue, context, selectedShopRoute]);

  useEffect(() => {
    if (mode !== "pay" || cartCount === 0 || !shopMatchesToken) return;
    const current = (() => {
      try {
        return parseUnits(amount.trim() || "0", decimals);
      } catch {
        return 0n;
      }
    })();
    if (current === cartTotalInToken) return;
    const next = formatUnits(cartTotalInToken, decimals);
    setAmount(next);
    setDebouncedAmount(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cartTotalInToken, cartCount, shopMatchesToken, mode]);

  const tierIds = useMemo(
    () =>
      Object.entries(cart).flatMap(([id, qty]) =>
        Array.from({ length: qty }, () => BigInt(id)),
      ),
    [cart],
  );
  const metadata: Hex | undefined =
    shop && tierIds.length > 0 && shopMatchesToken
      ? build721PayMetadata({
          metadataIdTarget: shop.idTarget,
          tierIdsToMint: tierIds,
        })
      : undefined;

  // ---- Terminal + preview ----
  // viaRouter tokens are paid through the JBRouterTerminalRegistry (which swaps
  // them into the project's accounting token); direct tokens go to the
  // JBMultiTerminal. Preview, allowance, approval, and pay all target this.
  const multiTerminal =
    jbContractAddress["6"][JBCoreContracts.JBMultiTerminal][chainId];
  const routerRegistry = jbContractAddress["6"][
    JBRouterTerminalContracts.JBRouterTerminalRegistry
  ]?.[chainId] as Address | undefined;
  const terminalAddress = !context
    ? undefined
    : context.viaRouter
      ? routerRegistry
      : multiTerminal;

  const {
    data: preview,
    isFetching: previewLoading,
    isError: previewError,
    isPlaceholderData: previewIsPrevious,
  } = useQuery({
    queryKey: [
      "previewPay",
      chainId,
      projectId,
      context?.token,
      context?.viaRouter,
      terminalAddress,
      amountRaw.toString(),
      metadata ?? "0x",
    ],
    enabled:
      !!publicClient &&
      !!context &&
      !!terminalAddress &&
      (amountRaw > 0n || cartCount > 0) &&
      mode === "pay",
    // Keep the last verified quote mounted while the next amount is quoted.
    // The receipt gently dims it below, and submission stays blocked until the
    // fresh quote arrives.
    placeholderData: (previous) => previous,
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
  });

  // Compare the terminal preview with a direct exact-input Uniswap V4 quote.
  // The direct path bypasses reserved-token splits, so the SDK compares its
  // slippage-protected minimum—not its optimistic quote—against what the
  // terminal guarantees. Shop checkouts stay on the terminal because the
  // direct pool cannot mint the selected NFTs.
  const { data: market } = useQuery({
    queryKey: ["payMarket", chainId, projectId],
    enabled: !!publicClient && mode === "pay" && cartCount === 0,
    staleTime: 30_000,
    retry: false,
    queryFn: () =>
      resolveMarket(publicClient!, chainId, projectId, nativeSymbol),
  });
  const directInputMatches =
    market?.status === "pool" &&
    !!context &&
    (context.token.toLowerCase() === market.pair.tokenOrig.toLowerCase() ||
      (isNative && market.pair.isNative));
  const {
    data: directSwapQuote,
    isFetching: directSwapQuoteLoading,
    isError: directSwapQuoteError,
  } = useQuery({
    queryKey: [
      "directPaySwapQuote",
      chainId,
      projectId,
      context?.token,
      amountRaw.toString(),
      market?.status === "pool" ? market.poolId : null,
    ],
    enabled:
      !!publicClient &&
      !!preview &&
      directInputMatches &&
      amountRaw > 0n &&
      mode === "pay" &&
      cartCount === 0,
    placeholderData: (previous) => previous,
    retry: false,
    queryFn: () => {
      if (market?.status !== "pool") {
        throw new Error("No direct swap pool is available.");
      }
      return quoteUniswapV4ExactInputSingle(publicClient!, {
        chainId,
        poolKey: market.key,
        zeroForOne: market.pairIsC0,
        amountIn: amountRaw,
      });
    },
  });
  const bestRoute = useMemo(
    () =>
      preview
        ? chooseBestPayRoute({
            pay: preview,
            paySettlement: context?.viaRouter ? "swap" : "issuance",
            directSwapQuote:
              directInputMatches && !directSwapQuoteError
                ? directSwapQuote
                : null,
          })
        : null,
    [
      preview,
      context?.viaRouter,
      directInputMatches,
      directSwapQuote,
      directSwapQuoteError,
    ],
  );
  const directSwapRoute = bestRoute?.kind === "direct-swap";

  // A VERIFIED zero preview may submit (min 0 — zero-issuance pay is
  // legitimate); an unavailable preview blocks (never send blind).
  const previewReady =
    mode === "addbalance" ||
    (!!preview &&
      !previewError &&
      !previewLoading &&
      !previewIsPrevious &&
      (!directInputMatches || !directSwapQuoteLoading));
  // Floor the guaranteed minimum at 99% of the preview (website parity): a
  // buyback-routed or USD-issuance pay legitimately drifts between preview
  // and inclusion, and an exact min would make ordinary pays revert. A
  // verified zero stays zero.
  const minReturned = directSwapRoute
    ? bestRoute.beneficiaryTokenCount
    : ((preview?.beneficiaryTokenCount ?? 0n) * 99n) / 100n;

  // ---- ERC-20 allowance ----
  // Direct pays approve the JBMultiTerminal; swap-via-router ERC-20 pays approve
  // the JBRouterTerminalRegistry. The registry's _transferFrom checks a plain
  // ERC-20 allowance FIRST (JBRouterTerminalRegistry.sol) and pulls via
  // safeTransferFrom when it covers the amount — so a single simulated
  // approve(terminal, amount), identical to the direct path, satisfies it. No
  // Permit2 signature is needed, so nothing bypasses useSafeTx.
  const swapDeployment = directSwapRoute
    ? uniswapV4Deployment(chainId)
    : undefined;
  const approvalSpender = directSwapRoute
    ? swapDeployment?.permit2
    : terminalAddress;
  const { data: allowance, refetch: refetchAllowance } = useQuery({
    queryKey: [
      "payAllowance",
      chainId,
      context?.token,
      approvalSpender,
      address,
      approvalBlock?.toString(),
    ],
    enabled:
      !!publicClient &&
      !!context &&
      !isNative &&
      !!address &&
      !!approvalSpender &&
      amountRaw > 0n,
    staleTime: 15_000,
    queryFn: () =>
      publicClient!.readContract({
        address: context!.token,
        abi: erc20Abi,
        functionName: "allowance",
        args: [address!, approvalSpender!],
        blockNumber: approvalBlock,
      }),
  });
  const needsApproval = !isNative && (allowance ?? 0n) < amountRaw;
  const { data: permit2Allowance, refetch: refetchPermit2Allowance } = useQuery(
    {
      queryKey: [
        "payPermit2Allowance",
        chainId,
        context?.token,
        swapDeployment?.universalRouter,
        address,
        approvalBlock?.toString(),
      ],
      enabled:
        !!publicClient &&
        directSwapRoute &&
        !isNative &&
        !!address &&
        !!context &&
        !!swapDeployment?.universalRouter,
      staleTime: 15_000,
      queryFn: () =>
        publicClient!.readContract({
          address: swapDeployment!.permit2,
          abi: permit2AllowanceAbi,
          functionName: "allowance",
          args: [
            address!,
            context!.token,
            swapDeployment!.universalRouter as Address,
          ],
          blockNumber: approvalBlock,
        }),
    },
  );
  const needsPermit2Approval =
    directSwapRoute &&
    !isNative &&
    (!permit2Allowance ||
      permit2Allowance[0] < amountRaw ||
      Number(permit2Allowance[1]) <= Math.floor(Date.now() / 1000) + 1_800);

  // ---- Terminal-surface safety (website/ renderTerminalNotice parity) ----
  // Fail closed: the target terminal MUST be listed among the project's
  // terminals (JBDirectory.terminalsOf), or paying is blocked. Listed
  // terminals we don't recognize are a non-blocking note (surface.unknown).
  const surfaceTerminals = surface?.terminals ?? [];
  const terminalListed =
    !terminalAddress ||
    surfaceTerminals.some(
      (t) => t.toLowerCase() === terminalAddress.toLowerCase(),
    );
  const terminalBlocked = !!surface && !!terminalAddress && !terminalListed;
  // Add-to-balance has no on-chain minimum-output field, so a router swap can't
  // be bounded — refuse it (website/ 6439 parity), only direct tokens top up.
  const addBalanceViaRouter = mode === "addbalance" && !!context?.viaRouter;

  useEffect(() => {
    if (approveTx.phase === "success" || routerApproveTx.phase === "success") {
      void refetchAllowance();
      void refetchPermit2Allowance();
    }
  }, [approveTx.phase, refetchAllowance, refetchPermit2Allowance, routerApproveTx.phase]);

  const sequenceSafePhase =
    sequenceSafeStage === "token-approval"
      ? approveTx.phase
      : sequenceSafeStage === "router-approval"
        ? routerApproveTx.phase
        : tx.phase;
  const sequenceSafeError =
    sequenceSafeStage === "token-approval"
      ? approveTx.error
      : sequenceSafeStage === "router-approval"
        ? routerApproveTx.error
        : tx.error;

  useEffect(() => {
    if (!sequenceSafeStage) return;
    if (sequenceSafePhase === "error") {
      setSequenceSafeStage(null);
      setSequenceError(sequenceSafeError ?? "The Safe action could not be completed.");
      return;
    }
    if (sequenceSafePhase !== "success") return;
    if (sequenceSafeStage === "payment") {
      setSequenceSafeStage(null);
      setSequenceComplete(true);
      setSequenceStatus(mode === "pay" ? "Payment confirmed." : "Added to the balance.");
    } else {
      setSequenceStatus("Safe action confirmed. Refreshing approvals…");
      void Promise.all([refetchAllowance(), refetchPermit2Allowance()])
        .then(() => {
          setSequenceSafeStage(null);
          setSequenceStatus("Safe action confirmed. Continue to the next payment action.");
        })
        .catch(() => {
          setSequenceSafeStage(null);
          setSequenceError("The Safe action confirmed, but its updated allowance is not available yet. Try again shortly.");
        });
    }
  }, [
    mode,
    refetchAllowance,
    refetchPermit2Allowance,
    sequenceSafeError,
    sequenceSafePhase,
    sequenceSafeStage,
  ]);

  const busy =
    tx.phase === "simulating" ||
    tx.phase === "signing" ||
    tx.phase === "pending" ||
    approveTx.phase === "simulating" ||
    approveTx.phase === "signing" ||
    approveTx.phase === "pending" ||
    routerApproveTx.phase === "simulating" ||
    routerApproveTx.phase === "signing" ||
    routerApproveTx.phase === "pending" ||
    sequenceStarted ||
    !!sequenceSafeStage;

  useEffect(() => {
    if (!sequenceOpen) return;
    const activePhase = [tx.phase, routerApproveTx.phase, approveTx.phase].find(
      phase => phase === "simulating" || phase === "signing" || phase === "pending",
    );
    if (activePhase === "simulating") setSequenceStatus("Checking the reviewed wallet action…");
    else if (activePhase === "signing") setSequenceStatus("Confirm this action in your wallet.");
    else if (activePhase === "pending") setSequenceStatus("Submitted. Confirming onchain…");
  }, [approveTx.phase, routerApproveTx.phase, sequenceOpen, tx.phase]);

  const preparePaymentSequence = (): PaymentSequenceAction[] => {
    if (!address || !context || !terminalAddress) return [];
    const actions: PaymentSequenceAction[] = [];
    if (needsApproval && approvalSpender) {
      actions.push({
        kind: "token-approval",
        label: `Approve ${symbol} access`,
        request: buildErc20ApproveRequest({
          chainId,
          token: context.token,
          spender: approvalSpender,
          amount: amountRaw,
        }),
      });
    }
    if (needsPermit2Approval) {
      const request = buildPermit2ApproveTx({
        chainId,
        token: context.token,
        amount: amountRaw,
        expiration: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
      });
      actions.push({
        kind: "router-approval",
        label: "Authorize the Uniswap swap router",
        request: {
          ...request,
          args: request.args as unknown as readonly unknown[],
          label: "Authorize Uniswap swap router",
        },
      });
    }
    let paymentRequest: TxRequest;
    if (mode === "pay") {
      if (directSwapRoute && market?.status === "pool" && bestRoute) {
        const viaSafe = isSafeConnection(wagmiConfig);
        const request = buildUniswapV4ExactInputSwapTx({
          chainId,
          poolKey: market.key,
          zeroForOne: market.pairIsC0,
          amountIn: amountRaw,
          minimumAmountOut: bestRoute.beneficiaryTokenCount,
          recipient: address,
          deadline: swapDeadline(viaSafe),
        });
        paymentRequest = {
          ...request,
          args: request.args as unknown as readonly unknown[],
          label: viaSafe
            ? "Swap for project tokens (30-day deadline for Safe signature collection)"
            : "Swap for project tokens",
        };
      } else {
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
        });
        paymentRequest = {
          chainId,
          address: request.address,
          abi: request.abi,
          functionName: request.functionName,
          args: request.args as unknown as readonly unknown[],
          value: request.value,
          label: "Pay project",
        };
      }
    } else {
      paymentRequest = buildAddToBalanceRequest({
        chainId,
        terminal: terminalAddress,
        projectId: BigInt(projectId),
        token: context.token,
        amount: amountRaw,
        memo: memo.trim(),
      });
    }
    actions.push({
      kind: "payment",
      label:
        mode === "pay"
          ? directSwapRoute
            ? "Execute the swap"
            : "Execute the payment"
          : "Add to the project balance",
      request: paymentRequest,
    });
    return actions;
  };

  const submit = () => {
    if (!isConnected || !address) {
      openSignIn();
      return;
    }
    const creditOnlyCheckout =
      mode === "pay" && cartCount > 0 && cartAmountDue === 0n;
    if (
      !context ||
      !terminalAddress ||
      (amountRaw <= 0n && !creditOnlyCheckout) ||
      busy ||
      (cartCount > 0 && shopCreditsLoading)
    ) {
      return;
    }
    // Fail-closed guards: never send to an unlisted terminal, and never try to
    // top up a balance with a router swap (no min-output bound).
    if (terminalBlocked || addBalanceViaRouter) return;
    const actions = preparePaymentSequence();
    if (!actions.length) return;
    setSequenceError(null);
    setSequenceStatus(null);
    setSequenceComplete(false);
    setSequenceStarted(false);
    setSequenceSafeStage(null);
    setSequenceActions(actions);
    setSequenceActionIndex(0);
    setSequenceOpen(true);
  };

  const runPaymentSequence = async () => {
    if (
      !address ||
      !context ||
      !terminalAddress ||
      !publicClient ||
      !sequenceActions.length ||
      sequenceStarted
    ) return;
    setSequenceStarted(true);
    setSequenceError(null);
    let latestApprovalBlock = approvalBlock;
    const actionOf = (kind: PaymentSequenceAction["kind"]) =>
      sequenceActions.find(action => action.kind === kind);
    const showAction = async (kind: PaymentSequenceAction["kind"]) => {
      const index = sequenceActions.findIndex(action => action.kind === kind);
      if (index >= 0) setSequenceActionIndex(index);
      await nextUiPaint();
    };
    try {
      const tokenApproval = actionOf("token-approval");
      if (tokenApproval) {
        await showAction("token-approval");
        setSequenceStatus(`Review and approve ${symbol} access.`);
        const approvalHash = await approveTx.send(
          tokenApproval.request,
          { reviewedInParent: true },
        );
        if (!approvalHash) throw new Error("Token approval was cancelled.");
        if (approveTx.isSafe) {
          setSequenceSafeStage("token-approval");
          setSequenceStatus("Approval proposed to your Safe. Execute it there before continuing.");
          return;
        }
        setSequenceStatus(`Confirming ${symbol} approval onchain…`);
        const receipt = await waitForPaymentReceipt(publicClient, approvalHash);
        if (receipt.status !== "success") throw new Error(`${symbol} approval reverted onchain.`);
        latestApprovalBlock = receipt.blockNumber;
        approveTx.reset();
        await refetchAllowance();
      }
      const routerApproval = actionOf("router-approval");
      if (routerApproval) {
        await showAction("router-approval");
        setSequenceStatus("Review and authorize the Uniswap swap router.");
        const approvalHash = await routerApproveTx.send(
          routerApproval.request,
          { simulationBlockNumber: latestApprovalBlock, reviewedInParent: true },
        );
        if (!approvalHash) throw new Error("Swap-router authorization was cancelled.");
        if (routerApproveTx.isSafe) {
          setSequenceSafeStage("router-approval");
          setSequenceStatus("Router authorization proposed to your Safe. Execute it there before continuing.");
          return;
        }
        setSequenceStatus("Confirming swap-router authorization onchain…");
        const receipt = await waitForPaymentReceipt(publicClient, approvalHash);
        if (receipt.status !== "success") {
          throw new Error("Swap-router authorization reverted onchain.");
        }
        if (latestApprovalBlock === undefined || receipt.blockNumber > latestApprovalBlock) {
          latestApprovalBlock = receipt.blockNumber;
        }
        routerApproveTx.reset();
        await refetchPermit2Allowance();
      }

      await showAction("payment");
      setSequenceStatus(mode === "pay" ? "Review and execute the payment." : "Review and add to the balance.");
      const paymentRequest = actionOf("payment")!.request;
      const paymentHash = await tx.send(paymentRequest, {
        simulationBlockNumber: latestApprovalBlock,
        reviewedInParent: true,
      });
      if (!paymentHash) throw new Error("Payment was cancelled.");
      if (tx.isSafe) {
        setSequenceSafeStage("payment");
        setSequenceStatus("Payment proposed to your Safe. Execute it there to finish.");
        return;
      }
      setSequenceStatus("Payment submitted. Confirming onchain…");
      const paymentReceipt = await waitForPaymentReceipt(publicClient, paymentHash);
      if (paymentReceipt.status !== "success") throw new Error("Payment reverted onchain.");
      setSequenceComplete(true);
      setSequenceStatus(mode === "pay" ? "Payment confirmed." : "Added to the balance.");
    } catch (reason) {
      setSequenceError(reason instanceof Error ? reason.message : "The payment could not be completed.");
    } finally {
      setSequenceStarted(false);
    }
  };

  const reset = () => {
    tx.reset();
    approveTx.reset();
    routerApproveTx.reset();
    setSequenceOpen(false);
    setSequenceStarted(false);
    setSequenceComplete(false);
    setSequenceActions([]);
    setSequenceActionIndex(0);
    setSequenceSafeStage(null);
    setSequenceStatus(null);
    setSequenceError(null);
    setAmount("");
    setDebouncedAmount("");
    setMemo("");
    clearCart();
  };

  useEffect(() => {
    if (tx.phase === "success" && cartCount > 0) clearCart();
  }, [tx.phase, cartCount, clearCart]);

  // ---- Success view ----
  if (tx.phase === "success") {
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
          {mode === "pay" ? "Payment confirmed" : "Added to the balance"}
        </p>
        <p className="mt-1 text-sm text-smoke-700">
          {mode === "pay"
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
    );
  }

  const hasShopPreview = !!shop && shop.tiers.length > 0 && mode === "pay";

  return (
    <div className={hasShopPreview ? undefined : "-mt-3"}>
      {/* Shop strip */}
      {hasShopPreview ? (
        <div className="mt-4">
          <div className="flex items-center justify-between gap-3">
            <span className="field-label">Shop</span>
            <button
              type="button"
              onClick={() => {
                window.location.hash = "shop";
              }}
              className="text-xs font-medium text-bluebs-600 hover:underline"
            >
              All →
            </button>
          </div>
          {cartCount > 0 && shopRoutesLoading ? (
            <Skeleton
              className="mt-2 h-3 w-40 rounded"
              role="status"
              aria-label="Loading checkout currencies"
            />
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
            {shop.tiers.slice(0, 12).map((tier) => {
              const qty = cart[tier.id] ?? 0;
              const soldOut = !tier.unlimited && tier.remaining === 0;
              const cap = tier.unlimited ? 99 : tier.remaining;
              const price = effectiveTierPrice(
                tier.price,
                tier.discountPercent,
              );
              const item = {
                tierId: tier.id,
                name: tier.name ?? `Item #${tier.id}`,
                image: tier.image ?? undefined,
              };
              return (
                <div
                  key={tier.id}
                  className={`relative w-24 shrink-0 overflow-hidden rounded-lg border bg-white text-center transition ${
                    qty > 0
                      ? "border-bluebs-500 bg-bluebs-25"
                      : "border-smoke-200 hover:border-bluebs-300"
                  } ${soldOut ? "opacity-40" : ""}`}
                >
                  {qty > 0 ? (
                    <span className="absolute right-1.5 top-1.5 z-10 flex h-5 min-w-5 items-center justify-center rounded-full bg-bluebs-600 px-1 text-[10px] font-medium text-white">
                      {qty}
                    </span>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => {
                      if (soldOut || qty > 0) return;
                      setQuantity(tier.id, 1, item);
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
                      {formatTokenAmount(price, shop.pricingDecimals)}{" "}
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
              );
            })}
          </div>
        </div>
      ) : null}

      {/* Mode on chain — subtle underlined text dropdowns (website/ parity) */}
      <div
        className={`${hasShopPreview ? "mt-4" : ""} flex flex-wrap items-center gap-x-1.5 gap-y-1 text-base text-smoke-700`}
      >
        <TextSelect
          value={mode}
          onChange={(v) => setMode(v as "pay" | "addbalance")}
          disabled={busy}
          ariaLabel="Payment mode"
          options={[
            { value: "pay", label: "Pay" },
            {
              value: "addbalance",
              label: "Add to balance",
              selectedLabel: "Add",
            },
          ]}
        />
        <span>on</span>
        {chains.length > 1 ? (
          <TextSelect
            value={String(chainId)}
            onChange={(v) => {
              const next = chains.find(([cid]) => cid === Number(v));
              if (!next) return;
              setDeployment({
                chainId: next[0] as JBChainId,
                projectId: next[1],
              });
              setTokenIndex(0);
              setTokenTouched(false);
              selectedKeyRef.current = null;
              clearCart();
              setAmount("");
              setDebouncedAmount("");
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
      {mode === "addbalance" ? (
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
            onChange={(e) => setAmount(e.target.value)}
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
              onChange={(value) => {
                const i = Number(value);
                setTokenIndex(i);
                // Remember the explicit pick so a refetch/chain-switch remaps
                // to this exact token instead of snapping back to list[0].
                const picked = contexts[i];
                if (picked) selectedKeyRef.current = payTokenKey(picked);
                setTokenTouched(true);
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
                  cartCount > 0 && !shopRoutes?.[payTokenKey(ctx)]?.supported,
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
              (surface?.pausePay && mode === "pay") ||
              (isConnected &&
                ((amountRaw <= 0n &&
                  !(mode === "pay" && cartCount > 0 && cartAmountDue === 0n)) ||
                  (mode === "pay" && !previewReady)))
            }
            className="btn-primary shrink-0 rounded-l-none px-5 text-sm disabled:opacity-60"
          >
            {notStarted
              ? "Soon"
              : !isConnected
                ? "Sign in"
                : mode === "pay"
                  ? "Pay"
                  : "Add"}
          </button>
        </div>
        {notStarted ? (
          <p className="mt-1.5 text-xs text-smoke-700">
            Starts in {formatStartCountdown(startsAt - now)}.
          </p>
        ) : null}
        {mode === "pay" &&
        amountRaw > 0n &&
        !previewError &&
        (previewLoading || (bestRoute && bestRoute.beneficiaryTokenCount > 0n)) ? (
          <div className="mt-3">
            <p className="text-xs text-smoke-500">You get at least</p>
            {bestRoute && bestRoute.beneficiaryTokenCount > 0n ? (
              <p
                aria-live="polite"
                aria-busy={previewLoading}
                className={`font-agrandir text-xl font-medium transition-colors duration-200 ${
                  previewLoading ? "text-smoke-500" : "text-ink"
                }`}
              >
                {formatTokenAmount(bestRoute.beneficiaryTokenCount, 18)}{" "}
                {projectTokenLabel}
                <button
                  type="button"
                  onClick={() => setShowRouteComparison(current => !current)}
                  aria-expanded={showRouteComparison}
                  className="ml-2 inline-flex border border-bluebs-400 px-1.5 py-0.5 align-middle text-[10px] font-medium tracking-wide text-bluebs-700 hover:bg-bluebs-25"
                >
                  {bestRoute.settlement === "swap" ? "Swap" : "Issuance"}
                </button>
              </p>
            ) : (
              <Skeleton
                className="mt-1 h-7 w-28 rounded"
                role="status"
                aria-label="Calculating token return"
              />
            )}
            {showRouteComparison && bestRoute?.settlement === "swap" ? (
              directSwapRoute ? (
                <div className="mt-2 grid grid-cols-2 gap-2 border-t border-smoke-200 pt-2 text-xs">
                  <div>
                    <p className="text-smoke-500">Swap</p>
                    <p className="font-medium text-ink">
                      {formatTokenAmount(bestRoute.beneficiaryTokenCount, 18)} {projectTokenLabel}
                    </p>
                  </div>
                  <div>
                    <p className="text-smoke-500">Issuance</p>
                    <p className="font-medium text-ink">
                      {formatTokenAmount(preview?.beneficiaryTokenCount ?? 0n, 18)} {projectTokenLabel}
                    </p>
                  </div>
                  <p className="col-span-2 text-smoke-500">
                    The better guaranteed return is selected automatically.
                  </p>
                </div>
              ) : (
                <p className="mt-2 border-t border-smoke-200 pt-2 text-xs text-smoke-500">
                  This payment settles through the project&apos;s configured swap route.
                </p>
              )
            ) : null}
          </div>
        ) : null}
      </div>

      {/* Note — always present, optional */}
      <input
        type="text"
        value={memo}
        onChange={(e) => setMemo(e.target.value.slice(0, 256))}
        disabled={busy}
        placeholder="Add a note (optional)"
        aria-label="Note"
        className="input-well mt-3 min-h-[44px] px-3.5 text-sm disabled:opacity-60"
      />

      {/* Selected shop items share the payment receipt shown above. */}
      {mode === "pay" && cartCount > 0 ? (
        <div className="mt-4">
          {selectedCartRows.length > 0 ? (
            <div className="mt-2 space-y-2 rounded-lg border border-smoke-200 bg-smoke-50 p-2.5">
              {selectedCartRows.map((row) => (
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
                      onClick={() => setQuantity(row.tierId, row.quantity - 1)}
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
                    {cartCount} item{cartCount === 1 ? "" : "s"}
                  </span>
                  <span className="tabular-nums text-ink">
                    {formatTokenAmount(cartTotal, shop?.pricingDecimals ?? 18)}{" "}
                    {shopPricingSymbol}
                  </span>
                </div>
                {!shopCreditsLoading && shopCreditApplied > 0n ? (
                  <div className="flex items-center justify-between gap-3 text-emerald-700">
                    <span>Shop credit applied</span>
                    <span className="tabular-nums">
                      −
                      {formatTokenAmount(
                        shopCreditApplied,
                        shop?.pricingDecimals ?? 18,
                      )}{" "}
                      {shopPricingSymbol}
                    </span>
                  </div>
                ) : !shopCreditsLoading && shopCredits > 0n ? (
                  <div className="flex items-center justify-between gap-3 text-smoke-500">
                    <span>Shop credit available</span>
                    <span className="tabular-nums">
                      {formatTokenAmount(
                        shopCredits,
                        shop?.pricingDecimals ?? 18,
                      )}{" "}
                      {shopPricingSymbol}
                    </span>
                  </div>
                ) : null}
                {!shopCreditsLoading &&
                shopCredits > 0n &&
                restrictedCartTotal > 0n ? (
                    <div className="flex items-center justify-between gap-3 text-smoke-500">
                      <span>
                        {restrictedCartTotal === cartTotal
                          ? 'These items require fresh payment'
                          : 'Some items require fresh payment'}
                      </span>
                      <span className="tabular-nums">
                        {formatTokenAmount(
                          restrictedCartTotal,
                          shop?.pricingDecimals ?? 18,
                        )}{" "}
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
                    )}{" "}
                    {shopPricingSymbol}
                  </span>
                </div>
              </div>
            </div>
          ) : null}

          {bestRoute && bestRoute.reservedTokenCount > 0n ? (
            <p className="mt-1.5 text-xs text-smoke-500">
              Splits get {formatTokenAmount(bestRoute.reservedTokenCount, 18)}{" "}
              {projectTokenLabel}
            </p>
          ) : null}
        </div>
      ) : null}
      {mode === "pay" && amountRaw > 0n && previewError ? (
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
      {surface?.pausePay && mode === "pay" ? (
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
          This project doesn&apos;t list the{" "}
          {context?.viaRouter ? "router" : "direct"} payment terminal on{" "}
          {chainName(chainId)}. Review the project contracts before paying.
        </p>
      ) : null}
      {!terminalBlocked && surface?.unknown && surface.unknown.length > 0 ? (
        <p className="mt-3 text-xs leading-relaxed text-smoke-700">
          This project also lists unknown payment terminal
          {surface.unknown.length > 1 ? "s" : ""}:{" "}
          {surface.unknown
            .map((a) => `${a.slice(0, 6)}…${a.slice(-4)}`)
            .join(", ")}
          . This form only sends to a recognized Juicebox terminal.
        </p>
      ) : null}
      {(approveTx.error ?? tx.error) ? (
        <p className="mt-3 text-sm text-red-600">
          {approveTx.error ?? tx.error}
        </p>
      ) : null}
      {sequenceOpen ? (
        <PaymentSequenceDialog
          mode={mode}
          chainName={chainName(chainId)}
          amount={`${formatTokenAmount(amountRaw, decimals)} ${symbol}`}
          tokenReturn={
            mode === "pay" && bestRoute
              ? `${formatTokenAmount(bestRoute.beneficiaryTokenCount, 18)} ${projectTokenLabel}`
              : null
          }
          actions={sequenceActions}
          activeActionIndex={sequenceActionIndex}
          beneficiary={address ?? null}
          memo={memo.trim() || null}
          status={sequenceStatus}
          error={sequenceError ?? routerApproveTx.error}
          started={sequenceStarted}
          waitingForSafe={!!sequenceSafeStage}
          complete={sequenceComplete}
          onStart={() => void runPaymentSequence()}
          onClose={() => {
            if (sequenceStarted) return;
            setSequenceOpen(false);
            setSequenceActions([]);
            setSequenceActionIndex(0);
            setSequenceStatus(null);
            setSequenceError(null);
          }}
        />
      ) : null}
    </div>
  );
}

function PaymentSequenceDialog({
  mode,
  chainName: paymentChainName,
  amount,
  tokenReturn,
  actions,
  activeActionIndex,
  beneficiary,
  memo,
  status,
  error,
  started,
  waitingForSafe,
  complete,
  onStart,
  onClose,
}: {
  mode: "pay" | "addbalance";
  chainName: string;
  amount: string;
  tokenReturn: string | null;
  actions: PaymentSequenceAction[];
  activeActionIndex: number;
  beneficiary: Address | null;
  memo: string | null;
  status: string | null;
  error: string | null;
  started: boolean;
  waitingForSafe: boolean;
  complete: boolean;
  onStart: () => void;
  onClose: () => void;
}) {
  const activeAction = actions[activeActionIndex] ?? null;
  return (
    <div className="fixed inset-0 z-[1000] flex items-start justify-center overflow-y-auto bg-black/50 px-3 py-6 sm:items-center">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="payment-sequence-title"
        className="w-full max-w-lg rounded-2xl border border-smoke-300 bg-bone shadow-2xl"
      >
        <header className="flex items-start justify-between gap-4 border-b border-smoke-200 bg-bone px-5 py-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-bluebs-600">
              Payment sequence
            </p>
            <h2 id="payment-sequence-title" className="mt-1 font-agrandir text-xl font-medium text-ink">
              {complete
                ? mode === "pay"
                  ? "Payment confirmed"
                  : "Added to the balance"
                : mode === "pay"
                  ? "Confirm payment"
                  : "Confirm add to balance"}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={started}
            aria-label="Close payment"
            className="icon-button -mr-2 -mt-2 shrink-0 disabled:opacity-40"
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              className="h-6 w-6"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="m6 6 12 12M18 6 6 18" strokeLinecap="round" />
            </svg>
          </button>
        </header>
        <div className="space-y-4 px-5 py-5">
          <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <span className="text-smoke-500">Send</span>
            <span className="text-right font-medium text-ink">{amount}</span>
            <span className="text-smoke-500">On</span>
            <span className="text-right text-ink">{paymentChainName}</span>
            {tokenReturn ? (
              <>
                <span className="text-smoke-500">You get at least</span>
                <span className="text-right font-medium text-ink">{tokenReturn}</span>
              </>
            ) : null}
          </div>

          <div className="rounded-xl border border-smoke-200 bg-white p-3">
            <p className="text-xs leading-relaxed text-smoke-600">
              Your wallet will ask for {actions.length} action{actions.length === 1 ? "" : "s"}. This
              dialog stays open and advances through each one.
            </p>
            <ol className="mt-3 space-y-2">
              {actions.map((action, index) => (
                <li key={`${action.kind}:${action.label}`} className="flex items-center gap-2 text-sm">
                  <span
                    className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs ${
                      complete || index < activeActionIndex
                        ? "border-melon-400 bg-melon-400 text-ink"
                        : index === activeActionIndex
                          ? "border-bluebs-500 bg-bluebs-25 text-bluebs-700"
                          : "border-smoke-300 text-smoke-500"
                    }`}
                  >
                    {complete || index < activeActionIndex ? "✓" : index + 1}
                  </span>
                  <span className={index === activeActionIndex && !complete ? "font-medium text-ink" : "text-smoke-600"}>
                    {action.label}
                  </span>
                </li>
              ))}
            </ol>
          </div>

          {activeAction ? (
            <PaymentCallReview
              action={activeAction}
              chainLabel={paymentChainName}
              amount={amount}
              tokenReturn={tokenReturn}
              beneficiary={beneficiary}
              memo={memo}
            />
          ) : null}

          {status ? <p className="text-sm text-bluebs-700">{status}</p> : null}
          {error ? <p className="text-sm text-red-600">{error}</p> : null}
        </div>
        <footer className="flex justify-end gap-2 border-t border-smoke-200 bg-bone px-5 py-4">
          {complete ? (
            <button type="button" className="btn-primary min-h-[44px] px-5 text-sm" onClick={onClose}>
              Done
            </button>
          ) : (
            <>
              <button type="button" className="btn-secondary min-h-[44px] px-5 text-sm" disabled={started} onClick={onClose}>
                {waitingForSafe ? "Close" : "Cancel"}
              </button>
              <button
                type="button"
                className="btn-primary min-h-[44px] px-5 text-sm"
                disabled={started || waitingForSafe}
                onClick={onStart}
              >
                {waitingForSafe
                  ? "Waiting for Safe"
                  : mode === "pay"
                    ? "Confirm & Pay"
                    : "Confirm & Add"}
              </button>
            </>
          )}
        </footer>
      </section>
    </div>
  );
}

function PaymentCallReview({
  action,
  chainLabel,
  amount,
  tokenReturn,
  beneficiary,
  memo,
}: {
  action: PaymentSequenceAction;
  chainLabel: string;
  amount: string;
  tokenReturn: string | null;
  beneficiary: Address | null;
  memo: string | null;
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const request = action.request;
  const destination = paymentRequestDestination(request);
  const actionName = action.label || humanPaymentAction(request.functionName);
  const reviewRequest: TransactionReviewRequest = {
    title: actionName,
    calls: [
      {
        chainId: request.chainId,
        to: request.address,
        from: beneficiary ?? undefined,
        value: request.value,
        data: encodeFunctionData({
          abi: request.abi,
          functionName: request.functionName,
          args: request.args,
        }),
        abi: request.abi,
        functionName: request.functionName,
        args: request.args,
        label: actionName,
        contractName: destination.name,
      },
    ],
  };
  return (
    <div className="rounded-xl border border-bluebs-200 bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-smoke-500">
            Exact wallet action
          </p>
          <p className="mt-1 font-medium text-ink">{actionName}</p>
        </div>
        <span className="text-xs text-smoke-500">{chainLabel}</span>
      </div>
      <dl className="mt-3 space-y-2 text-xs">
        <div>
          <dt className="text-smoke-500">Destination</dt>
          <dd className="mt-0.5 break-all text-ink">
            <span className="font-medium">{destination.name}</span> | {request.address}
          </dd>
        </div>
        <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          <dt className="text-smoke-500">
            {action.kind === "payment" ? "Amount in" : "Amount authorized"}
          </dt>
          <dd className="text-right text-ink">{amount}</dd>
          {action.kind === "token-approval" ? (
            <>
              <dt className="text-smoke-500">Spender</dt>
              <dd className="break-all text-right font-mono text-xs text-ink">
                {paymentArgumentAddress(request.args[0], request.chainId)}
              </dd>
            </>
          ) : null}
          {action.kind === "router-approval" ? (
            <>
              <dt className="text-smoke-500">Token</dt>
              <dd className="break-all text-right font-mono text-xs text-ink">
                {paymentTokenAddress(request.args[0], request.chainId)}
              </dd>
              <dt className="text-smoke-500">Spender</dt>
              <dd className="break-all text-right font-mono text-xs text-ink">
                {paymentArgumentAddress(request.args[1], request.chainId)}
              </dd>
              <dt className="text-smoke-500">Expires</dt>
              <dd className="text-right text-ink">
                {formatApprovalExpiration(request.args[3])}
              </dd>
            </>
          ) : null}
          {tokenReturn && action.kind === "payment" ? (
            <>
              <dt className="text-smoke-500">Minimum received</dt>
              <dd className="text-right text-ink">{tokenReturn}</dd>
            </>
          ) : null}
          {beneficiary && action.kind === "payment" ? (
            <>
              <dt className="text-smoke-500">Beneficiary</dt>
              <dd className="break-all text-right font-mono text-xs text-ink">{beneficiary}</dd>
            </>
          ) : null}
          {memo && action.kind === "payment" ? (
            <>
              <dt className="text-smoke-500">Note</dt>
              <dd className="text-right text-ink">{memo}</dd>
            </>
          ) : null}
        </div>
      </dl>
      <details className="mt-3 border-t border-smoke-200 pt-3">
        <summary className="cursor-pointer text-xs text-smoke-600">Show raw data</summary>
        <pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap break-all border border-smoke-300 bg-bone p-3 font-mono text-xs leading-relaxed text-ink">
          {paymentRequestJson(request, chainLabel, destination.name)}
        </pre>
      </details>
      <div className="mt-3 flex justify-end">
        <button
          type="button"
          className="btn-link min-h-[36px] text-xs"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(buildTransactionReviewPrompt(reviewRequest));
              setCopyState("copied");
            } catch {
              setCopyState("failed");
            }
            window.setTimeout(() => setCopyState("idle"), 2200);
          }}
        >
          {copyState === "copied"
            ? "Prompt copied — paste into your LLM"
            : copyState === "failed"
              ? "Could not copy prompt"
              : "[copy tx audit prompt]"}
        </button>
      </div>
    </div>
  );
}

function humanPaymentAction(functionName?: string): string {
  if (functionName === "approve") return "Approve token access";
  if (functionName === "execute") return "Direct AMM swap";
  if (functionName === "pay") return "Pay project";
  if (functionName === "addToBalanceOf") return "Add to project balance";
  return "Review wallet action";
}

function paymentRequestDestination(request: TxRequest): { name: string } {
  const deployment = uniswapV4Deployment(request.chainId);
  const knownToken = paymentTokenName(request.address, request.chainId);
  const name =
    request.address.toLowerCase() === deployment?.permit2.toLowerCase()
      ? "Permit2"
      : deployment?.universalRouter &&
          request.address.toLowerCase() === deployment.universalRouter.toLowerCase()
        ? "Uniswap Universal Router"
        : request.functionName === "approve"
          ? knownToken
            ? `${knownToken} token`
            : "Payment token"
          : request.functionName === "pay" || request.functionName === "addToBalanceOf"
            ? "Juicebox payment terminal"
            : "Contract";
  return { name };
}

function paymentTokenName(value: unknown, chainId: number): string | null {
  const address = typeof value === "string" ? value.toLowerCase() : "";
  return USDC_ADDRESSES[chainId as JBChainId]?.toLowerCase() === address ? "USDC" : null;
}

function paymentTokenAddress(value: unknown, chainId: number): string {
  const address = typeof value === "string" ? value : String(value ?? "");
  const name = paymentTokenName(address, chainId);
  return name ? `${name} | ${address}` : address;
}

function paymentArgumentAddress(value: unknown, chainId: number): string {
  const address = typeof value === "string" ? value : String(value ?? "");
  const deployment = uniswapV4Deployment(chainId);
  if (address.toLowerCase() === deployment?.permit2.toLowerCase()) {
    return `Permit2 | ${address}`;
  }
  if (
    deployment?.universalRouter &&
    address.toLowerCase() === deployment.universalRouter.toLowerCase()
  ) {
    return `Uniswap Universal Router | ${address}`;
  }
  return address;
}

function formatApprovalExpiration(value: unknown): string {
  try {
    return new Date(Number(value) * 1000).toLocaleString();
  } catch {
    return String(value ?? "");
  }
}

function paymentRequestJson(request: TxRequest, chainLabel: string, contractName: string): string {
  return JSON.stringify(
    {
      chain: chainLabel,
      chainId: request.chainId,
      contract: contractName,
      address: request.address,
      function: request.functionName,
      args: request.args,
      value: request.value ?? 0n,
      calldata: encodeFunctionData({
        abi: request.abi,
        functionName: request.functionName,
        args: request.args,
      }),
    },
    (_, value) => (typeof value === "bigint" ? value.toString() : value),
    2,
  );
}

async function waitForPaymentReceipt(client: PublicClient, hash: Hex) {
  try {
    return await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
  } catch (firstError) {
    for (let attempt = 0; attempt < 90; attempt += 1) {
      try {
        return await client.getTransactionReceipt({ hash });
      } catch {
        await new Promise(resolve => window.setTimeout(resolve, 2_000));
      }
    }
    throw firstError;
  }
}

function nextUiPaint(): Promise<void> {
  return new Promise(resolve => {
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()));
  });
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
  className = "relative inline-flex min-h-11 items-center gap-1",
  labelClassName = "font-medium text-ink underline decoration-smoke-300 decoration-1 underline-offset-4",
  selectClassName = "absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-default",
}: {
  value: string;
  onChange: (value: string) => void;
  options: {
    value: string;
    label: string;
    selectedLabel?: string;
    disabled?: boolean;
  }[];
  disabled?: boolean;
  ariaLabel: string;
  className?: string;
  labelClassName?: string;
  selectClassName?: string;
}) {
  // A native <select> sizes to its WIDEST option, which would leave a gap
  // between a short label and the caret. So show the current label + caret as
  // tight visible text and overlay a transparent, full-cover select for the
  // real (native) dropdown.
  const selected = options.find((o) => o.value === value);
  const current = selected?.selectedLabel ?? selected?.label ?? "";
  return (
    <span className={`${className} ${disabled ? "opacity-60" : ""}`}>
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
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        aria-label={ariaLabel}
        className={selectClassName}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
    </span>
  );
}

function formatStartCountdown(secs: number): string {
  if (secs <= 0) return "moments";
  const d = Math.floor(secs / 86400);
  if (d >= 1) return `${d}d ${Math.floor((secs % 86400) / 3600)}h`;
  const h = Math.floor(secs / 3600);
  if (h >= 1) return `${h}h ${Math.floor((secs % 3600) / 60)}m`;
  return `${Math.max(1, Math.floor(secs / 60))}m`;
}
