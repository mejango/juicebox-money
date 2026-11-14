"use client";

import { projectDisplayKey } from '@/lib/project-display-cache'

import {
  accountingContextsQuery,
  currentRulesetQuery,
  projectDisplayQuery,
} from '@/lib/project-display-queries'
import { contextRows, TxProgress, type TxConfirmRow } from "@/components/ui/TxProgress";
import {
  JBCoreContracts,
  NATIVE_TOKEN,
  USDC_ADDRESSES,
  jbV6ContractAddress,
  jb721TiersHookAbi,
  jbDirectoryAbi,
  jbPricesAbi,
  type JBChainId,
} from "@bananapus/nana-sdk-core";
import {
  BASE_CURRENCY_ETH,
  BASE_CURRENCY_USD,
  buildPayTx,
  decodePayFailure,
  PAY_DEFAULT_SLIPPAGE_BPS,
  PAY_MAX_SLIPPAGE_BPS,
  payRetrySlippageBps,
  effectiveTierPrice,
  getProjectNftInventory,
  PAY_QUOTE_FAILED_MESSAGE,
  PAY_SWAP_QUOTE_FAILED_MESSAGE,
  PaySwapQuoteFailedError,
  PERMIT2_ADDRESS,
  permit2PayAuthorizationReusable,
  planErc20PayAuthorization,
  prepareUserPay,
  tokenCurrencyId,
  type Erc20PayAuthorizationPlan,
} from "@bananapus/nana-sdk-core/v6";
import { useProjectNftProtocol } from "@/hooks/useProjectNftProtocol";
import { recoveringRead } from "@/lib/read-recovery";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/Skeleton";
import { ProjectPayPanelSkeleton } from "@/components/LoadingSkeletons";
import { ModalShell } from "@/components/ui/ModalShell";
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  formatUnits,
  maxUint256,
  parseUnits,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { usePayPublicClient } from "@/hooks/usePayPublicClient";
import { getAccount } from "@wagmi/core";
import { useProjectTokenSymbol } from "@/hooks/useProjectTokenSymbol";
import { revertedReceipt, reviewedCall, useReviewedAction, type TxRequest } from "@/hooks/useReviewedAction";
import { useStepRun, type StepRunAction } from "@/hooks/useStepRun";
import { useWallet } from "@/hooks/useWallet";
import { useTokenBalance } from "@/hooks/useTokenBalance";
import { useTokenBalances } from "@/hooks/useTokenBalances";
import {
  buyableAsset,
  defaultsToDollars,
  payButtonAction,
  pickedTokenIndex,
  tokensForDollars,
} from "@/lib/pay-choices";
import { useOnRamp } from "@/components/GetFunds";
import { useShopCart, useShopTabOpen } from "@/components/project/ShopCartProvider";
import { contractReverted } from "@/lib/errors";
import { formatTokenAmount, formatUsd18 } from "@/lib/format";
import { TIER_UNLIMITED_SUPPLY } from "@/lib/tier-metadata";
import { tokenSymbol } from "@/lib/token-symbol";
import {
  buildAddToBalanceRequest,
  buildErc20ApproveRequest,
} from "@/lib/transaction-builders";
import { approvalIntent, payIntent, ReviewLineError } from "@bananapus/nana-sdk-core/review";
import { legacyPayKeys } from "@/lib/legacy-intents";
import {
  signPayAuthorization,
  withPayAuthorization,
  type SignedPayAuthorization,
} from "@/lib/pay-authorization";
import { isSafeConnection } from "@/lib/safe-connector";
import { chainName } from "@/lib/urn";
import { assertReviewedAccountConnected } from "@/lib/wallet-context";
import { SAFE_PROPOSAL_UNCONFIRMED } from "@/lib/safe-connector";
import { wagmiConfig } from "@/providers/Providers";
import { preloadParaHost } from "@/providers/preload-para";
import { preloadReview } from "@/lib/preload-review";
import { replaceProjectTabHash } from "@/components/project/Tabs";
import { paymentSequenceLocked } from "@/lib/payment-sequence-lock";
import { NFT_CHECKOUT_PREVIEW_PAGE_SIZE, useShop721, useShop721Media, type Shop, type TierMedia } from "@/hooks/useShop721";
import { CheckoutAmountRow, CHECKOUT_AMOUNT_INPUT_CLASS } from "@/components/project/CheckoutAmountRow";
import { NftCartLine } from "@/components/project/NftCartLine";
import { shopCartTotal, shopCheckoutBlocked } from "@/lib/shop-cart-total";
import { NftCheckoutCard } from "@/components/project/NftCheckoutCard";
import { AllowedDecreaseField } from "@/components/project/AllowedDecreaseField";
import dynamic from 'next/dynamic'
import { explorerTxUrl } from '@/lib/chainDisplay'
import { knownPaymentRouterEntries, readPaymentRouterEntry } from '@/lib/payment-router-entry'
import { useLinkedPair } from '@/lib/sucker-group'

// The loading line is the chunk's own boundary; without it a first load falls
// through to the route skeleton.
const DefifaCheckout = dynamic(() => import('./DefifaCheckout').then(module => module.DefifaCheckout), {
  loading: () => <p role="status" className="text-sm text-smoke-600">Loading checkout…</p>,
})

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
  /** The attached terminal used consistently for preview, authorization, and payment. */
  terminal: Address;
  /** True for a registry, gateway, or direct router entry that converts the
   * token into the project's accounting token. */
  viaRouter: boolean;
};

type PaymentSequenceAction =
  /** A free signature: the payer's exact, expiring Permit2 allowance for this payment. */
  | { kind: "payment-authorization"; label: string }
  | PaymentSequenceCall;

type PaymentSequenceCall = {
  kind: "token-approval" | "payment";
  label: string;
  request: TxRequest;
  /** The write hold key for an action whose calldata regenerates on retry (an expiration, a deadline, a quote). */
  intent?: string;
  /** The keys the last release built for this action (legacy-intents). */
  legacy?: string[];
};

/** What a review froze: the wallet write is refused once the form says otherwise. */
type ReviewedPayment = {
  amountRaw: bigint;
  minReturned: bigint;
  account: Address;
  mode: "pay" | "addbalance";
  terminal: Address;
  token: Address;
  cartKey: string;
  metadata: Hex | undefined;
  /** What a tolerance the payer loosens after this payment fails is bound to. */
  payment: string;
  /** The tolerance prepareUserPay floored this payment's minimum by: what a retry loosens from. */
  slippageBps: bigint;
  /** The pool's price was unreadable when this minimum was prepared: it covers only the mint rate. */
  quoteFailed: boolean;
};

/** The pay dialog: its frozen actions and summary, and where their run stands. */
type PaySequence = {
  open: boolean;
  /** A run is in progress here. */
  started: boolean;
  complete: boolean;
  status: string | null;
  error: string | null;
  /** The step a Safe was proposed, until it executes or is dismissed: it outlives the dialog. */
  safeStage: PaymentSequenceAction["kind"] | null;
  actions: PaymentSequenceAction[];
  // What the frozen actions actually authorize. The inputs behind them keep
  // moving while the dialog is open (the amount is debounced), so the summary
  // has to be captured with the actions rather than read live. `account`
  // receives the tokens and owns the approvals: only it may send them.
  summary: ReviewedPayment | null;
  completedKinds: PaymentSequenceAction["kind"][];
  /** The run ended without finishing: the run's own state says why, and what may follow. */
  runEnded: boolean;
  /** Pay was pressed before the amount or quote was fresh: it runs again once they are. */
  submitWhenFresh: boolean;
};

const PAY_SEQUENCE_IDLE: PaySequence = {
  open: false, started: false, complete: false, status: null, error: null, safeStage: null,
  actions: [], summary: null, completedKinds: [], runEnded: false, submitWhenFresh: false,
};

type PaySequenceEvent =
  | { type: "set"; patch: Partial<PaySequence> }
  | { type: "completed"; kinds: readonly PaymentSequenceAction["kind"][] }
  /** Freeze a payment's actions and summary, and open its dialog. */
  | { type: "prepared"; actions: PaymentSequenceAction[]; summary: ReviewedPayment }
  /** Close the dialog: a run in progress, a Safe stage and the reviewed summary stay. */
  | { type: "closed"; submitWhenFresh?: boolean }
  | { type: "reset" };

function paySequence(state: PaySequence, event: PaySequenceEvent): PaySequence {
  switch (event.type) {
    case "set":
      return { ...state, ...event.patch };
    case "completed":
      return { ...state, completedKinds: [...state.completedKinds.filter(kind => !event.kinds.includes(kind)), ...event.kinds] };
    case "prepared":
      return { ...PAY_SEQUENCE_IDLE, actions: event.actions, summary: event.summary, open: true };
    case "closed":
      return { ...state, open: false, actions: [], completedKinds: [], status: null, error: null, runEnded: false, submitWhenFresh: !!event.submitWhenFresh };
    case "reset":
      return PAY_SEQUENCE_IDLE;
  }
}

const PAYMENT_CHANGED = "This payment changed during review. Close it and pay again to review the new one.";

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

/** Sentinel for the token menu's buy entry; never a token index. */
const BUY_OPTION = "buy";

/** A stable identity for a pay token — a token can appear both directly AND
 *  via-router, so the key must include the route. */
function payTokenKey(t: Pick<PayContext, "token" | "viaRouter" | "terminal">): string {
  return `${t.token.toLowerCase()}:${t.viaRouter}:${t.terminal.toLowerCase()}`;
}

type ShopInfo = {
  /** Whether `tiers` is the shop's FULL inventory. The cart prunes rows against it, so a
   *  truncated list would silently delete items the shopper added from the Shop tab. */
  tiersComplete: boolean;
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

function payShopInfo(shop: Shop, media: Record<number, TierMedia>): ShopInfo {
  return {
    // readShop walks every page, so an absent id is a removed tier and not a truncation.
    tiersComplete: true,
    hook: shop.hook,
    idTarget: shop.idTarget!,
    pricingCurrency: shop.pricing.currency,
    pricingDecimals: shop.pricing.decimals,
    tiers: shop.tiers.filter(tier => tier.initial > 0).map(tier => ({
      id: tier.id,
      price: tier.price,
      discountPercent: tier.discountPercent,
      remaining: tier.remaining,
      initial: tier.initial,
      unlimited: tier.initial >= TIER_UNLIMITED_SUPPLY,
      // Fail closed if a legacy store does not return flags: charging
      // fresh funds is safer than underfunding a credit-restricted mint.
      cantBuyWithCredits: tier.flags?.cantBuyWithCredits ?? true,
      // Metadata is cosmetic: a tier without it still sells.
      name: media[tier.id]?.name ?? null,
      description: media[tier.id]?.description ?? null,
      image: media[tier.id]?.image ?? null,
    })),
  };
}

type ShopPayRoute = {
  supported: boolean;
  /** Payment-token units per one whole shop-pricing unit. */
  pricePerUnit: bigint | null;
  reason?: string;
  /** The feed could not be READ, as opposed to not existing. Temporary, and worth retrying. */
  unavailable?: boolean;
};

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
  const queryClient = useQueryClient();
  const { isConnected, address, openSignIn } = useWallet();
  const shopTabOpen = useShopTabOpen();

  // The chain being paid — a project lives on every linked chain, and the
  // payer picks which one. projectId can differ per chain (sucker groups).
  const [deployment, setDeployment] = useState<{
    chainId: JBChainId;
    projectId: number;
  }>(() => ({ chainId: initialChainId, projectId: initialProjectId }));
  const { chainId, projectId } = deployment;
  const {
    quantities: cart,
    items: cartItems,
    count: cartCount,
    countsByChain,
    setQuantity,
    registerItem,
    clear: clearCart,
  } = useShopCart(chainId);

  useEffect(() => {
    setDeployment({ chainId: initialChainId, projectId: initialProjectId });
  }, [initialChainId, initialProjectId]);

  // Another chain's deployment comes from the indexer: it is paid only once the onchain registry links it.
  const pairCheck = useLinkedPair([initialChainId, initialProjectId], [chainId, projectId], chains.length > 1);
  const publicClient = usePayPublicClient(chainId);
  const inventory = useShop721(chainId, projectId, isRevnet);
  const identity = useProjectNftProtocol(chainId, projectId, isRevnet);
  const nativeMarket = identity.data?.protocol === 'defifa';
  const tx = useReviewedAction(chainId);
  // Once an approval is confirmed, every dependent allowance read and final
  // simulation is anchored to that receipt block. Base providers are load
  // balanced, so an unpinned `latest` call can otherwise land on a sibling
  // backend that still sees the old allowance.
  const [approvalBlock, setApprovalBlock] = useState<bigint | undefined>(undefined);
  /** The signature a reviewed payment's earlier attempt left, reused while it still authorizes it. */
  const signedAuthorization = useRef<{ reviewed: ReviewedPayment; signed: SignedPayAuthorization } | null>(null);
  /** The payment's run: its approval when one is needed, then the payment. */
  const runCalls = useRef<StepRunAction | null>(null);
  const run = useStepRun<PaymentSequenceAction>({ tx, send: tx.run, action: () => runCalls.current, onFinish: () => {} });
  // The payment is always the run's last step: a settled approval alone paid nothing.
  const paid = tx.phase === "done" && tx.lastStepSent;

  const [mode, setMode] = useState<"pay" | "addbalance">("pay");
  const [amount, setAmount] = useState("");
  const [debouncedAmount, setDebouncedAmount] = useState("");
  const [tokenIndex, setTokenIndex] = useState(0);
  // True once the user explicitly picks a pay token. Until then the selection
  // auto-defaults to the project's first accounting token (list[0]) so an
  // ETH/USDC router option never shadows a USDC/ETH project's real token — the
  // documented fund-loss desync. (website/ chooseRefinedPayToken parity.)
  const [tokenTouched, setTokenTouched] = useState(false);
  /** "$" is picked in the token menu: the payer has dollars, not the token this
   *  project takes. Nothing is bought until they press Pay — the amount is
   *  theirs to type first. */
  const [payWithDollars, setPayWithDollars] = useState(false);
  const [buyExplainerOpen, setBuyExplainerOpen] = useState(false);
  // The (address+route) identity of the user's pick, so a background refetch or
  // chain switch remaps the index to the same token rather than clobbering it.
  const selectedKeyRef = useRef<string | null>(null);
  const selectedSymbolRef = useRef("");
  /** A picked token the current chain does not accept, until the payer moves on. */
  const [droppedToken, setDroppedToken] = useState<string | null>(null);
  const [memo, setMemo] = useState("");
  const [sequence, dispatchSequence] = useReducer(paySequence, PAY_SEQUENCE_IDLE);
  const patchSequence = (patch: Partial<PaySequence>) => dispatchSequence({ type: "set", patch });
  const {
    open: sequenceOpen, started: sequenceStarted, complete: sequenceComplete, status: sequenceStatus,
    error: sequenceError, safeStage: sequenceSafeStage, actions: sequenceActions, summary: sequenceSummary,
    completedKinds: sequenceCompletedKinds, runEnded: paymentRunEnded, submitWhenFresh,
  } = sequence;
  /** A tolerance the payer loosened after a shortfall: for the next review of the payment it was set on only. */
  const [payerSlippage, setPayerSlippage] = useState<{ bps: number; payment: string } | null>(null);
  /** The tolerance offered after a shortfall, until the payer reviews again with it. */
  const [retrySlippageBps, setRetrySlippageBps] = useState<number | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedAmount(amount), 400);
    return () => clearTimeout(t);
  }, [amount]);

  const nativeSymbol = "ETH";

  // ---- The project's payment surface: accepted tokens + live ruleset ----
  // Direct tokens = the project's accounting contexts (viaRouter:false). When
  // the project also lists the router terminal, native ETH and/or USDC that
  // it does NOT accept directly are offered as swap-via-router options — but
  // ONLY when a preview through the attached entry confirms it can route them (else a
  // dead route reverts at pay time). Built atomically so the token list is
  // never a partial/desynced snapshot.
  const { data: surface, isError: surfaceError, isFetching: surfaceFetching, refetch: refetchSurface } = useQuery(projectDisplayQuery(queryClient, {
    queryKey: projectDisplayKey({ chainId, projectId: BigInt(projectId) }, "paySurface"),
    enabled: !!publicClient,
    ...recoveringRead,
    queryFn: async (reader): Promise<PaySurface> => {
      const client = publicClient!;
      const pid = BigInt(projectId);
      const args = { chainId, projectId: pid };
      const directory =
        jbV6ContractAddress[JBCoreContracts.JBDirectory][chainId];
      const multiTerminal =
        jbV6ContractAddress[JBCoreContracts.JBMultiTerminal][chainId];
      const [contexts, ruleset, terminalsRaw] = await Promise.all([
        reader.fetchQuery(accountingContextsQuery(client, args)),
        reader.fetchQuery(currentRulesetQuery(client, args)),
        client
          .readContract({
            address: directory,
            abi: jbDirectoryAbi,
            functionName: "terminalsOf",
            args: [pid],
          }),
      ]);

      const direct: PayContext[] = await Promise.all(
        contexts.map(async (ctx) => ({
          token: ctx.token,
          decimals: ctx.decimals,
          currency: ctx.currency,
          terminal: multiTerminal,
          viaRouter: false,
          symbol: await tokenSymbol(client, ctx.token, { nativeSymbol }),
        })),
      );

      const terminals = (terminalsRaw ?? []).filter(Boolean) as Address[];
      const known = new Set(
        [multiTerminal, ...knownPaymentRouterEntries(chainId)]
          .filter(Boolean)
          .map((a) => (a as Address).toLowerCase()),
      );
      const unknown = terminals.filter((t) => !known.has(t.toLowerCase()));

      // Router candidates: ETH/USDC that aren't already accepted directly,
      // each gated by an actual previewPayFor route probe.
      const has = (a: Address) =>
        direct.some((t) => t.token.toLowerCase() === a.toLowerCase());
      let routable: PayContext[] = [];
      if (terminals.length) {
        const candidates: Omit<PayContext, "terminal">[] = [];
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
          candidates.map(async (c): Promise<PayContext | null> => {
            const terminal = await readPaymentRouterEntry(client, {
              chainId,
              projectId: pid,
              terminals,
              token: c.token,
              decimals: c.decimals,
            });
            return terminal ? { ...c, terminal } : null;
          }),
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
  }));

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

  // What the payer can actually spend. Without this the form happily submits a
  // payment the wallet then rejects, with no warning anywhere in the UI.
  const { balance: walletBalance } = useTokenBalance({
    token: context?.token,
    chainId,
    isNative,
    enabled: isConnected,
  });

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
    // Touched with no token picked: the payer chose dollars, which no refetch removes.
    if (!key) return;
    const idx = pickedTokenIndex(list, key, selectedSymbolRef.current, payTokenKey);
    if (idx >= 0) {
      if (idx !== tokenIndex) setTokenIndex(idx);
      selectedKeyRef.current = payTokenKey(list[idx]);
    } else {
      // The digits typed were for the dropped token. Typed dollars still mean dollars.
      if (!payWithDollars) {
        setDroppedToken(selectedSymbolRef.current);
        setAmount("");
        setDebouncedAmount("");
      }
      selectedKeyRef.current = null;
      if (!payWithDollars) setTokenTouched(false);
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
  const notStarted = mode === "pay" && startsAt > now;

  const amountRaw = useMemo(() => {
    try {
      const trimmed = debouncedAmount.trim();
      if (!trimmed || Number(trimmed) <= 0) return 0n;
      return parseUnits(trimmed, decimals);
    } catch {
      return 0n;
    }
  }, [debouncedAmount, decimals]);

  const payActionLabel = notStarted
    ? "Soon"
    : pairCheck.pending
      ? "Checking…"
    : !isConnected
      ? "Sign in"
      : mode === "pay"
        ? "Pay"
        : "Add";

  // Offered from inside the token menu: buying the token is a way of getting
  // one, so it belongs where the token is chosen.
  const onRamp = useOnRamp({
    symbol,
    chainId,
    needed: amountRaw,
    balance: walletBalance,
    decimals,
  });

  const insufficientBalance =
    isConnected &&
    walletBalance !== undefined &&
    amountRaw > 0n &&
    amountRaw > walletBalance;

  // Every accepted token, not only the selected one: whether this wallet can pay AT ALL is what
  // decides the default choice below, and one token's balance cannot answer that.
  const acceptedTokens = useMemo(
    () =>
      contexts.map(ctx => ({
        address: ctx.token,
        isNative: ctx.token.toLowerCase() === NATIVE_TOKEN.toLowerCase(),
      })),
    [contexts],
  );
  const { balances: acceptedBalances } = useTokenBalances(
    acceptedTokens,
    chainId,
  );
  const buyableLabel = buyableAsset({
    accepted: contexts.map(ctx => ctx.symbol),
    preferred: symbol,
  });
  const holdsNothing = defaultsToDollars({
    isConnected,
    balances: acceptedTokens.map(
      token => acceptedBalances.get(token.address),
    ),
  });

  // A wallet with nothing in it cannot pay in any of these tokens, so the menu opens on "$"
  // rather than on a token the payer would have to go and acquire first. Their own choice wins
  // the moment they make one.
  // Never dollars where they cannot buy anything: Pay would open a purchase that does nothing.
  useEffect(() => {
    if (context && !onRamp.supported) setPayWithDollars(false);
    else if (!tokenTouched) setPayWithDollars(holdsNothing);
  }, [holdsNothing, tokenTouched, onRamp.supported, context]);

  // ---- 721 shop strip: hook + tiers, priced in the shop's currency ----
  // The Shop tab's read, whose tiers come without resolved URIs: asking the store to resolve a
  // whole page reverts on a large shop. Only a verified generic shop is sold from here.
  const inventoryShop = identity.isSuccess && !nativeMarket && inventory.data?.protocol === "jb721" ? inventory.data : null;
  const { data: shopMedia } = useShop721Media(chainId, inventoryShop);
  const shop = useMemo(() => inventoryShop ? payShopInfo(inventoryShop, shopMedia ?? {}) : null, [inventoryShop, shopMedia]);
  const shopPending = identity.isPending || (!nativeMarket && inventory.isPending && !inventory.isError);
  const shopFailed = !shop && !nativeMarket && !!inventory.isError;

  // Dollars are what the amount means only while nothing in a cart sets it in tokens.
  const amountIsDollars = payWithDollars && cartCount === 0;
  // The digits on screen stop meaning what they meant when their unit changes or the cart that
  // set them empties. A cart that remains sets its own total below.
  const previousCartCount = useRef(cartCount);
  useEffect(() => {
    const hadItems = previousCartCount.current > 0;
    previousCartCount.current = cartCount;
    if (hadItems && cartCount === 0) {
      setAmount("");
      setDebouncedAmount("");
    }
  }, [cartCount]);
  useEffect(() => {
    if (cartCount > 0) return;
    setAmount("");
    setDebouncedAmount("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payWithDollars]);

  // Keep the shared cart's presentation metadata fresh even before the user
  // opens the Shop tab. Clamp stale quantities against live per-chain supply.
  useEffect(() => {
    if (!shop) return;
    const liveIds = new Set(shop.tiers.map((tier) => tier.id));
    for (const tier of shop.tiers) {
      registerItem({
        tierId: tier.id,
        // A tier whose media hasn't resolved says nothing: a name already registered stands.
        name: tier.name ?? undefined,
        image: tier.image ?? undefined,
      });
      const quantity = cart[tier.id] ?? 0;
      const cap = tier.unlimited ? 99 : tier.remaining;
      if (quantity > cap) setQuantity(tier.id, cap);
    }
    // Only ever prune against a COMPLETE tier list. `shop` is now paged to completion, so an
    // id missing from it really is gone from the shop — but the guard stays explicit, because
    // the failure mode is destroying a shopper's cart, and it is silent.
    if (!shop.tiersComplete) return;
    for (const id of Object.keys(cart).map(Number)) {
      if (!liveIds.has(id)) setQuantity(id, 0);
    }
  }, [shop, cart, registerItem, setQuantity]);

  const { data: shopCredits = 0n, isLoading: shopCreditsLoading, isError: shopCreditsFailed, refetch: refetchShopCredits } = useQuery({
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
      const prices = jbV6ContractAddress[JBCoreContracts.JBPrices][chainId];
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
          // A REVERT is JBPrices_PriceFeedNotFound — the chain answered, and this pair really
          // has no feed. A transport failure is not, and used to collapse into the same `0n`
          // and produce the same permanent-sounding verdict about a momentary outage. Both
          // still fail closed; only the explanation, and whether it's worth retrying, differ.
          let pricePerUnit: bigint;
          try {
            pricePerUnit = await publicClient!.readContract({
              address: prices,
              abi: jbPricesAbi,
              functionName: "pricePerUnitOf",
              args: [
                BigInt(projectId),
                BigInt(payContext.currency),
                BigInt(shop!.pricingCurrency),
                BigInt(payContext.decimals),
              ],
            });
          } catch (error) {
            return [
              key,
              contractReverted(error)
                ? {
                    supported: false,
                    pricePerUnit: null,
                    reason: "No price feed converts this payment token.",
                  }
                : {
                    supported: false,
                    pricePerUnit: null,
                    unavailable: true,
                    reason:
                      "Couldn't check this token's price feed. Try again in a moment.",
                  },
            ] as const;
          }
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
  // A feed the app could not READ is not a feed the protocol lacks. Both hide the route, but
  // only one is permanent, and only one is worth retrying.
  const shopRouteCheckFailed = Object.values(shopRoutes ?? {}).some(
    (route) => route.unavailable,
  );
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
    selectedSymbolRef.current = preferred.context.symbol;
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
    return shopCartTotal(shop.tiers, cart);
  }, [shop, cart, cartCount]);
  const restrictedCartTotal = useMemo(() => {
    if (!shop) return 0n;
    return shopCartTotal(shop.tiers.filter(tier => tier.cantBuyWithCredits), cart);
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
  const tiers =
    shop && tierIds.length > 0 && shopMatchesToken
      ? { metadataIdTarget: shop.idTarget, tierIdsToMint: tierIds }
      : undefined;

  // ---- Terminal + preview ----
  // Preview, allowance, approval, and pay target the exact attached entry that
  // supplied this token's route, including a directly attached gateway.
  const terminalAddress = context?.terminal;

  // The tolerance prepareUserPay floors its quote by: the SDK default, or the
  // one the payer loosened after this same payment fell short.
  const paymentInputs = `${address ?? ""}:${chainId}:${projectId}:${terminalAddress}:${context?.token}:${amountRaw}:${tierIds.join(",")}`;
  const slippageBps = payerSlippage?.payment === paymentInputs ? payerSlippage.bps : undefined;
  // Another payment drops it, so coming back to this one starts from the default again.
  useEffect(() => {
    if (payerSlippage && payerSlippage.payment !== paymentInputs) setPayerSlippage(null);
  }, [payerSlippage, paymentInputs]);

  // One read prepares the payment: the metadata to send (shop items plus the
  // buyback hook's pool-or-mint choice), the preview, and the minimum.
  const {
    data: prepared,
    isFetching: previewLoading,
    isError: previewError,
    error: previewFailure,
    isPlaceholderData: previewIsPrevious,
    isStale: previewIsStale,
    refetch: refetchPreview,
  } = useQuery({
    queryKey: [
      "prepareUserPay",
      chainId,
      projectId,
      context?.token,
      context?.viaRouter,
      terminalAddress,
      amountRaw.toString(),
      address ?? null,
      tiers?.metadataIdTarget ?? null,
      tierIds.join(","),
      slippageBps ?? null,
    ],
    enabled:
      !!publicClient &&
      !!context &&
      !!terminalAddress &&
      (amountRaw > 0n || cartCount > 0) &&
      !amountIsDollars &&
      mode === "pay" && !nativeMarket && identity.isSuccess,
    // Keep the last verified quote mounted while the next amount is quoted.
    // The receipt gently dims it below, and submission stays blocked until the
    // fresh quote arrives. Another token's or chain's is no hint at all.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === chainId &&
      previousQuery?.queryKey[3] === context?.token &&
      previousQuery?.queryKey[4] === context?.viaRouter
        ? previous
        : undefined,
    retry: false,
    queryFn: () =>
      prepareUserPay(publicClient!, {
        chainId,
        terminal: terminalAddress!,
        projectId: BigInt(projectId),
        token: context!.token,
        amount: amountRaw,
        beneficiary: address ?? zeroAddress,
        tiers,
        ...(slippageBps !== undefined ? { slippageBps: BigInt(slippageBps) } : {}),
      }),
  });
  const preview = prepared?.preview;

  // ---- What the amount is worth in dollars ----
  // Display only: nothing sends these. Paying with dollars buys the token first, and the payment
  // after that gets its own quote and review. A token with no price simply shows no figure.
  const { data: tokensPerDollar, isLoading: dollarPriceLoading } = useQuery({
    queryKey: ["payTokensPerDollar", chainId, projectId, context?.currency, decimals],
    enabled: !!publicClient && !!context && mode === "pay" && amountRaw > 0n,
    staleTime: 60_000,
    retry: 1,
    queryFn: () =>
      publicClient!.readContract({
        address: jbV6ContractAddress[JBCoreContracts.JBPrices][chainId],
        abi: jbPricesAbi,
        functionName: "pricePerUnitOf",
        args: [BigInt(projectId), BigInt(context!.currency), BigInt(BASE_CURRENCY_USD), BigInt(decimals)],
      }),
  });
  const dollarsInToken =
    amountIsDollars && tokensPerDollar ? tokensForDollars(debouncedAmount, tokensPerDollar) : 0n;
  const { data: dollarQuote, isFetching: dollarQuoteLoading } = useQuery({
    queryKey: [
      "payDollarQuote",
      chainId,
      projectId,
      context?.token,
      context?.viaRouter,
      terminalAddress,
      dollarsInToken.toString(),
      address ?? null,
    ],
    enabled:
      !!publicClient && !!context && !!terminalAddress && mode === "pay" &&
      dollarsInToken > 0n && !nativeMarket && identity.isSuccess,
    retry: false,
    queryFn: () =>
      prepareUserPay(publicClient!, {
        chainId,
        terminal: terminalAddress!,
        projectId: BigInt(projectId),
        token: context!.token,
        amount: dollarsInToken,
        beneficiary: address ?? zeroAddress,
      }),
  });
  const amountUsd = !amountIsDollars && tokensPerDollar && amountRaw > 0n
    ? (amountRaw * 10n ** 18n) / tokensPerDollar
    : null;

  // What the receipt reads, and whether it still answers what is typed.
  const receipt = amountIsDollars ? dollarQuote : prepared;
  const receiptPending =
    amount !== debouncedAmount ||
    (amountIsDollars
      ? dollarPriceLoading || dollarQuoteLoading
      : previewLoading || previewIsPrevious);
  const receiptPendingClass = receiptPending ? "opacity-40" : "";
  const showReceipt =
    mode === "pay" &&
    (amountIsDollars
      ? dollarPriceLoading || dollarQuoteLoading || (dollarsInToken > 0n && !!dollarQuote && dollarQuote.preview.beneficiaryTokenCount > 0n)
      : amountRaw > 0n && !previewError && (previewLoading || (!!preview && preview.beneficiaryTokenCount > 0n)));
  const receiptIsEstimate = amountIsDollars || (!!prepared && prepared.minReturnedTokens < (preview?.beneficiaryTokenCount ?? 0n));
  // The payment whose quote the payer asked to read again, until that read settles.
  // A background refetch keeps the notice; only the payer's own retry says Refreshing.
  const [quoteRetryFor, setQuoteRetryFor] = useState<string | null>(null);
  const retryQuote = () => {
    const key = paymentInputs;
    setQuoteRetryFor(key);
    void refetchPreview().finally(() => setQuoteRetryFor(current => (current === key ? null : current)));
  };

  // A VERIFIED zero preview may submit (min 0 — zero-issuance pay is
  // legitimate); an unavailable preview blocks (never send blind).
  const previewReady =
    mode === "addbalance" ||
    (!!preview && !previewError && !previewLoading && !previewIsPrevious);
  const minReturned = prepared?.minReturnedTokens ?? 0n;

  // ---- ERC-20 allowance ----
  // ERC-20 pays approve the attached entry that received the preview: the
  // multi terminal, registry, gateway, or direct router. Each accepts a direct
  // ERC-20 allowance, so approve(entry, amount) also preserves gateway custody.
  //
  // How the payer authorizes it is one SDK rule: nothing when the entry is
  // already approved, a free Permit2 signature for an EOA (after one approval of
  // Permit2 itself), an exact approval of the entry for a Safe or other contract wallet.
  const approvalSpender = terminalAddress;
  const { data: authorizationPlan, refetch: refetchAuthorization } = useQuery({
    queryKey: [
      "payAuthorization",
      chainId,
      context?.token,
      approvalSpender,
      address,
      amountRaw.toString(),
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
      planErc20PayAuthorization(publicClient!, {
        chainId,
        owner: address!,
        token: context!.token,
        entry: approvalSpender!,
        amount: amountRaw,
        blockNumber: approvalBlock,
        isSafe: isSafeConnection(wagmiConfig),
      }),
  });

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

  const sequenceSafeTx = tx;
  const sequenceSafePhase = sequenceSafeTx.phase;
  const sequenceSafeError = sequenceSafeTx.error;
  // A Safe stage with the Safe says where it is in place of the stage's own line:
  // awaiting its signers, executed with its receipt still missing, or unproven.
  const sequenceSafeNotice = sequenceSafeStage ? sequenceSafeTx.notice : null;
  // A stage the write hold holds (its follower couldn't prove it) shows the hold's line and exit.
  const sequenceSafeHeld = sequenceSafeStage && sequenceSafeTx.phase === "held" ? sequenceSafeTx.error : null;
  const endedTx = paymentRunEnded ? tx : null;
  const endedPayment = paymentRunEnded ? tx.failure : null;
  const endedPay = mode === "pay" ? endedPayment : null;
  const payFailure = endedPay ? decodePayFailure(endedPay) : null;
  const minedRevert = !!revertedReceipt(endedPayment);
  // A mined revert carries no reason: the pay is reviewed again, quoted and simulated afresh.
  const reviewAfterRevert = mode === "pay" && minedRevert;
  // A candidate from the tolerance this attempt was prepared with; the payer sees and edits it, and it is prepared and reviewed again.
  const suggestedRetryBps = endedPay && sequenceSummary ? payRetrySlippageBps(payFailure, sequenceSummary.slippageBps) : null;
  const retryBps = retrySlippageBps ?? (suggestedRetryBps === null ? null : Number(suggestedRetryBps));
  const endedLine = !endedTx ? null
    : endedTx.phase === "held" ? endedTx.error
      : minedRevert ? (mode === "pay" ? "The payment reverted." : "Payment reverted onchain.")
      : payFailure?.message ?? endedTx.error;
  // A payment the hold still has in flight is never sent again from here.
  const sequencePending = paymentRunEnded && tx.phase === "held" ? tx.hash : null;
  const panelTxError = sequenceSafeHeld ? null : tx.error;
  // A stage another flow dismissed shows nothing any more.
  const sequenceSafeLost = !!sequenceSafeStage && sequenceSafeTx.phase === "idle";
  // An unproven or lost stage ends with its line: Dismiss releases its call and frees the panel.
  const sequenceSafeReleasable =
    !!sequenceSafeStage && (sequenceSafeTx.confirmationUncertain || sequenceSafeLost);
  const dismissSequenceSafeStage = () => {
    sequenceSafeTx.dismiss();
    patchSequence({ safeStage: null });
  };

  useEffect(() => {
    if (!sequenceSafeStage) return;
    if (sequenceSafeTx.stopped) {
      patchSequence({ safeStage: null, error: typeof sequenceSafeError === "string" ? sequenceSafeError : "The Safe action could not be completed." });
      return;
    }
    // An approval a Safe ran after its run ended settles as the run's earlier step.
    if (sequenceSafePhase !== "done" && sequenceSafeTx.settledStep == null) return;
    dispatchSequence({ type: "completed", kinds: [sequenceSafeStage] });
    if (sequenceSafeStage === "payment") {
      patchSequence({ safeStage: null, complete: true, status: mode === "pay" ? "Payment confirmed." : "Added to the balance." });
    } else {
      patchSequence({ status: "Safe action confirmed. Refreshing approvals…" });
      void refetchAuthorization()
        .then(() => {
          patchSequence({ safeStage: null, status: "Safe action confirmed. Continue to the next payment action." });
        })
        .catch(() => {
          patchSequence({ safeStage: null, error: "The Safe action confirmed, but its updated allowance is not available yet. Try again shortly." });
        });
    }
  }, [
    mode,
    refetchAuthorization,
    sequenceSafeError,
    sequenceSafePhase,
    sequenceSafeTx.stopped,
    sequenceSafeTx.settledStep,
    sequenceSafeStage,
  ]);

  const busy =
    tx.phase === "simulating" ||
    tx.phase === "signing" ||
    tx.phase === "receipt" ||
    tx.phase === "held" ||
    sequenceStarted ||
    !!sequenceSafeStage;

  useEffect(() => {
    if (!sequenceOpen) return;
    const activePhase = tx.phase;
    if (activePhase === "simulating") patchSequence({ status: "Checking the reviewed wallet action…" });
    else if (activePhase === "signing") patchSequence({ status: "Confirm this action in your wallet." });
    else if (activePhase === "receipt") patchSequence({ status: "Submitted. Confirming onchain…" });
  }, [sequenceOpen, tx.phase]);

  const preparePaymentSequence = (): PaymentSequenceAction[] => {
    if (!address || !context || !terminalAddress) return [];
    const actions: PaymentSequenceAction[] = [];
    // One intent for what the user chose, whatever route, price, clamp or fallback the app applies.
    // Every payment to this project for this beneficiary: pay, checkout or add to balance,
    // whatever token, amount, route or cart.
    const paymentKey = payIntent({ chainId, project: projectId, beneficiary: address });
    // The keys the last release built for this payment: an attempt it left unresolved still holds it.
    const paymentLegacy = legacyPayKeys({
      mode, chainId, projectId, hook: shop?.hook, amount: debouncedAmount, token: context.token,
      cart, checkoutReady: !!tiers, beneficiary: address, memo: memo.trim(),
    });
    const approval = (spender: Address, approved: bigint, label: string): PaymentSequenceCall => ({
      kind: "token-approval",
      label,
      request: buildErc20ApproveRequest({ chainId, token: context.token, spender, amount: approved }),
      intent: approvalIntent(paymentKey, { step: "token-approval", token: context.token, spender }),
    });
    // An unread plan is not assumed away: the exact approval works for every wallet.
    const plan: Erc20PayAuthorizationPlan | null = isNative
      ? null
      : authorizationPlan ?? { kind: "approve", spender: approvalSpender!, amount: amountRaw };
    if (plan?.kind === "permit2") {
      // The signature comes first: declining it costs nothing and leaves no approval behind.
      actions.push({ kind: "payment-authorization", label: "Authorize the payment (free signature)" });
      if (plan.needsTokenApproval) {
        actions.push(approval(PERMIT2_ADDRESS, maxUint256, `Let Permit2 move your ${symbol} (one time)`));
      }
    } else if (plan?.kind === "approve") {
      actions.push(approval(plan.spender, plan.amount, `Approve ${symbol} access`));
    }
    let paymentRequest: TxRequest;
    if (mode === "pay") {
      const request = buildPayTx({
        chainId,
        terminal: terminalAddress,
        projectId: BigInt(projectId),
        token: context.token,
        amount: amountRaw,
        beneficiary: address,
        minReturnedTokens: minReturned,
        memo: memo.trim() || undefined,
        metadata: prepared?.metadata,
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
        mode === "pay" ? "Execute the payment" : "Add to the project balance",
      request: paymentRequest,
      // Its minimum re-quotes and its route may change on retry: held by what the user chose.
      intent: paymentKey,
      legacy: paymentLegacy,
    });
    return actions;
  };

  // One guard for the Pay button and for submit, which re-enters after a
  // queued preparation: whatever changed meanwhile still blocks the review.
  const formClosed =
    !pairCheck.linked ||
    notStarted ||
    surfaceError ||
    // An unverified project is never paid: its protocol decides what a payment must carry.
    (mode === "pay" && !identity.isSuccess) ||
    terminalBlocked ||
    addBalanceViaRouter ||
    (surface?.pausePay && mode === "pay");
  const formBlocked = busy || formClosed;
  const cartBlocked = shopCheckoutBlocked({
    count: cartCount,
    routesLoading: shopRoutesLoading,
    creditsLoading: shopCreditsLoading,
    creditsFailed: shopCreditsFailed,
    matchesToken: shopMatchesToken,
  });
  const cartKey = tierIds.join(",");

  // The last check before the wallet: the same guards, the payment's preparation
  // settled and unchanged, and the form still saying what was reviewed. Read live,
  // since a review or simulation can outlast a refresh or an edit. Age alone never
  // blocks: an older minimum still protects the payer, at worst by reverting.
  const writeState = useRef<(reviewed: ReviewedPayment) => void>(() => {});
  writeState.current = (reviewed) => {
    const unchanged =
      reviewed.mode === mode &&
      reviewed.terminal === terminalAddress &&
      reviewed.token === context?.token &&
      reviewed.amountRaw === amountRaw &&
      amount === debouncedAmount &&
      reviewed.cartKey === cartKey;
    const preparedFresh =
      mode !== "pay" ||
      (!!prepared &&
        !previewError &&
        !previewLoading &&
        !previewIsPrevious &&
        prepared.metadata === reviewed.metadata &&
        prepared.minReturnedTokens === reviewed.minReturned);
    const identityReady = mode !== "pay" || (!nativeMarket && identity.isSuccess);
    if (formClosed || cartBlocked || !identityReady || !unchanged || !preparedFresh) {
      throw new ReviewLineError(PAYMENT_CHANGED);
    }
  };

  const submit = () => {
    if (mode === "pay" && (nativeMarket || !identity.isSuccess)) return;
    const action = payButtonAction({ isConnected, payWithDollars });
    if (action === "signIn") {
      openSignIn();
      return;
    }
    if (action === "buyFirst") {
      setBuyExplainerOpen(true);
      return;
    }
    if (!address || formBlocked || cartBlocked) return;
    // The amount sent is the one prepared, which trails the input by its
    // debounce. Prepare what is typed now, then continue once that is ready.
    if (amount !== debouncedAmount) {
      setDebouncedAmount(amount);
      patchSequence({ submitWhenFresh: true });
      return;
    }
    const creditOnlyCheckout =
      mode === "pay" && cartCount > 0 && cartAmountDue === 0n;
    if (
      !context ||
      !terminalAddress ||
      (amountRaw <= 0n && !creditOnlyCheckout)
    ) {
      return;
    }
    // A quote older than the query's staleTime is refetched first; the effect
    // below re-enters once the refreshed quote is in. A live quote is used as is.
    if (mode === "pay" && previewIsStale) {
      patchSequence({ submitWhenFresh: true });
      void refetchPreview();
      return;
    }
    let actions: PaymentSequenceAction[]
    try {
      // An unhandled builder throw here surfaced as a dead click.
      actions = preparePaymentSequence();
    } catch (reason) {
      patchSequence({
        error: reason instanceof Error
          ? reason.message
          : "This payment could not be prepared. Check the amount and try again.",
        open: true,
      });
      return;
    }
    if (!actions.length) return;
    dispatchSequence({
      type: "prepared",
      actions,
      summary: {
        amountRaw, minReturned, account: address, mode, terminal: terminalAddress, token: context.token,
        cartKey, metadata: mode === "pay" ? prepared?.metadata : undefined, payment: paymentInputs,
        slippageBps: slippageBps !== undefined ? BigInt(slippageBps) : PAY_DEFAULT_SLIPPAGE_BPS,
        quoteFailed: mode === "pay" && !!prepared?.quoteFailed,
      },
    });
  };

  useEffect(() => {
    if (!submitWhenFresh) return;
    if (previewError) {
      patchSequence({ submitWhenFresh: false });
      return;
    }
    if (!previewReady || (mode === "pay" && previewIsStale)) return;
    patchSequence({ submitWhenFresh: false });
    submit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submitWhenFresh, previewReady, previewIsStale, previewError, mode]);

  // The payment's own summary: shown on its progress, and first in its review.
  const sequenceRows: TxConfirmRow[] = [
    {
      label: "Send",
      value: `${formatTokenAmount(sequenceSummary?.amountRaw ?? amountRaw, decimals)} ${symbol}`,
      strong: true,
    },
    { label: "On", value: chainName(chainId) },
    ...(mode === "pay" && sequenceSummary
      ? [{ label: "You get at least", value: `${formatTokenAmount(sequenceSummary.minReturned, 18)} ${projectTokenLabel}`, strong: true }]
      : []),
    ...(sequenceSummary ? [{ label: "Beneficiary", value: sequenceSummary.account, mono: true }] : []),
    ...(memo.trim() ? [{ label: "Note", value: memo.trim() }] : []),
  ];
  const sequenceContext = [
    ...contextRows(sequenceRows),
    ...(mode === "pay" && sequenceSummary?.quoteFailed ? [{ label: "Quote", value: PAY_QUOTE_FAILED_MESSAGE }] : []),
    ...(payDisclosure ? [{ label: "Project notice", value: payDisclosure, strong: true }] : []),
  ];

  const runPaymentSequence = async () => {
    if (mode === "pay" && (nativeMarket || !identity.isSuccess)) return;
    const reviewed = sequenceSummary;
    const account = reviewed?.account;
    if (
      !reviewed ||
      !address ||
      !account ||
      !context ||
      !terminalAddress ||
      !publicClient ||
      !sequenceActions.length ||
      sequenceStarted ||
      // A submitted-but-unconfirmed payment must never be re-sent.
      sequencePending
    ) return;
    patchSequence({ started: true, error: null, runEnded: false });
    setRetrySlippageBps(null);
    // Each send refuses another account on its own; checking before each step
    // also says so here, where a refused send would read as a cancelled one.
    const stillReviewed = () =>
      assertReviewedAccountConnected(account, getAccount(wagmiConfig).address);
    const actionOf = (kind: PaymentSequenceAction["kind"]) =>
      sequenceCompletedKinds.includes(kind)
        ? undefined
        : sequenceActions.find(action => action.kind === kind);
    try {
      stillReviewed();
      if (mode === "pay") {
        const liveInventory = await getProjectNftInventory(publicClient, {
          chainId, projectId: BigInt(projectId), isRevnet, tierLimit: 1,
        });
        if (liveInventory?.protocol === 'defifa') {
          throw new ReviewLineError('Defifa payments are not supported by this form.');
        }
      }
      const paymentAction = actionOf("payment");
      if (paymentAction?.kind !== "payment") {
        throw new ReviewLineError("The reviewed payment action is unavailable.");
      }
      // An approval that confirmed after its run ended is not asked for again.
      const reviewedApproval = actionOf("token-approval");
      let tokenApproval = reviewedApproval?.kind === "token-approval" ? reviewedApproval : undefined;
      let payment: PaymentSequenceCall = paymentAction;
      const signs = sequenceActions.some(action => action.kind === "payment-authorization");
      if (tokenApproval || signs) {
        const { data: current } = await refetchAuthorization();
        if (current?.kind === "none") {
          // The entry is approved already: the payment goes as reviewed, with nothing to sign.
          tokenApproval = undefined;
        } else if (signs) {
          // A wallet that turned out to be a contract cannot sign this: the payment is reviewed again.
          if (current?.kind !== "permit2") throw new ReviewLineError(PAYMENT_CHANGED);
          if (!current.needsTokenApproval) tokenApproval = undefined;
          const kept = signedAuthorization.current;
          let signed = kept?.reviewed === reviewed && permit2PayAuthorizationReusable(kept.signed, current.authorization)
            ? kept.signed
            : null;
          if (!signed) {
            patchSequence({ status: "Sign the payment authorization in your wallet. It is free." });
            signed = await signPayAuthorization(current.authorization, account);
            signedAuthorization.current = { reviewed, signed };
          }
          stillReviewed();
          writeState.current(reviewed);
          dispatchSequence({ type: "completed", kinds: ["payment-authorization"] });
          // The payment carries the signed allowance in its metadata, its last argument.
          const args = [...(paymentAction.request.args as readonly unknown[])];
          args[args.length - 1] = withPayAuthorization(args.at(-1) as Hex | undefined, signed);
          payment = { ...paymentAction, request: { ...paymentAction.request, args } };
        }
      }
      const steps = [...(tokenApproval ? [tokenApproval] : []), payment];
      await nextUiPaint();
      patchSequence({ status: mode === "pay" ? "Review the payment." : "Review adding to the balance." });
      runCalls.current = {
        account,
        // The approval and the payment are one review: the payment simulates on the approval's receipt block.
        calls: steps.map((action, index) => reviewedCall(action.request, {
          intent: action.intent,
          legacy: action.legacy,
          ...(index > 0 ? {} : { simulationBlockNumber: approvalBlock }),
        })),
        context: sequenceContext,
        // An approval and its payment resume as one action after a reload.
        scope: `jbm:pay:${chainId}:${projectId}:${reviewed.terminal}:${reviewed.token}`,
        assertWriteState: () => writeState.current(reviewed),
      };
      // The payment is the run's last step, so a run of fewer calls is the payment alone.
      const paid = await run.start(sequenceActions);
      // The kinds of the run's calls: a saved run continues with its own.
      const kinds = paid ? sequenceActions.slice(paid.shown(0)).map(action => action.kind) : [];
      if (!paid) {
        writeState.current(reviewed);
        // Its line, its retry and a held payment's "do not send again" come from the run's own state.
        patchSequence({ status: null, runEnded: true });
        return;
      }
      if (paid.status === "proposed") {
        // A Safe executes each step as its own proposal: an approval first, then the payment.
        const stage = kinds[paid.step] ?? "payment";
        patchSequence({ safeStage: stage, status: stage === "token-approval"
          ? "Approval proposed to your Safe. Execute it there before continuing."
          : "Payment proposed to your Safe. Execute it there to finish." });
        return;
      }
      if (kinds.length > 1 && paid.receipts.length > 1) setApprovalBlock(paid.receipts[0]?.blockNumber);
      dispatchSequence({ type: "completed", kinds });
      patchSequence({ complete: true, status: mode === "pay" ? "Payment confirmed." : "Added to the balance." });
    } catch (reason) {
      patchSequence({ status: null });
      // A payment that changed during review, or whose account did, says so; otherwise the revert's own reason, when known.
      let changed: string | null = reason instanceof Error && reason.message === PAYMENT_CHANGED ? PAYMENT_CHANGED : null;
      try {
        stillReviewed();
      } catch (switched) {
        changed = switched instanceof Error ? switched.message : PAYMENT_CHANGED;
      }
      patchSequence({ error: changed ?? (reason instanceof Error ? reason.message : "The payment could not be completed.") });
    } finally {
      patchSequence({ started: false });
    }
  };

  /** Prepare the payment again, with the tolerance the payer chose when given, and review it from the start. */
  const reviewAgain = (bps: number | null) => {
    if (!sequenceSummary) return;
    if (bps !== null) setPayerSlippage({ bps, payment: sequenceSummary.payment });
    // Every review again quotes afresh, even at a tolerance quoted moments ago.
    void queryClient.invalidateQueries({ queryKey: ["prepareUserPay"] });
    run.clear();
    setRetrySlippageBps(null);
    dispatchSequence({ type: "closed", submitWhenFresh: true });
  };

  const reset = () => {
    run.clear();
    setApprovalBlock(undefined);
    dispatchSequence({ type: "reset" });
    setRetrySlippageBps(null);
    setPayerSlippage(null);
    setAmount("");
    setDebouncedAmount("");
    setMemo("");
    clearCart();
  };

  useEffect(() => {
    if (paid && cartCount > 0) clearCart();
  }, [paid, cartCount, clearCart]);

  // An approval whose run ended before it settled can confirm later: it counts as done, and the payment continues.
  useEffect(() => {
    if (!paymentRunEnded || tx.settledStep == null || tx.lastStepSent) return;
    dispatchSequence({ type: "completed", kinds: ["token-approval"] });
    patchSequence({ runEnded: false, status: "Approval confirmed. Continue to the payment." });
    void refetchAuthorization();
  }, [paymentRunEnded, tx.settledStep, tx.lastStepSent, refetchAuthorization]);

  // ---- Success view ----
  if (paid) {
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
            : `${projectName}'s balance grew. You got no tokens.`}
        </p>
        {tx.hash && explorerTxUrl(chainId, tx.hash) ? (
          <a
            href={explorerTxUrl(chainId, tx.hash)!}
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

  const switchChain = (value: string) => {
    const next = chains.find(([cid]) => cid === Number(value));
    if (!next) return;
    setDroppedToken(null);
    // Digits typed for a token stay with that token: its new chain's list keeps it or says it can't.
    if (context && amount.trim() && !selectedKeyRef.current) {
      selectedKeyRef.current = payTokenKey(context);
      selectedSymbolRef.current = context.symbol;
      setTokenTouched(true);
    }
    setDeployment({
      chainId: next[0] as JBChainId,
      projectId: next[1],
    });
  };
  // Items waiting on another of this project's chains, until the payer goes back or empties them.
  const otherChainCart = chains
    .map(([cid]) => ({ chainId: cid, count: countsByChain[cid] ?? 0 }))
    .find(other => other.chainId !== chainId && other.count > 0);

  const addBalanceAction = <button type="button" className="btn-secondary px-4 py-2" disabled={busy} onClick={() => setMode('addbalance')}>Add to balance</button>;
  if (mode === 'pay' && nativeMarket && !pairCheck.linked) {
    return pairCheck.line ? <p role="alert" className="text-sm text-red-600">{pairCheck.line}</p> : <ProjectPayPanelSkeleton embedded />;
  }
  if (mode === 'pay' && nativeMarket && inventory.data?.protocol === 'defifa') {
    return <div className="space-y-4"><DefifaCheckout chainId={chainId} projectId={projectId} shop={inventory.data} />{addBalanceAction}</div>;
  }
  if (mode === 'pay' && nativeMarket) {
    const failed = inventory.isError || (inventory.isSuccess && inventory.data?.protocol !== 'defifa');
    if (!failed) return <ProjectPayPanelSkeleton embedded />;
    return <div className="space-y-2 text-sm text-smoke-600">
      <p>Could not read Defifa NFT tiers.</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn-secondary px-4 py-2" onClick={() => void inventory.refetch()}>Retry</button>
        {addBalanceAction}
      </div>
    </div>;
  }

  // One line for every read Pay refuses without. The verdict waits while a read is being tried again.
  const payDetailsFailed = surfaceError || (mode === "pay" && identity.isError);
  const payDetailsRetrying = surfaceFetching || identity.isFetching;
  const retryPayDetails = () => {
    if (surfaceError) void refetchSurface();
    if (identity.isError) void identity.refetch();
  };

  const shopInPay = !!shop && shop.tiers.length > 0 && mode === "pay";
  const hasShopPreview = shopInPay && !shopTabOpen;
  const shopCheckoutNotice = !shopInPay || cartCount === 0 ? null : shopRoutesLoading ? (
    <Skeleton
      className="mt-2 h-3 w-40 rounded"
      role="status"
      aria-label="Loading checkout currencies"
    />
  ) : supportedShopContextIndexes.length === 0 ? (
    <p className="mt-1 text-xs leading-relaxed text-red-600">
      {shopRouteCheckFailed
        ? `Couldn't check which payment tokens have a price feed for these items on ${chainName(chainId)}. Try again in a moment.`
        : `No directly accepted payment token has a verified price feed for these items on ${chainName(chainId)}.`}
    </p>
  ) : !shopMatchesToken ? (
    <p className="mt-1 text-xs leading-relaxed text-smoke-700">
      Switching to a supported checkout currency…
    </p>
  ) : null;

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
                replaceProjectTabHash("#shop");
              }}
              className="text-xs font-medium text-bluebs-600 hover:underline"
            >
              All →
            </button>
          </div>
          {shopCheckoutNotice}

          <div className="mt-2 flex gap-2 overflow-x-auto pb-3">
            {shop.tiers.slice(0, NFT_CHECKOUT_PREVIEW_PAGE_SIZE).map((tier) => {
              const qty = cart[tier.id] ?? 0;
              const soldOut = !tier.unlimited && tier.remaining === 0;
              const cap = tier.unlimited ? 99 : tier.remaining;
              const price = effectiveTierPrice(
                tier.price,
                tier.discountPercent,
              );
              const item = {
                tierId: tier.id,
                name: tier.name ?? undefined,
                image: tier.image ?? undefined,
              };
              return (
                <NftCheckoutCard key={tier.id} tierId={tier.id} name={tier.name ?? `Item #${tier.id}`} image={tier.image} qty={qty}
                  priceLabel={`${formatTokenAmount(price, shop.pricingDecimals)} ${shopPricingSymbol}`}
                  soldOut={soldOut} busy={busy} canAdd={qty < cap}
                  onSelect={() => setQuantity(tier.id, 1, item)} />
              );
            })}
          </div>
        </div>
      ) : shopCheckoutNotice ? (
        <div className="mb-3">{shopCheckoutNotice}</div>
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
            { value: "pay", label: nativeMarket ? "NFTs" : "Pay" },
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
            onChange={switchChain}
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
          Adds to the project balance. You get no {projectTokenLabel}.
        </p>
      ) : null}

      {/* Amount + token + pay, inline (website/ parity) */}
      <div className="mt-3">
        <CheckoutAmountRow amount={
          <input
            type="text"
            inputMode="decimal"
            // Dollars are shown with their sign and stored without it: everything downstream
            // — the preview, the amount sent to the provider — parses a number.
            value={amountIsDollars && amount ? `$${amount}` : amount}
            onChange={(e) => setAmount(e.target.value.replace(/^\$/, ""))}
            disabled={busy}
            placeholder={amountIsDollars ? "$0.00" : "0.00"}
            aria-label="Amount"
            className={CHECKOUT_AMOUNT_INPUT_CLASS}
          />
        } currency={<>
{!surface ? (
            // The unit is unknown until the project's tokens are read: no token is implied meanwhile.
            surfaceError ? null : <Skeleton className="h-4 w-10 rounded" role="status" aria-label="Loading payment tokens" />
          ) : contexts.length > 1 || onRamp.supported ? (
            // Valued by INDEX, not address — a token can appear direct and
            // via-router, so the option must stay in lock-step with the
            // selected context (website/ fund-loss fix).
            <TextSelect
              value={payWithDollars ? BUY_OPTION : String(tokenIndex)}
              onChange={(value) => {
                setTokenTouched(true);
                setDroppedToken(null);
                if (value === BUY_OPTION) {
                  // Selecting dollars buys nothing yet. The payer types what
                  // they want to spend first, and Pay explains the swap they
                  // are about to make.
                  setPayWithDollars(true);
                  return;
                }
                setPayWithDollars(false);
                const i = Number(value);
                setTokenIndex(i);
                // Remember the explicit pick so a refetch/chain-switch remaps
                // to this exact token instead of snapping back to list[0].
                const picked = contexts[i];
                if (picked) {
                  selectedKeyRef.current = payTokenKey(picked);
                  selectedSymbolRef.current = picked.symbol;
                }
                setTokenTouched(true);
              }}
              disabled={busy}
              ariaLabel="Payment token"
              className="relative flex shrink-0 items-center gap-1 text-sm font-medium text-smoke-700"
              labelClassName=""
              selectClassName="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
              options={[
                ...contexts.map((ctx, i) => ({
                  value: String(i),
                  label: ctx.symbol,
                  disabled:
                    cartCount > 0 && !shopRoutes?.[payTokenKey(ctx)]?.supported,
                })),
                // Names both rails without promising to pick one: Para's
                // on-ramp takes no payment method, so the provider's own
                // window asks. Saying both is still worth it — bank
                // transfers authorise far more often than cards, and nobody
                // reaches for one they did not know was offered.
                // Names both rails without promising to pick one: Para's
                // on-ramp takes no payment method, so the provider's own window
                // asks. Saying both is still worth it — bank transfers
                // authorise far more often than cards, and nobody reaches for
                // one they did not know was offered.
                ...(onRamp.supported
                  ? [{ value: BUY_OPTION, label: "Card or bank" }]
                  : []),
              ]}
            />
          ) : (
            <span className="flex shrink-0 items-center text-sm font-medium text-smoke-700">
              {symbol}
            </span>
          )}
            {/* Inside the field, under the token it refers to. */}
        </>} />
        <div className="mt-1.5 flex items-start">
          <div className="min-w-0 flex-1 pr-3">
            {pairCheck.line ? (
              <p role="alert" className="text-xs text-error-500">{pairCheck.line}</p>
            ) : null}
            {amountUsd !== null ? (
              <p className={`text-xs text-smoke-500 ${receiptPendingClass}`}>
                About {formatUsd18(amountUsd)}
              </p>
            ) : null}
            {notStarted ? (
              <p className="text-xs text-smoke-700">
                Starts in {formatStartCountdown(startsAt - now)}.
              </p>
            ) : null}
            {/* Not while paying by card: the shortfall is in a token this
                payer is not spending, and buying it is the very thing the
                button now offers. */}
            {insufficientBalance && !payWithDollars ? (
              <p className="text-xs text-error-500">
                You don&apos;t have enough {symbol} on {payChainName(chainId)}.
              </p>
            ) : null}
          </div>
          <div className="flex shrink-0 flex-col items-end gap-0.5">
            {/* Not while paying by card: that is a balance in a token this
                payer is not spending, on a row that is about to buy some. */}
            {isConnected && walletBalance !== undefined && !payWithDollars ? (
              <span className="text-xs text-smoke-700">
                Balance: {formatTokenAmount(walletBalance, decimals)}
              </span>
            ) : null}
          </div>
        </div>
        {/* What "$" costs, said where it is spent. A payer who picked dollars is one step from a
          purchase they did not ask for, so the swap is named before it starts rather than
          explained by the provider's window appearing. */}
      {buyExplainerOpen ? (
        <ModalShell
          title={`First, buy ${buyableLabel}`}
          maxWidth="max-w-md"
          onClose={() => setBuyExplainerOpen(false)}
        >
          <div>
            <p className="text-sm leading-relaxed text-smoke-700">
              {/* One string, not JSX text around an expression: a line break after `{asset}`
                  swallows the space that follows it, which is how this shipped as "USDCin". */}
              {`This project accepts ${buyableLabel}. Buy some with your card or bank, then return here to pay.`}
            </p>
            <div className="mt-5 flex justify-end">
              <button
                type="button"
                onClick={() => {
                  setBuyExplainerOpen(false);
                  // A window, not the frame this once used. Para's portal
                  // frames fine, but the provider it nests inside itself does
                  // not: buy.moonpay.com answers a framed request with "refused
                  // to connect", because MoonPay only permits embedding from
                  // origins registered against the merchant key — and that key
                  // is Para's.
                  //
                  // Everything needed to embed it is still here and tested
                  // (`display: "embed"`, `recordOnRampPurchase`). Ask Para to
                  // allowlist this origin on their MoonPay key and this call is
                  // one argument from being a frame again.
                  onRamp.buy({ fiatQuantity: amount.trim() || undefined });
                }}
                className="btn-primary h-10 px-5 text-sm"
              >
                Buy {buyableLabel}
              </button>
            </div>
          </div>
        </ModalShell>
      ) : null}
      {showReceipt ? (
          <div className="mt-3">
            <p className="text-xs text-smoke-500">{receiptIsEstimate ? "You get about" : "You get"}</p>
            {receipt && receipt.preview.beneficiaryTokenCount > 0n ? (
              <p
                aria-live="polite"
                aria-busy={receiptPending}
                className={`font-agrandir text-xl font-medium text-ink transition-opacity duration-200 ${receiptPendingClass}`}
              >
                {formatTokenAmount(receipt.preview.beneficiaryTokenCount, 18)}{" "}
                {projectTokenLabel}
              </p>
            ) : (
              <Skeleton
                className="mt-1 h-7 w-28 rounded"
                role="status"
                aria-label="Calculating token return"
              />
            )}
            {amountIsDollars ? (
              <p className={`text-xs text-smoke-500 ${receiptPendingClass}`}>Before card or bank fees</p>
            ) : receiptIsEstimate && prepared ? (
              <p className={`text-xs text-smoke-500 ${receiptPendingClass}`}>
                At least {formatTokenAmount(prepared.minReturnedTokens, 18)} {projectTokenLabel}
              </p>
            ) : null}
            {receipt && receipt.preview.reservedTokenCount > 0n ? (
              <p className={`mt-1 text-xs text-smoke-500 ${receiptPendingClass}`}>
                Other recipients get {formatTokenAmount(receipt.preview.reservedTokenCount, 18)}{" "}
                {projectTokenLabel}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      {mode === "pay" && cartCount > 0 && shopCreditsFailed ? (
        <p role="alert" className="mt-4 text-sm text-red-600">
          Couldn&apos;t read your shop credit.{" "}
          <button
            type="button"
            onClick={() => void refetchShopCredits()}
            className="font-medium underline underline-offset-2"
          >
            Try again
          </button>
        </p>
      ) : null}
      {/* Selected shop items share the payment receipt shown above. */}
      {mode === "pay" && cartCount > 0 && shopFailed ? (
        <p role="alert" className="mt-4 text-sm text-red-600">
          Couldn&apos;t read this project&apos;s shop.{" "}
          <button
            type="button"
            onClick={() => void inventory.refetch()}
            className="font-medium underline underline-offset-2"
          >
            Try again
          </button>
        </p>
      ) : mode === "pay" && cartCount > 0 && !shop && shopPending ? (
        <Skeleton className="mt-4 h-16 w-full rounded-lg" role="status" aria-label="Loading your items" />
      ) : mode === "pay" && cartCount > 0 && shop ? (
        <div className="mt-4">
          {selectedCartRows.length > 0 ? (
            <div className="mt-2 space-y-2 border-y border-smoke-200 py-2.5">
              {selectedCartRows.map((row) => (
                <NftCartLine key={row.tierId} tierId={row.tierId} name={row.name} image={row.image} quantity={row.quantity}
                  onRemove={() => setQuantity(row.tierId, row.quantity - 1)}
                  onAdd={() => setQuantity(row.tierId, Math.min(row.cap, row.quantity + 1))}
                  removeDisabled={busy} addDisabled={busy || row.quantity >= row.cap} />
              ))}
              <div className="space-y-2 border-t border-smoke-200 pt-2 text-xs">
                {cartAmountDue !== cartTotal ? (
                  <div>
                    <span className="block text-smoke-500">
                      {cartCount} item{cartCount === 1 ? "" : "s"}
                    </span>
                    <span className="block text-sm tabular-nums text-ink">
                      {formatTokenAmount(cartTotal, shop?.pricingDecimals ?? 18)}{" "}
                      {shopPricingSymbol}
                    </span>
                  </div>
                ) : null}
                {!shopCreditsLoading && shopCreditApplied > 0n ? (
                  <div>
                    <span className="block text-smoke-500">Shop credit applied</span>
                    <span className="block text-sm tabular-nums text-emerald-700">
                      −
                      {formatTokenAmount(
                        shopCreditApplied,
                        shop?.pricingDecimals ?? 18,
                      )}{" "}
                      {shopPricingSymbol}
                    </span>
                  </div>
                ) : !shopCreditsLoading && shopCredits > 0n ? (
                  <div>
                    <span className="block text-smoke-500">Shop credit available</span>
                    <span className="block text-sm tabular-nums text-ink">
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
                    <div>
                      <span className="block text-smoke-500">
                        {restrictedCartTotal === cartTotal
                          ? 'These items require fresh payment'
                          : 'Some items require fresh payment'}
                      </span>
                      <span className="block text-sm tabular-nums text-ink">
                        {formatTokenAmount(
                          restrictedCartTotal,
                          shop?.pricingDecimals ?? 18,
                        )}{" "}
                        {shopPricingSymbol}
                      </span>
                    </div>
                ) : null}
                <div>
                  <span className="block text-smoke-500">Amount due</span>
                  <span className="block text-sm font-medium tabular-nums text-ink">
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

        </div>
      ) : null}

      {mode === "pay" && !amountIsDollars && amountRaw > 0n && previewFailure instanceof PaySwapQuoteFailedError ? (
        <p className="mt-2 text-sm text-smoke-700" aria-live="polite">
          {quoteRetryFor === paymentInputs ? "Refreshing…" : (
            <>
              {PAY_SWAP_QUOTE_FAILED_MESSAGE}{" "}
              <button
                type="button"
                onClick={retryQuote}
                className="font-medium underline underline-offset-2"
              >
                Retry
              </button>
            </>
          )}
        </p>
      ) : mode === "pay" && !amountIsDollars && amountRaw > 0n && previewError ? (
        <p className="mt-2 text-sm text-red-600">
          Couldn&apos;t verify what this payment returns — paying is disabled
          until the preview works.{" "}
          <button
            type="button"
            onClick={() => void refetchPreview()}
            disabled={previewLoading}
            className="font-medium underline underline-offset-2"
          >
            Try again
          </button>
        </p>
      ) : null}

      {/* Only while it can still change this payment: not beside an error a retry can't fix, nor once it is sent. */}
      {/* The quote must be the one for what is typed now, not a previous amount's. */}
      {mode === "pay" && amountRaw > 0n && amount === debouncedAmount && !payWithDollars &&
      !previewError && !previewIsPrevious && prepared?.quoteFailed &&
      !formClosed && !panelTxError && !busy && !sequenceOpen ? (
        <p className="mt-2 text-sm text-smoke-700" aria-live="polite">
          {quoteRetryFor === paymentInputs ? "Refreshing…" : (
            <>
              {PAY_QUOTE_FAILED_MESSAGE}{" "}
              <button
                type="button"
                onClick={retryQuote}
                className="font-medium underline underline-offset-2"
              >
                Try again
              </button>
            </>
          )}
        </p>
      ) : null}

      {/* The note and the action follow the full receipt: tokens, shop items, and splits. */}
      <div className="mt-3 flex items-stretch gap-2">
        <input
          type="text"
          value={memo}
          onChange={(e) => setMemo(e.target.value.slice(0, 256))}
          disabled={busy}
          placeholder="Add a public note"
          aria-label="Note"
          className="input-well min-h-[44px] min-w-0 flex-1 px-3.5 text-sm disabled:opacity-60"
        />
        <button
            onClick={submit}
            // Warm what the click opens on approach, so it never waits for a download:
            // the review when connected, Para's runtime when this reads "Sign in".
            onPointerEnter={isConnected ? preloadReview : preloadParaHost}
            onFocus={isConnected ? preloadReview : preloadParaHost}
            onPointerDown={isConnected ? preloadReview : preloadParaHost}
            onTouchStart={isConnected ? undefined : preloadParaHost}
            disabled={
              formBlocked ||
              (isConnected && cartBlocked) ||
              // Paying in dollars is a purchase, not a send: it needs an
              // amount and nothing else. The checks below are about a token
              // this payer does not hold yet.
              (isConnected &&
                !payWithDollars &&
                ((amountRaw <= 0n &&
                  !(mode === "pay" && cartCount > 0 && cartAmountDue === 0n)) ||
                  (mode === "pay" && !previewReady))) ||
              (isConnected && payWithDollars && amount.trim() === "")
            }
            className="btn-primary min-h-[44px] shrink-0 px-5 text-sm disabled:opacity-60"
          >
            {payActionLabel}
          </button>
      </div>

      {droppedToken ? (
        <p className="mt-3 text-sm text-smoke-700" role="status">
          {droppedToken} isn&apos;t accepted on {chainName(chainId)}.
        </p>
      ) : null}
      {otherChainCart && mode === "pay" ? (
        <p className="mt-3 text-sm text-smoke-700" role="status">
          {otherChainCart.count} item{otherChainCart.count === 1 ? "" : "s"} in your{" "}
          {chainName(otherChainCart.chainId)} cart.{" "}
          <button
            type="button"
            disabled={busy}
            onClick={() => switchChain(String(otherChainCart.chainId))}
            className="font-medium underline underline-offset-2"
          >
            Switch
          </button>
        </p>
      ) : null}
      {payDetailsFailed && !payDetailsRetrying ? (
        <p role="alert" className="mt-3 text-sm text-red-600">
          Couldn&apos;t load this project&apos;s payment details.{" "}
          <button
            type="button"
            onClick={retryPayDetails}
            className="font-medium underline underline-offset-2"
          >
            Retry
          </button>
        </p>
      ) : null}
      {surface?.pausePay && mode === "pay" ? (
        <p className="mt-3 text-sm text-smoke-700">
          Payments are paused under the current rules.
        </p>
      ) : null}
      {addBalanceViaRouter ? (
        <p className="mt-3 text-sm text-smoke-700">
          Add to balance can&apos;t convert this token. Pick another, or use Pay.
        </p>
      ) : null}
      {terminalBlocked ? (
        <p className="mt-3 text-sm text-red-600">
          This project hasn&apos;t approved the selected payment contract on{" "}
          {chainName(chainId)}. Review the project contracts before paying.
        </p>
      ) : null}
      {!terminalBlocked && surface?.unknown && surface.unknown.length > 0 ? (
        <p className="mt-3 text-xs leading-relaxed text-smoke-700">
          This app doesn&apos;t recognize some of this project&apos;s payment contracts:{" "}
          {surface.unknown
            .map((a) => `${a.slice(0, 6)}…${a.slice(-4)}`)
            .join(", ")}
          . Payments here only go to recognized ones.
        </p>
      ) : null}
      {panelTxError ? (
        <p className="mt-3 text-sm text-red-600">
          {panelTxError}
        </p>
      ) : null}
      {/* A Safe stage outlives its dialog: its line stays until it ends or is dismissed. */}
      {sequenceSafeStage && !sequenceOpen ? (
        <div className="mt-3 flex items-start justify-between gap-3">
          <p className="text-sm text-smoke-700">
            {sequenceSafeHeld ?? sequenceSafeNotice ??
              (sequenceSafeLost ? SAFE_PROPOSAL_UNCONFIRMED : "Submitted. Confirming onchain…")}
          </p>
          {sequenceSafeReleasable ? (
            <button
              type="button"
              onClick={dismissSequenceSafeStage}
              className="shrink-0 text-xs font-medium text-bluebs-600 hover:underline"
            >
              Dismiss
            </button>
          ) : null}
        </div>
      ) : null}
      {sequenceOpen ? (
        <TxProgress
          open
          eyebrow={null}
          title={
            sequenceComplete
              ? mode === "pay"
                ? "Payment confirmed"
                : "Added to the balance"
              : mode === "pay"
                ? "Confirm payment"
                : "Confirm add to balance"
          }
          rows={sequenceRows}
          steps={sequenceActions.map(action => ({
            key: `${action.kind}:${action.label}`,
            title: action.label,
          }))}
          activeIndex={Math.max(
            run.steps === sequenceActions ? run.index : 0,
            sequenceActions.filter(action =>
              sequenceCompletedKinds.includes(action.kind),
            ).length,
          )}
          status={sequenceSafeNotice ?? sequenceStatus}
          error={sequenceError ?? sequenceSafeHeld ?? endedLine}
          busy={paymentSequenceLocked(sequenceStarted, sequencePending)}
          complete={sequenceComplete || !!sequenceSafeStage}
          start={sequenceError ? undefined : () => void runPaymentSequence()}
          next={
            retryBps !== null || reviewAfterRevert
              ? { label: "Review again", onClick: () => reviewAgain(retryBps) }
              : !sequenceComplete && !sequenceSafeStage && !sequencePending && !sequenceStarted && sequenceActions.length &&
                  (endedLine || sequenceError || sequenceCompletedKinds.length)
                ? { label: endedLine || sequenceError ? "Try again" : "Continue", onClick: () => void runPaymentSequence() }
                : null
          }
          onClose={() => {
            // A payment its hold is following closes as held: only the wait ends, and Pay stays locked.
            if (paymentSequenceLocked(sequenceStarted, sequencePending) && !tx.dismiss()) return;
            // An unproven or lost Safe stage ends with its line: Done dismisses it,
            // so its call is the user's again and the panel is free.
            if (sequenceSafeReleasable) dismissSequenceSafeStage();
            dispatchSequence({ type: "closed" });
            setRetrySlippageBps(null);
            setPayerSlippage(null);
          }}
        >
          {retryBps !== null ? (
            <AllowedDecreaseField bps={retryBps} onChange={setRetrySlippageBps} maxBps={Number(PAY_MAX_SLIPPAGE_BPS)} />
          ) : null}
        </TxProgress>
      ) : null}
    </div>
  );
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
