"use client";

import {
  JBCoreContracts,
  SPLITS_TOTAL_PERCENT,
  jbContractAddress,
  jbControllerAbi,
  jbDirectoryAbi,
  jbFundAccessLimitsAbi,
  jbProjectsAbi,
  jbSplitsAbi,
  type JBChainId,
} from "@bananapus/nana-sdk-core";
import {
  JBPermissionIdsV6,
  RESERVED_TOKEN_SPLIT_GROUP_ID,
  build721RulesetMetadata,
  decode721RulesetMetadata,
  getAccountingContexts,
  getCurrentRuleset,
  getUpcomingRuleset,
  hasPermissions,
  payoutSplitGroupId,
  v6Address,
  type JBAccountingContext,
  type JBRulesetConfig,
} from "@bananapus/nana-sdk-core/v6";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import {
  formatUnits,
  parseEther,
  parseUnits,
  type Address,
  type PublicClient,
} from "viem";
import { usePublicClient, useReadContract } from "wagmi";
import { TxError } from "@/components/ui/TxError";
import { FormCardSkeleton } from "@/components/LoadingSkeletons";
import { useWallet } from "@/hooks/useWallet";
import { useViewedAccount } from "@/hooks/useViewedAccount";
import { runAuthorityCalls, safeOutcomeMessage } from "@/lib/authority";
import {
  billionthsToPct,
  etherscanTxUrl,
  formatDuration,
  toLocalDateTimeInput,
} from "@/lib/format";
import { fetchSafeInfo } from "@/lib/safe";
import type { RawSplit } from "@/lib/splits-types";
import { tokenSymbol } from "@/lib/token-symbol";
import { buildQueueRulesetsAuthorityCall } from "@/lib/transaction-builders";
import {
  approvalStatusLabel,
  planRulesetQueue,
  type QueueAction,
  type QueueActionOption,
  type RulesetQueuePlan,
} from "@/lib/ruleset-queue";
import { ConceptTerm } from "@/components/project/ConceptTerm";
import { PROTOCOL_CONCEPTS } from "@/lib/protocol-concepts";
import { DateTimeField } from "@/components/ui/DateTimeField";

/** Payout amounts at/above this are treated as "no limit" (unlimited). */
const UNLIMITED_FLOOR = 2n ** 200n;
/** The value queued for an unlimited payout limit (uint224 max). */
const UNLIMITED_PAYOUT = 2n ** 224n - 1n;
/** ETH base currency id. */
const BASE_ETH = 1;
const BASE_USD = 2;
/** uint16 max — the ceiling for reservedPercent / cashOutTaxRate. */
const PERCENT_OUT_OF_10000_MAX = 10_000;

type CurrencyAmount = { amount: bigint; currency: number };

/** One accounting token with its live payout limit / surplus allowance. */
type TokenAccess = {
  ctx: JBAccountingContext;
  symbol: string;
  payoutLimits: readonly CurrencyAmount[];
  surplusAllowances: readonly CurrencyAmount[];
};

/** How the owner wants each token's payout limit set going forward. */
type LimitDraft = {
  token: Address;
  symbol: string;
  /** Payout limits in additional currencies that this one-value-per-token editor can't model. */
  unrepresentableLimits?: readonly CurrencyAmount[];
  decimals: number;
  /** The currency the limit is denominated in (carried from current). */
  currency: number;
  mode: "unlimited" | "limited" | "none";
  /** Human-readable amount (in `decimals`) when mode === 'limited'. */
  amount: string;
  /** Surplus allowances carried forward untouched. */
  surplusAllowances: readonly CurrencyAmount[];
};

/** The editable rule fields, all as strings/bools for form binding. */
type EditorState = {
  /** Cycle length in seconds; 0 = no expiry. */
  duration: number;
  /** Tokens issued per base unit, in human 18-dec terms. */
  weight: string;
  /** Issuance cut per cycle, as a 0-100 percent string. */
  weightCutPct: string;
  /** Reserved share, as a 0-100 percent string. */
  reservedPct: string;
  /** Cash-out tax, as a 0-100 percent string. */
  cashOutTaxPct: string;
  pausePay: boolean;
  pauseCreditTransfers: boolean;
  pause721Transfers: boolean;
  holdFees: boolean;
  ownerMustSendPayouts: boolean;
  allowOwnerMinting: boolean;
  allowSetTerminals: boolean;
  allowSetController: boolean;
  allowTerminalMigration: boolean;
  allowSetCustomToken: boolean;
  allowAddAccountingContext: boolean;
  allowAddPriceFeed: boolean;
  limits: LimitDraft[];
};

const DURATION_PRESETS: { label: string; seconds: number }[] = [
  { label: "No expiry", seconds: 0 },
  { label: "1 day", seconds: 86_400 },
  { label: "3 days", seconds: 259_200 },
  { label: "7 days", seconds: 604_800 },
  { label: "14 days", seconds: 1_209_600 },
  { label: "28 days", seconds: 2_419_200 },
];

/** basis-points-of-10000 → a trimmed 0-100 percent string. */
function bpToPct(bp: number): string {
  return String(Number((bp / 100).toFixed(2)));
}
/** 0-100 percent string → 1e9-scaled integer, clamped. */
function pctTo1e9(pct: string): number {
  const n = Number(pct);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(SPLITS_TOTAL_PERCENT, Math.round((n / 100) * 1e9));
}
/** 0-100 percent string → basis-points-of-10000 integer, clamped. 0 (or a
 *  blank field) is a valid share — queuing 0% reserved turns reserving off. */
export function pctToBp(pct: string): number {
  const n = Number(pct);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(PERCENT_OUT_OF_10000_MAX, Math.round(n * 100));
}

/**
 * What a fund-access limit is DENOMINATED in. The base currencies (JBCurrencyIds:
 * ETH = 1, USD = 2) name a unit of account, not a token; any other id is the
 * accounting context's own `uint32(tokenAddress)`, which the token's symbol names.
 * Falling through on USD labels a USD-denominated limit with the accounting token
 * ("100 ETH" for a $100 limit) on a config that becomes immutable once queued.
 */
export function currencyLabel(currency: number, symbol: string): string {
  if (currency === BASE_ETH) return "ETH";
  if (currency === BASE_USD) return "USD";
  return symbol;
}

/**
 * Who can queue rules, and through whom. Returns the AUTHORITY the queue call
 * routes through (the account `runAuthorityCalls` simulates and sends as):
 * the owner itself when the connected wallet IS the owner or signs for the
 * owning Safe (the Safe path proposes the exact call through that Safe), the
 * wallet when it holds QUEUE_RULESETS from the owner, and null for everyone
 * else — including while the owner/Safe/permission reads are still pending,
 * so the editor stays hidden rather than flashing for non-editors.
 */
export function queueRulesetAuthority({
  address,
  owner,
  safeSigners,
  hasQueuePermission,
}: {
  address: Address | undefined;
  owner: Address | undefined;
  /** The owning Safe's signers; undefined/empty when the owner is not a Safe. */
  safeSigners: readonly Address[] | undefined;
  hasQueuePermission: boolean | undefined;
}): Address | null {
  if (!address || !owner) return null;
  if (owner.toLowerCase() === address.toLowerCase()) return owner;
  if (
    safeSigners?.some(
      (signer) => signer.toLowerCase() === address.toLowerCase(),
    )
  ) {
    return owner;
  }
  if (hasQueuePermission === true) return address;
  return null;
}

/**
 * Queue new rules for a CUSTOM project (website/ parity: the owner's
 * ruleset editor). Renders nothing for revnets (their stages are fixed) and
 * nothing unless the connected wallet can queue — as the on-chain owner, as
 * a signer of the owning Safe, or as a QUEUE_RULESETS operator — and the
 * project's controller is one jbm can drive.
 *
 * The current, next queued, and queue-tail rulesets are read live with their
 * approval status. The owner chooses whether to replace a still-replaceable
 * queued configuration or append after its final tail; metadata, fund access,
 * and splits are prefilled from that exact source. Editing builds ONE
 * JBRulesetConfig that carries everything untouched and only changes what the
 * owner edited. A diff of just the changed rows is shown before sending
 * `queueRulesetsOf` to the resolved controller through the simulation-first
 * Safe/Relayr authority router (runAuthorityCalls, like EditSplitsFlow).
 */
export function QueueRulesetFlow({
  chainId,
  projectId,
  isRevnet,
}: {
  chainId: JBChainId;
  projectId: number;
  isRevnet: boolean;
}) {
  const publicClient = usePublicClient({ chainId }) as PublicClient | undefined;
  const { address } = useViewedAccount();

  const { data: owner } = useReadContract({
    abi: jbProjectsAbi,
    address: jbContractAddress["6"][JBCoreContracts.JBProjects][chainId],
    functionName: "ownerOf",
    args: [BigInt(projectId)],
    chainId,
    query: { enabled: !isRevnet, staleTime: 60_000 },
  });

  const isOwner =
    !!address && !!owner && owner.toLowerCase() === address.toLowerCase();

  // The owner may be a Safe: any of its signers can queue THROUGH the Safe
  // (runAuthorityCalls proposes the exact call there, like EditSplitsFlow).
  const { data: ownerSafe } = useQuery({
    queryKey: ["queueRulesetOwnerSafe", chainId, owner, address],
    enabled: !isRevnet && !!owner && !!address && !isOwner,
    staleTime: 30_000,
    queryFn: () => fetchSafeInfo(chainId, owner as Address),
  });
  const isOwnerSafeSigner =
    !!address &&
    !!ownerSafe?.owners.some(
      (signer) => signer.toLowerCase() === address.toLowerCase(),
    );

  // Or the wallet holds QUEUE_RULESETS granted from the owner — the same
  // permission JBController's queueRulesetsOf checks onchain.
  const { data: canOperate } = useQuery({
    queryKey: ["queueRulesetPerm", chainId, projectId, address, owner],
    enabled:
      !isRevnet &&
      !!address &&
      !!owner &&
      !isOwner &&
      !isOwnerSafeSigner &&
      !!publicClient,
    staleTime: 60_000,
    queryFn: () =>
      hasPermissions(publicClient!, {
        chainId,
        operator: address!,
        account: owner!,
        projectId: BigInt(projectId),
        permissionIds: [JBPermissionIdsV6.QUEUE_RULESETS],
      }),
  });

  const authority = queueRulesetAuthority({
    address: address as Address | undefined,
    owner: owner as Address | undefined,
    safeSigners: ownerSafe?.owners,
    hasQueuePermission: canOperate,
  });
  const canEdit = authority !== null;

  const { data: controller } = useReadContract({
    abi: jbDirectoryAbi,
    address: jbContractAddress["6"][JBCoreContracts.JBDirectory][chainId],
    functionName: "controllerOf",
    args: [BigInt(projectId)],
    chainId,
    query: { enabled: canEdit, staleTime: 60_000 },
  });

  const canonicalController = jbContractAddress["6"][
    JBCoreContracts.JBController
  ][chainId] as Address | undefined;
  const knownController =
    !!controller &&
    !!canonicalController &&
    controller.toLowerCase() === canonicalController.toLowerCase();

  // Load everything the editor prefills from, once we know the wallet can
  // queue for the project (avoid the reads for everyone else).
  const { data, isLoading, isError } = useQuery({
    queryKey: ["queueRulesetPrefill", chainId, projectId, controller],
    enabled: !isRevnet && canEdit && !!publicClient && knownController,
    staleTime: 30_000,
    retry: 1,
    queryFn: async () => {
      const pid = BigInt(projectId);
      const limitsAddr = v6Address("JBFundAccessLimits", chainId);
      const splitsAddr = v6Address("JBSplits", chainId);
      const terminal = v6Address("JBMultiTerminal", chainId);

      const [current, upcomingRead, latestRead, contexts] = await Promise.all([
        getCurrentRuleset(publicClient!, { chainId, projectId: pid }),
        getUpcomingRuleset(publicClient!, { chainId, projectId: pid }).catch(
          () => null,
        ),
        publicClient!.readContract({
          address: controller as Address,
          abi: jbControllerAbi,
          functionName: "latestQueuedRulesetOf",
          args: [pid],
        }),
        getAccountingContexts(publicClient!, { chainId, projectId: pid }).catch(
          () => [] as JBAccountingContext[],
        ),
      ]);
      const latest = { ruleset: latestRead[0], metadata: latestRead[1] };
      const latestApprovalStatus = Number(latestRead[2]);
      const upcoming =
        upcomingRead &&
        BigInt(upcomingRead.ruleset.id) !== 0n &&
        BigInt(upcomingRead.ruleset.id) !== BigInt(current.ruleset.id)
          ? upcomingRead
          : null;

      const plan = planRulesetQueue({
        current: current.ruleset,
        upcoming: upcoming?.ruleset ?? null,
        latest: latest.ruleset,
        latestApprovalStatus,
      });

      const entryFor = (option: QueueActionOption) => {
        const id = BigInt(option.source.id);
        if (id === BigInt(current.ruleset.id)) return current;
        if (upcoming && id === BigInt(upcoming.ruleset.id)) return upcoming;
        if (id === BigInt(latest.ruleset.id)) return latest;
        throw new Error("The queued ruleset source could not be resolved.");
      };

      const readSource = async (option: QueueActionOption): Promise<PrefillSource> => {
        const entry = entryFor(option);
        const rid = BigInt(entry.ruleset.id);
        const access: TokenAccess[] = await Promise.all(
          contexts.map(async (ctx) => {
            const [payoutLimits, surplusAllowances, symbol] = await Promise.all([
              publicClient!.readContract({
                address: limitsAddr,
                abi: jbFundAccessLimitsAbi,
                functionName: "payoutLimitsOf",
                args: [pid, rid, terminal, ctx.token],
              }) as Promise<readonly CurrencyAmount[]>,
              publicClient!.readContract({
                address: limitsAddr,
                abi: jbFundAccessLimitsAbi,
                functionName: "surplusAllowancesOf",
                args: [pid, rid, terminal, ctx.token],
              }) as Promise<readonly CurrencyAmount[]>,
              tokenSymbol(publicClient!, ctx.token, { chainId }),
            ]);
            return { ctx, symbol, payoutLimits, surplusAllowances };
          }),
        );
        const reservedSplits = (await publicClient!.readContract({
          address: splitsAddr,
          abi: jbSplitsAbi,
          functionName: "splitsOf",
          args: [pid, rid, RESERVED_TOKEN_SPLIT_GROUP_ID],
        })) as readonly RawSplit[];
        const payoutSplits = await Promise.all(
          contexts.map(
            (ctx) =>
              publicClient!.readContract({
                address: splitsAddr,
                abi: jbSplitsAbi,
                functionName: "splitsOf",
                args: [pid, rid, payoutSplitGroupId(ctx.token)],
              }) as Promise<readonly RawSplit[]>,
          ),
        );
        return {
          action: option.action,
          option,
          entry,
          rulesetId: rid,
          terminal,
          access,
          reservedSplits,
          payoutSplits: contexts.map((ctx, i) => ({
            token: ctx.token as Address,
            splits: payoutSplits[i],
          })),
        };
      };

      const sourceEntries = await Promise.all(plan.options.map(readSource));
      return {
        current,
        upcoming,
        latest,
        latestApprovalStatus,
        plan,
        sources: Object.fromEntries(
          sourceEntries.map((source) => [source.action, source]),
        ) as Partial<Record<QueueAction, PrefillSource>>,
      };
    },
  });

  if (isRevnet || !canEdit || controller === undefined) return null;

  if (!knownController) {
    return (
      <div className="card p-5">
        <span className="field-label">Edit rules</span>
        <p className="mt-2 text-sm leading-relaxed text-smoke-700">
          This project queues rules through a wrapper jbm doesn&apos;t drive
          yet, so rules can&apos;t be edited here. Use the tool that deployed
          it.
        </p>
      </div>
    );
  }

  if (isLoading) {
    return <FormCardSkeleton label="Loading ruleset editor" />;
  }

  if (isError || !data) {
    return (
      <div className="card p-5">
        <span className="field-label">Edit rules</span>
        <p className="mt-2 text-sm text-smoke-700">
          Couldn&apos;t load this project&apos;s current rules right now.
        </p>
      </div>
    );
  }

  return (
    <RulesetEditor
      chainId={chainId}
      projectId={projectId}
      controller={controller as Address}
      authority={authority}
      data={data}
      publicClient={publicClient!}
    />
  );
}

type RulesetEntry = Awaited<ReturnType<typeof getCurrentRuleset>>;

/** One fully verified ruleset configuration the editor can carry forward. */
type PrefillSource = {
  action: QueueAction;
  option: QueueActionOption;
  entry: RulesetEntry;
  rulesetId: bigint;
  terminal: Address;
  access: TokenAccess[];
  reservedSplits: readonly RawSplit[];
  payoutSplits: { token: Address; splits: readonly RawSplit[] }[];
};

/** The live queue and every safe source the owner may choose between. */
type PrefillData = {
  current: RulesetEntry;
  upcoming: RulesetEntry | null;
  latest: RulesetEntry;
  latestApprovalStatus: number;
  plan: RulesetQueuePlan;
  sources: Partial<Record<QueueAction, PrefillSource>>;
};

/** A reviewed, ready-to-send queue: the exact config is frozen so what the
 *  owner confirms is what's sent. */
type Reviewed = {
  config: JBRulesetConfig;
  account: Address;
  /** Whether the new config removes all payout limits. */
  clearsPayouts: boolean;
};

function RulesetEditor(props: {
  chainId: JBChainId;
  projectId: number;
  controller: Address;
  authority: Address;
  data: PrefillData;
  publicClient: PublicClient;
}) {
  const [action, setAction] = useState<QueueAction>(
    props.data.plan.defaultAction,
  );
  const source = props.data.sources[action];
  if (!source) {
    return (
      <div className="card p-5">
        <span className="field-label">Edit rules</span>
        <p className="mt-2 text-sm leading-relaxed text-smoke-700">
          The queued ruleset&apos;s approval hook does not currently permit a
          safe replacement or a following configuration. Try again after its
          approval status changes.
        </p>
      </div>
    );
  }

  return (
    <RulesetEditorForm
      key={`${action}:${source.rulesetId}`}
      {...props}
      action={action}
      source={source}
      onActionChange={setAction}
    />
  );
}

function RulesetEditorForm({
  chainId,
  projectId,
  controller,
  authority,
  data,
  action,
  source,
  onActionChange,
  publicClient,
}: {
  chainId: JBChainId;
  projectId: number;
  controller: Address;
  /** The account the queue call routes through: the owner (possibly a Safe
   *  the connected wallet signs for) or a QUEUE_RULESETS operator. */
  authority: Address;
  data: PrefillData;
  action: QueueAction;
  source: PrefillSource;
  onActionChange: (action: QueueAction) => void;
  publicClient: PublicClient;
}) {
  const { isConnected, address, openSignIn } = useWallet();

  const { terminal, access, reservedSplits, payoutSplits } = source;
  const r = source.entry.ruleset;
  const m = source.entry.metadata;

  const baseline: EditorState = useMemo(
    () => ({
      duration: r.duration,
      weight: formatUnits(r.weight, 18),
      weightCutPct: billionthsToPct(r.weightCutPercent, 4),
      reservedPct: bpToPct(m.reservedPercent),
      cashOutTaxPct: bpToPct(m.cashOutTaxRate),
      pausePay: m.pausePay,
      pauseCreditTransfers: m.pauseCreditTransfers,
      pause721Transfers: decode721RulesetMetadata(
        Number(m.metadata ?? 0),
      ).pauseTransfers,
      holdFees: m.holdFees,
      ownerMustSendPayouts: m.ownerMustSendPayouts,
      allowOwnerMinting: m.allowOwnerMinting,
      allowSetTerminals: m.allowSetTerminals,
      allowSetController: m.allowSetController,
      allowTerminalMigration: m.allowTerminalMigration,
      allowSetCustomToken: m.allowSetCustomToken,
      allowAddAccountingContext: m.allowAddAccountingContext,
      allowAddPriceFeed: m.allowAddPriceFeed,
      limits: access.map((a) => limitDraftFrom(a)),
    }),
    [r, m, access],
  );

  const [state, setState] = useState<EditorState>(baseline);
  const [review, setReview] = useState<Reviewed | null>(null);
  const [flowError, setFlowError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [txHash, setTxHash] = useState<`0x${string}` | null>(null);
  const [scheduledStart, setScheduledStart] = useState("");

  const set = <K extends keyof EditorState>(key: K, value: EditorState[K]) => {
    setState((s) => ({ ...s, [key]: value }));
    setReview(null);
    setFlowError(null);
  };
  const setLimit = (i: number, patch: Partial<LimitDraft>) => {
    setState((s) => ({
      ...s,
      limits: s.limits.map((l, j) => (j === i ? { ...l, ...patch } : l)),
    }));
    setReview(null);
    setFlowError(null);
  };

  const txUrl = txHash ? etherscanTxUrl(chainId, txHash) : null;

  // Which rows changed (old → new), for the confirm diff.
  const changes = useMemo(() => diffRows(baseline, state), [baseline, state]);
  const weightValid = (() => {
    const n = Number(state.weight);
    if (state.weight.trim() === "" || !Number.isFinite(n) || n < 0) return false;
    // A weight of exactly 1 wei collides with the JBRulesets inherit sentinel: raw `1` means
    // "inherit the previous ruleset's decayed weight" (JBRulesets.sol:822-823), not "one
    // attowei of issuance". Typing 0.000000000000000001 would therefore queue a completely
    // different — and immutable — encoding from the one shown.
    try {
      if (parseEther(state.weight.trim()) === 1n) return false;
    } catch {
      return false;
    }
    return true;
  })();
  const limitsValid = state.limits.every(
    (l) => l.mode !== "limited" || Number(l.amount) > 0,
  );
  const limitBlock = multiCurrencyLimitBlock(state.limits);
  const minimumScheduledStart = Math.max(
    Math.floor(Date.now() / 1000) + 60,
    Number(source.entry.ruleset.start) + 1,
  );
  const scheduledStartSeconds = scheduledStart
    ? Math.floor(new Date(scheduledStart).getTime() / 1000)
    : 0;
  const startValid =
    !source.option.requiresStartDate ||
    (Number.isFinite(scheduledStartSeconds) &&
      scheduledStartSeconds >= minimumScheduledStart);

  const mustStartAtOrAfter = source.option.requiresStartDate
    ? scheduledStartSeconds
    : (source.option.mustStartAtOrAfter ?? 0);

  const buildConfig = (): JBRulesetConfig => {
    const fundAccessLimitGroups = state.limits
      .map((l) => ({
        terminal,
        token: l.token,
        payoutLimits:
          l.mode === "none"
            ? []
            : [
                {
                  amount:
                    l.mode === "unlimited"
                      ? UNLIMITED_PAYOUT
                      : parseUnits(l.amount.trim() || "0", l.decimals),
                  currency: l.currency,
                },
              ],
        surplusAllowances: l.surplusAllowances.map((s) => ({
          amount: s.amount,
          currency: s.currency,
        })),
      }))
      // Drop groups that grant nothing — an empty fundAccessLimitGroups means
      // ZERO payouts, which the diff surfaces loudly.
      .filter(
        (g) => g.payoutLimits.length > 0 || g.surplusAllowances.length > 0,
      );

    const splitGroups = [
      ...(reservedSplits.length > 0
        ? [{ groupId: RESERVED_TOKEN_SPLIT_GROUP_ID, splits: reservedSplits }]
        : []),
      ...payoutSplits
        .filter((p) => p.splits.length > 0)
        .map((p) => ({
          groupId: payoutSplitGroupId(p.token),
          splits: p.splits,
        })),
    ];

    return {
      mustStartAtOrAfter,
      duration: state.duration,
      weight: parseUnits(state.weight.trim() || "0", 18),
      weightCutPercent: pctTo1e9(state.weightCutPct),
      // Keep the selected source's approval hook so its future rule-change
      // condition carries forward unchanged.
      approvalHook: r.approvalHook,
      metadata: {
        ...m,
        reservedPercent: pctToBp(state.reservedPct),
        cashOutTaxRate: pctToBp(state.cashOutTaxPct),
        pausePay: state.pausePay,
        pauseCreditTransfers: state.pauseCreditTransfers,
        metadata: build721RulesetMetadata({
          metadata: Number(m.metadata ?? 0),
          pauseTransfers: state.pause721Transfers,
        }),
        holdFees: state.holdFees,
        ownerMustSendPayouts: state.ownerMustSendPayouts,
        allowOwnerMinting: state.allowOwnerMinting,
        allowSetTerminals: state.allowSetTerminals,
        allowSetController: state.allowSetController,
        allowTerminalMigration: state.allowTerminalMigration,
        allowSetCustomToken: state.allowSetCustomToken,
        allowAddAccountingContext: state.allowAddAccountingContext,
        allowAddPriceFeed: state.allowAddPriceFeed,
      },
      splitGroups,
      fundAccessLimitGroups,
    } as JBRulesetConfig;
  };

  const handleReview = () => {
    if (!isConnected || !address) {
      openSignIn();
      return;
    }
    if (!weightValid || !limitsValid || !startValid || busy) return;
    if (limitBlock) {
      setFlowError(limitBlock);
      return;
    }
    if (changes.length === 0) {
      setFlowError("Nothing changed — edit a rule to queue an update.");
      return;
    }
    const config = buildConfig();
    const clearsPayouts =
      access.some((a) => hasPayoutLimit(a.payoutLimits)) &&
      config.fundAccessLimitGroups.every((g) => g.payoutLimits.length === 0);
    setReview({ config, account: address, clearsPayouts });
    setFlowError(null);
  };

  const handleConfirm = async () => {
    if (!review || busy) return;
    if (address?.toLowerCase() !== review.account.toLowerCase()) {
      setReview(null);
      setFlowError(
        "Your connected account changed — review the changes again.",
      );
      return;
    }
    setBusy(true);
    setFlowError(null);
    setStatus("Rechecking the live queue…");
    try {
      const [liveCurrent, liveLatest] = await Promise.all([
        getCurrentRuleset(publicClient, {
          chainId,
          projectId: BigInt(projectId),
        }),
        publicClient.readContract({
          address: controller,
          abi: jbControllerAbi,
          functionName: "latestQueuedRulesetOf",
          args: [BigInt(projectId)],
        }),
      ]);
      const livePlan = planRulesetQueue({
        current: liveCurrent.ruleset,
        upcoming: null,
        latest: liveLatest[0],
        latestApprovalStatus: Number(liveLatest[2]),
      });
      const liveOption = livePlan.options.find(
        (option) => option.action === action,
      );
      if (
        !liveOption ||
        !sameQueueSource(liveOption.source, source.option.source)
      ) {
        setReview(null);
        throw new Error(
          "The ruleset queue changed while this form was open. Nothing was sent; reload it and review the live queue again.",
        );
      }
      if (
        source.option.requiresStartDate &&
        review.config.mustStartAtOrAfter <
          Math.max(
            Math.floor(Date.now() / 1000) + 60,
            Number(liveOption.source.start) + 1,
          )
      ) {
        setReview(null);
        throw new Error(
          "The chosen follow-on time is no longer safely in the future. Nothing was sent; choose a later time and review again.",
        );
      }

      // Route by the controlling account: the owner EOA sends directly, an
      // owner Safe gets the exact call proposed/approved through the Safe, an
      // operator sends as itself — all simulation-first via runAuthorityCalls.
      const call = buildQueueRulesetsAuthorityCall({
        chainId,
        authority,
        controller,
        projectId: BigInt(projectId),
        rulesetConfigurations: [review.config],
        memo: "",
        label: "Queue new rules",
      });
      setStatus("Reviewing the queued rules…");
      const result = await runAuthorityCalls({
        calls: [call],
        onProgress: (progress) => setStatus(progress.message),
      });
      setTxHash(result.directResults[0] ?? null);
      setStatus(
        safeOutcomeMessage(
          result,
          queueSuccessCopy(action, mustStartAtOrAfter),
        ),
      );
      setSuccess(true);
    } catch (submitError) {
      setStatus(null);
      setFlowError(
        submitError instanceof Error
          ? submitError.message
          : "Could not queue the rules.",
      );
    } finally {
      setBusy(false);
    }
  };

  if (success) {
    return (
      <div className="card p-5">
        <p className="text-sm font-medium text-ink">
          {status ?? queueSuccessCopy(action, mustStartAtOrAfter)}
        </p>
        <div className="mt-2 flex gap-3 text-sm font-semibold">
          {txUrl ? (
            <a
              href={txUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-bluebs-600 underline underline-offset-2 hover:text-bluebs-700"
            >
              View transaction
            </a>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="card p-5">
      <span className="field-label">Edit rules</span>
      <p className="mt-1 text-xs text-smoke-700">
        Anything you don&apos;t touch — including payout recipients and the
        rule-change deadline — carries forward from the ruleset named below.
      </p>

      <QueueActionPicker
        data={data}
        action={action}
        disabled={busy || review !== null}
        onChange={onActionChange}
      />

      {source.option.requiresStartDate ? (
        <div className="mt-4">
          <span className="field-label">Start following rules</span>
          <DateTimeField
            value={scheduledStart}
            min={toLocalDateTimeInput(minimumScheduledStart)}
            disabled={busy || review !== null}
            onChange={(value) => {
              setScheduledStart(value);
              setReview(null);
              setFlowError(null);
            }}
            ariaLabel="Following rules start date and time"
            wrapperClassName="mt-1.5"
            inputClassName="input-well min-h-[40px] w-full px-3 text-sm"
          />
          <span className="mt-1 block text-xs text-smoke-600">
            This queued ruleset has no duration, so it has no automatic end.
            Pick when the following rules may replace it.
          </span>
          {!startValid && scheduledStart ? (
            <span className="mt-1 block text-xs font-medium text-red-700">
              Choose a future time after the queued ruleset starts.
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="mt-4 space-y-5">
        <section>
          <span className="field-label">Cycle length</span>
          <select
            value={state.duration}
            disabled={busy}
            onChange={(e) => set("duration", Number(e.target.value))}
            className="input-well mt-1.5 min-h-[40px] w-full px-3 text-sm"
          >
            {DURATION_PRESETS.some(
              (p) => p.seconds === state.duration,
            ) ? null : (
              <option value={state.duration}>
                {formatDuration(state.duration, {
                  exact: true,
                  zeroLabel: "No expiry",
                })}{" "}
                (current)
              </option>
            )}
            {DURATION_PRESETS.map((p) => (
              <option key={p.seconds} value={p.seconds}>
                {p.label}
              </option>
            ))}
          </select>
        </section>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <NumField
            label="Issuance (tokens per payment unit)"
            value={state.weight}
            onChange={(v) => set("weight", v)}
            disabled={busy}
            invalid={!weightValid}
          />
          <PctField
            label="Issuance cut each cycle"
            note={PROTOCOL_CONCEPTS.issuanceCut}
            value={state.weightCutPct}
            onChange={(v) => set("weightCutPct", v)}
            disabled={busy}
          />
          <PctField
            label="Reserved share"
            note={PROTOCOL_CONCEPTS.reservedShare}
            value={state.reservedPct}
            onChange={(v) => set("reservedPct", v)}
            disabled={busy}
          />
          <PctField
            label="Cash-out tax"
            note={PROTOCOL_CONCEPTS.cashOutTax}
            value={state.cashOutTaxPct}
            onChange={(v) => set("cashOutTaxPct", v)}
            disabled={busy}
          />
        </div>

        <section>
          <span className="field-label">Payout limits</span>
          <p className="mt-1 text-xs text-smoke-700">
            The most that can leave the project each cycle. Remove it and
            nothing can be paid out.
          </p>
          <div className="mt-2 space-y-3">
            {state.limits.map((l, i) => (
              <LimitRow
                key={l.token}
                limit={l}
                disabled={busy}
                onChange={(patch) => setLimit(i, patch)}
              />
            ))}
            {state.limits.length === 0 ? (
              <p className="text-xs text-smoke-500">
                No accounting tokens configured on this chain.
              </p>
            ) : null}
          </div>
        </section>

        <section>
          <span className="field-label">Other rules</span>
          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Toggle
              label="Pause payments"
              checked={state.pausePay}
              onChange={(v) => set("pausePay", v)}
              disabled={busy}
            />
            <Toggle
              label="Only project owner can send payouts"
              checked={state.ownerMustSendPayouts}
              onChange={(v) => set("ownerMustSendPayouts", v)}
              disabled={busy}
            />
            <Toggle
              label="Hold fees"
              checked={state.holdFees}
              onChange={(v) => set("holdFees", v)}
              disabled={busy}
            />
            <Toggle
              label="Pause internal credit transfers"
              checked={state.pauseCreditTransfers}
              onChange={(v) => set("pauseCreditTransfers", v)}
              disabled={busy}
            />
            <Toggle
              label="Pause eligible shop item transfers"
              checked={state.pause721Transfers}
              onChange={(v) => set("pause721Transfers", v)}
              disabled={busy}
            />
            <Toggle
              label="Allow project owner minting"
              checked={state.allowOwnerMinting}
              onChange={(v) => set("allowOwnerMinting", v)}
              disabled={busy}
            />
            <Toggle
              label="Allow changing terminals"
              checked={state.allowSetTerminals}
              onChange={(v) => set("allowSetTerminals", v)}
              disabled={busy}
            />
            <Toggle
              label="Allow changing controller"
              checked={state.allowSetController}
              onChange={(v) => set("allowSetController", v)}
              disabled={busy}
            />
            <Toggle
              label="Allow terminal migration"
              checked={state.allowTerminalMigration}
              onChange={(v) => set("allowTerminalMigration", v)}
              disabled={busy}
            />
            <Toggle
              label="Allow a custom token"
              checked={state.allowSetCustomToken}
              onChange={(v) => set("allowSetCustomToken", v)}
              disabled={busy}
            />
            <Toggle
              label="Allow adding accounting tokens"
              checked={state.allowAddAccountingContext}
              onChange={(v) => set("allowAddAccountingContext", v)}
              disabled={busy}
            />
            <Toggle
              label="Allow adding price feeds"
              checked={state.allowAddPriceFeed}
              onChange={(v) => set("allowAddPriceFeed", v)}
              disabled={busy}
            />
          </div>
        </section>
      </div>

      {review ? (
        <div className="callout callout-warning mt-4 text-xs">
          <p className="font-medium">
            {queueReviewHeading(action, mustStartAtOrAfter)}
          </p>
          <ul className="mt-1.5 space-y-1">
            {changes.map((c) => (
              <li key={c.label}>
                {c.label}: {c.from} → {c.to}
              </li>
            ))}
          </ul>
          {review.clearsPayouts ? (
            <p className="mt-2 rounded-md border border-red-300 bg-red-50 px-3 py-2 font-medium text-red-700">
              Payout limit removed — nothing can be paid out until you set a new
              limit.
            </p>
          ) : null}
        </div>
      ) : null}

      {limitBlock ? (
        <p className="mt-4 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900">
          {limitBlock}
        </p>
      ) : null}

      <button
        onClick={review ? () => void handleConfirm() : handleReview}
        disabled={
          busy ||
          (isConnected && (!weightValid || !limitsValid || !startValid || !!limitBlock))
        }
        className="btn-primary mt-4 min-h-[44px] w-full text-sm"
      >
        {busy
          ? "Queueing…"
          : !isConnected
            ? "Sign in to continue"
            : review
              ? "Confirm and queue"
              : "Review changes"}
      </button>

      {busy && status ? (
        <p className="mt-2 text-center text-xs text-smoke-700">{status}</p>
      ) : null}

      <TxError
        error={flowError}
        className="mt-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700"
      />
    </div>
  );
}

// -------------------------------------------------------------- helpers --

function QueueActionPicker({
  data,
  action,
  disabled,
  onChange,
}: {
  data: PrefillData;
  action: QueueAction;
  disabled: boolean;
  onChange: (action: QueueAction) => void;
}) {
  return (
    <section className="mt-4">
      <span className="field-label">Queue position</span>
      <div className="mt-2 space-y-2">
        {data.plan.options.map((option) => {
          const selected = option.action === action;
          const cycle = Number(option.source.cycleNumber);
          const status =
            option.action === "replace"
              ? data.latestApprovalStatus
              : option.action === "after"
                ? data.latestApprovalStatus
                : null;
          const label =
            option.action === "current"
              ? `Base new rules on current Cycle #${cycle}`
              : option.action === "replace"
                ? `Replace queued Cycle #${cycle}`
                : `Queue after Cycle #${cycle}`;
          let description: string;
          if (option.action === "current") {
            description =
              "The form is copied from the rules governing the project now. Their approval hook and cycle schedule determine when the change can take effect.";
          } else if (option.action === "replace") {
            // "its scheduled cycle" overstates the guarantee: a long-DURATION approval hook
            // can push the replacement past that cycle to a later multiple, so the start the
            // user reads here can differ from the actual one by whole cycles.
            description = `${approvalStatusLabel(status)}. The form is copied from this queued change and targets the next cycle its approval window allows.`;
            if (data.plan.hasMultipleQueuedRulesets) {
              description +=
                " Earlier queued configurations remain in place.";
            }
          } else if (option.requiresStartDate) {
            description = `${approvalStatusLabel(status)}. This ruleset has no automatic end, so choose when the following rules may start.`;
          } else {
            description = `${approvalStatusLabel(status)}. The form is copied from the last queued configuration and starts no earlier than ${formatRulesetDate(option.mustStartAtOrAfter ?? 0)}.`;
          }

          return (
            <label
              key={option.action}
              className={`flex cursor-pointer gap-3 rounded-lg border px-3 py-3 text-sm ${
                selected
                  ? "border-bluebs-500 bg-bluebs-50"
                  : "border-smoke-200 bg-white"
              } ${disabled ? "cursor-default opacity-70" : ""}`}
            >
              {data.plan.options.length > 1 ? (
                <input
                  type="radio"
                  name="queue-position"
                  checked={selected}
                  disabled={disabled}
                  onChange={() => onChange(option.action)}
                  className="mt-0.5"
                />
              ) : null}
              <span>
                <span className="block font-medium text-ink">{label}</span>
                <span className="mt-0.5 block text-xs leading-relaxed text-smoke-700">
                  {description}
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </section>
  );
}

function formatRulesetDate(seconds: number): string {
  if (!seconds) return "the next eligible cycle";
  return new Date(seconds * 1000).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function sameQueueSource(
  a: QueueActionOption["source"],
  b: QueueActionOption["source"],
): boolean {
  return (
    BigInt(a.id) === BigInt(b.id) &&
    BigInt(a.cycleNumber) === BigInt(b.cycleNumber) &&
    BigInt(a.start) === BigInt(b.start) &&
    BigInt(a.duration) === BigInt(b.duration)
  );
}

function queueReviewHeading(action: QueueAction, start: number): string {
  if (action === "replace") {
    return `These rules replace the queued change targeting ${formatRulesetDate(start)}:`;
  }
  if (action === "after") {
    return `These rules are queued no earlier than ${formatRulesetDate(start)}:`;
  }
  return "These rules are queued from the current configuration:";
}

function queueSuccessCopy(action: QueueAction, start: number): string {
  if (action === "replace") {
    return `Queued rules replaced for the cycle scheduled around ${formatRulesetDate(start)}. Their parent ruleset's approval hook still decides whether they take effect.`;
  }
  if (action === "after") {
    return `Following rules queued no earlier than ${formatRulesetDate(start)}.`;
  }
  return "New rules queued. Their parent ruleset's approval hook and cycle schedule determine when they take effect.";
}

function hasPayoutLimit(limits: readonly CurrencyAmount[]): boolean {
  return limits.some((l) => l.amount > 0n);
}

function limitDraftFrom(a: TokenAccess): LimitDraft {
  const first = a.payoutLimits[0];
  // `JBFundAccessLimitGroup.payoutLimits` is an ARRAY: a token can carry limits in several
  // currencies at once, and they are additive within their reset windows. This editor models
  // one value per token, so anything past the first cannot be represented — and the queued
  // ruleset is immutable, so silently emitting only the first would permanently delete the
  // rest. Recorded here and blocked at the gate rather than dropped.
  const unrepresentable = a.payoutLimits.slice(1).filter((l) => l.amount > 0n);
  const currency = first?.currency ?? a.ctx.currency;
  let mode: LimitDraft["mode"] = "none";
  let amount = "";
  if (first && first.amount > 0n) {
    if (first.amount >= UNLIMITED_FLOOR) {
      mode = "unlimited";
    } else {
      mode = "limited";
      // JBCurrencyAmount always uses the accounting token's decimals.
      amount = formatUnits(first.amount, a.ctx.decimals);
    }
  }
  return {
    token: a.ctx.token as Address,
    symbol: a.symbol,
    decimals: a.ctx.decimals,
    currency,
    mode,
    amount,
    surplusAllowances: a.surplusAllowances,
    unrepresentableLimits: unrepresentable,
  };
}

/**
 * Why this ruleset cannot be queued from here, or null when it can.
 *
 * Fails CLOSED: the alternative is queueing an immutable ruleset that drops payout limits the
 * owner never chose to remove.
 */
export function multiCurrencyLimitBlock(
  limits: readonly Pick<LimitDraft, "symbol" | "unrepresentableLimits">[],
): string | null {
  const affected = limits.filter((l) => (l.unrepresentableLimits?.length ?? 0) > 0);
  if (!affected.length) return null;
  const names = affected.map((l) => l.symbol).join(", ");
  return `${names} ${affected.length === 1 ? "has" : "have"} payout limits in more than one currency, which this editor can't preserve. Queueing here would drop them — use a tool that edits fund-access limits directly.`;
}

type Change = { label: string; from: string; to: string };

/** Describe one editor state as label → human value, for diffing. */
function describe(s: EditorState): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [
    {
      label: "Cycle length",
      value: formatDuration(s.duration, {
        exact: true,
        zeroLabel: "No expiry",
      }),
    },
    {
      label: "Issuance",
      value: `${Number(s.weight)} tokens per unit`,
    },
    { label: "Issuance cut", value: `${Number(s.weightCutPct)}%` },
    { label: "Reserved", value: `${Number(s.reservedPct)}%` },
    { label: "Cash-out tax", value: `${Number(s.cashOutTaxPct)}%` },
    { label: "Payments", value: s.pausePay ? "Paused" : "Open" },
    {
      label: "Payouts",
      value: s.ownerMustSendPayouts ? "Project owner only" : "Anyone",
    },
    { label: "Hold fees", value: s.holdFees ? "Yes" : "No" },
    {
      label: "Internal credit transfers",
      value: s.pauseCreditTransfers ? "Paused" : "Allowed",
    },
    {
      label: "Eligible shop item transfers",
      value: s.pause721Transfers ? "Paused" : "Allowed",
    },
    {
      label: "Project owner minting",
      value: s.allowOwnerMinting ? "On" : "Off",
    },
    { label: "Change terminals", value: s.allowSetTerminals ? "On" : "Off" },
    { label: "Change controller", value: s.allowSetController ? "On" : "Off" },
    {
      label: "Terminal migration",
      value: s.allowTerminalMigration ? "On" : "Off",
    },
    { label: "Custom token", value: s.allowSetCustomToken ? "On" : "Off" },
    {
      label: "Add accounting tokens",
      value: s.allowAddAccountingContext ? "On" : "Off",
    },
    { label: "Add price feeds", value: s.allowAddPriceFeed ? "On" : "Off" },
  ];
  for (const l of s.limits) {
    const unit = currencyLabel(l.currency, l.symbol);
    rows.push({
      label: `Payout limit (${l.symbol})`,
      value:
        l.mode === "none"
          ? "None"
          : l.mode === "unlimited"
            ? `Unlimited ${unit}`
            : `${Number(l.amount)} ${unit}`,
    });
  }
  return rows;
}

/** The changed rows between two editor states. */
function diffRows(baseline: EditorState, next: EditorState): Change[] {
  const a = describe(baseline);
  const b = describe(next);
  const out: Change[] = [];
  for (let i = 0; i < a.length; i++) {
    if (a[i].value !== b[i].value) {
      out.push({ label: a[i].label, from: a[i].value, to: b[i].value });
    }
  }
  return out;
}

function NumField({
  label,
  value,
  onChange,
  disabled,
  invalid,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
  invalid?: boolean;
}) {
  return (
    <label className="block">
      <span className="field-label">{label}</span>
      <input
        type="text"
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className={`input-well mt-1.5 min-h-[40px] w-full px-3 text-sm tabular-nums disabled:opacity-60 ${
          invalid ? "!border-red-400" : ""
        }`}
      />
    </label>
  );
}

function PctField({
  label,
  value,
  onChange,
  disabled,
  note,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
  /** What the field MEANS. These write an IMMUTABLE ruleset, so this is the highest-stakes
   *  place in the app to leave a term unexplained. */
  note?: string;
}) {
  return (
    <label className="block">
      <span className="field-label">
        {note ? <ConceptTerm note={note}>{label}</ConceptTerm> : label}
      </span>
      <div className="input-well mt-1.5 flex items-center px-3">
        <input
          type="text"
          inputMode="decimal"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          className="min-h-[40px] w-full bg-transparent text-sm tabular-nums outline-none disabled:opacity-60"
        />
        <span className="ml-2 shrink-0 text-sm text-smoke-700">%</span>
      </div>
    </label>
  );
}

function Toggle({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled: boolean;
}) {
  return (
    <label className="flex items-center gap-2 text-sm text-smoke-900">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
        className="h-4 w-4 accent-ink"
      />
      {label}
    </label>
  );
}

function LimitRow({
  limit,
  disabled,
  onChange,
}: {
  limit: LimitDraft;
  disabled: boolean;
  onChange: (patch: Partial<LimitDraft>) => void;
}) {
  const unit = currencyLabel(limit.currency, limit.symbol);
  return (
    <div className="rounded-lg border border-smoke-200 bg-smoke-75 p-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-ink">{limit.symbol}</span>
        <select
          value={limit.mode}
          disabled={disabled}
          onChange={(e) =>
            onChange({ mode: e.target.value as LimitDraft["mode"] })
          }
          className="input-well min-h-[36px] px-2.5 text-xs"
        >
          <option value="none">No payouts</option>
          <option value="limited">Limited</option>
          <option value="unlimited">Unlimited</option>
        </select>
      </div>
      {limit.mode === "limited" ? (
        <div className="input-well mt-2 flex items-center px-3">
          <input
            type="text"
            inputMode="decimal"
            value={limit.amount}
            onChange={(e) => onChange({ amount: e.target.value })}
            disabled={disabled}
            placeholder="0"
            aria-label={`Payout limit in ${unit}`}
            className="min-h-[40px] w-full bg-transparent text-sm tabular-nums outline-none disabled:opacity-60"
          />
          <span className="ml-2 shrink-0 text-sm text-smoke-700">{unit}</span>
        </div>
      ) : null}
    </div>
  );
}
