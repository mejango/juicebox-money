"use client";

import {
  JBCoreContracts,
  SPLITS_TOTAL_PERCENT,
  USDC_ADDRESSES,
  NATIVE_TOKEN,
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
import { useMemo, useState, type ReactNode } from "react";
import {
  formatUnits,
  parseEther,
  parseUnits,
  type Address,
  type PublicClient,
} from "viem";
import { usePublicClient, useReadContract } from "wagmi";
import { ModalShell } from "@/components/ui/ModalShell";
import { TxConfirmDialog, type TxConfirmRow } from "@/components/ui/TxConfirmDialog";
import { TxError } from "@/components/ui/TxError";
import { FormCardSkeleton } from "@/components/LoadingSkeletons";
import { useWallet } from "@/hooks/useWallet";
import { useViewedAccount } from "@/hooks/useViewedAccount";
import { clientFor, runAuthorityCalls, safeOutcomeMessage, type AuthorityCall } from "@/lib/authority";
import { readAuthorityIdentity } from "@/lib/cross-chain-authority";
import { loadRelayrPendingSession, relayrCallsScope, resumeRelayrSession } from "@/lib/relayr";
import { relayrSupportsChain, relayrSupportsChains } from "@/lib/relayr-chains";
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
import { chainName } from "@/lib/urn";
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
import {
  FOREVER_SECONDS,
  deadlineSecondsForHook,
  deriveStartFrom,
} from "@/lib/launch";

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

/** A ruleset queued after the previous one: starts after N of its cycles, or
 *  on a date (snapped up to the previous ruleset's cycle boundary). */
type Follower = {
  id: string;
  rules: EditorState;
  startMode: "cycles" | "date";
  startCycles: string;
  startDate: string;
};
type AfterMode = "wait" | "terminal" | "cycle";

function followerStartOk(f: Follower): boolean {
  if (f.startMode === "date") {
    return !!f.startDate && !Number.isNaN(new Date(f.startDate).getTime());
  }
  const n = Number(f.startCycles);
  return Number.isInteger(n) && n >= 1;
}

/** Ruleset #1's `mustStartAtOrAfter` is fixed by the queue position; each
 *  follower encodes 0 (the previous ruleset's next boundary) or an absolute
 *  start. Starts chain from the parent ruleset the queue is based on, the
 *  way JBRulesets.deriveStartFrom will snap them. */
export function queueStageStarts({
  parent,
  firstMust,
  stages,
  now,
}: {
  parent: { start: number; duration: number } | null;
  firstMust: number;
  stages: {
    duration: number;
    startMode?: "cycles" | "date";
    startCycles?: string;
    startDate?: string;
  }[];
  now: number;
}): { musts: number[]; starts: number[] } {
  const musts = [firstMust];
  const starts = [
    parent
      ? deriveStartFrom(parent.start, parent.duration, firstMust || now)
      : firstMust || now,
  ];
  for (let i = 1; i < stages.length; i++) {
    const prevStart = starts[i - 1];
    const prevDuration = stages[i - 1].duration;
    const st = stages[i];
    let must = 0;
    if (st.startMode === "date") {
      must = st.startDate
        ? Math.floor(new Date(st.startDate).getTime() / 1000)
        : 0;
    } else if (st.startMode === "cycles") {
      const n = Number(st.startCycles) || 1;
      if (n > 1) must = prevStart + n * prevDuration;
    }
    musts.push(must);
    starts.push(deriveStartFrom(prevStart, prevDuration, must || now));
  }
  return { musts, starts };
}

/** The "Afterwards" choice for a timed last ruleset, as an extra stage. */
export function expandAfterwards(
  stages: EditorState[],
  afterMode: AfterMode,
): EditorState[] {
  const last = stages[stages.length - 1];
  const timed = last.duration > 0 && last.duration !== FOREVER_SECONDS;
  if (!timed || afterMode === "cycle") return stages;
  if (afterMode === "terminal") {
    return [...stages, { ...last, duration: FOREVER_SECONDS }];
  }
  return [
    ...stages,
    {
      ...last,
      duration: 0,
      weight: "0",
      pausePay: true,
      limits: last.limits.map((l) => ({ ...l, mode: "none" as const })),
    },
  ];
}

function isWeightValid(weight: string): boolean {
  const n = Number(weight);
  if (weight.trim() === "" || !Number.isFinite(n) || n < 0) return false;
  try {
    if (parseEther(weight.trim()) === 1n) return false;
  } catch {
    return false;
  }
  return true;
}

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
 * and splits are prefilled from that exact source. Each selected chain keeps
 * its own untouched configuration while reviewed edits carry across stages.
 * Per-chain changes and starts are shown before sending
 * `queueRulesetsOf` to the resolved controller through the simulation-first
 * Safe/Relayr authority router (runAuthorityCalls, like EditSplitsFlow).
 */
export function QueueRulesetFlow({
  chainId,
  projectId,
  isRevnet,
  chains = [],
}: {
  chainId: JBChainId;
  projectId: number;
  isRevnet: boolean;
  chains?: readonly (readonly [number, number])[];
}) {
  const [open, setOpen] = useState(false);
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
    queryFn: () => readQueuePrefill(publicClient!, chainId, projectId, controller as Address),
  });

  const recoveryKey = queueRecoveryKey(chainId, projectId);
  const { data: pendingScope, refetch: refreshRecovery } = useQuery({
    queryKey: ["queueRulesetRecovery", chainId, projectId, open],
    enabled: !isRevnet && !!address,
    staleTime: 0,
    queryFn: () => pendingQueueScope(recoveryKey),
  });
  const [recovered, setRecovered] = useState(false);

  if (isRevnet || (!pendingScope && (!canEdit || controller === undefined))) return null;

  let body: ReactNode;
  if (pendingScope) {
    body = <QueueRecovery journal={pendingScope} onComplete={() => {
      setRecovered(true);
      void refreshRecovery();
    }} />;
  } else if (recovered) {
    body = <p className="text-sm text-smoke-700">The saved ruleset update is confirmed on every destination. Reload the project to see the new queue.</p>;
  } else if (!knownController) {
    body = (
      <p className="text-sm leading-relaxed text-smoke-700">
        This project queues rules through a wrapper jbm doesn&apos;t drive
        yet, so rules can&apos;t be edited here. Use the tool that deployed
        it.
      </p>
    );
  } else if (isLoading) {
    body = <FormCardSkeleton label="Loading ruleset editor" />;
  } else if (isError || !data) {
    body = (
      <p className="text-sm text-smoke-700">
        Couldn&apos;t load this project&apos;s current rules right now.
      </p>
    );
  } else {
    body = (
      <RulesetEditor
        chainId={chainId}
        projectId={projectId}
        data={data}
        chains={chains}
        onPending={() => void refreshRecovery()}
      />
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="absolute right-5 top-5 text-sm font-medium text-bluebs-600 underline decoration-bluebs-300 underline-offset-4 hover:text-bluebs-700"
      >
        {pendingScope ? "Resume rules update" : "Edit rules"}
      </button>
      {open ? (
        <ModalShell title="Edit rules" onClose={() => setOpen(false)}>
          {body}
        </ModalShell>
      ) : null}
    </>
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

async function readQueuePrefill(publicClient: PublicClient, chainId: JBChainId, projectId: number, controller: Address): Promise<PrefillData> {
      const pid = BigInt(projectId);
      const limitsAddr = v6Address("JBFundAccessLimits", chainId);
      const splitsAddr = v6Address("JBSplits", chainId);
      const terminal = v6Address("JBMultiTerminal", chainId);

      const terminals = await publicClient.readContract({ address: v6Address("JBDirectory", chainId), abi: jbDirectoryAbi, functionName: "terminalsOf", args: [pid] });
      if (terminals.some(address => address.toLowerCase() !== terminal.toLowerCase())) {
        throw new Error(`${chainName(chainId)} uses a custom terminal. Use its own ruleset editor to preserve all fund access limits.`);
      }

      const [current, upcomingRead, latestRead, contexts] = await Promise.all([
        getCurrentRuleset(publicClient, { chainId, projectId: pid }),
        getUpcomingRuleset(publicClient, { chainId, projectId: pid }),
        publicClient.readContract({
          address: controller as Address,
          abi: jbControllerAbi,
          functionName: "latestQueuedRulesetOf",
          args: [pid],
        }),
        getAccountingContexts(publicClient, { chainId, projectId: pid }),
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
              publicClient.readContract({
                address: limitsAddr,
                abi: jbFundAccessLimitsAbi,
                functionName: "payoutLimitsOf",
                args: [pid, rid, terminal, ctx.token],
              }) as Promise<readonly CurrencyAmount[]>,
              publicClient.readContract({
                address: limitsAddr,
                abi: jbFundAccessLimitsAbi,
                functionName: "surplusAllowancesOf",
                args: [pid, rid, terminal, ctx.token],
              }) as Promise<readonly CurrencyAmount[]>,
              tokenSymbol(publicClient, ctx.token, { chainId }),
            ]);
            return { ctx, symbol, payoutLimits, surplusAllowances };
          }),
        );
        const reservedSplits = (await publicClient.readContract({
          address: splitsAddr,
          abi: jbSplitsAbi,
          functionName: "splitsOf",
          args: [pid, rid, RESERVED_TOKEN_SPLIT_GROUP_ID],
        })) as readonly RawSplit[];
        const payoutSplits = await Promise.all(
          contexts.map(
            (ctx) =>
              publicClient.readContract({
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
}

function rulesFromSource(source: PrefillSource): EditorState {
  const { ruleset: r, metadata: m } = source.entry;
  const { access } = source;
  return {
      duration: r.duration,
      weight: formatUnits(r.weight, 18),
      weightCutPct: billionthsToPct(r.weightCutPercent, 7),
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
    };
}

function queueRecoveryKey(chainId: number, projectId: number): string {
  return `jbm:queue-rulesets:${chainId}:${projectId}`;
}

type QueueRecoveryJournal = { scope: string; review: Reviewed; action: QueueAction };

export function readQueueJournal(key: string): QueueRecoveryJournal | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const journal = JSON.parse(raw, (_key, value) => value && typeof value === "object" && Object.keys(value).length === 1 && typeof value.bigint === "string" ? BigInt(value.bigint) : value) as QueueRecoveryJournal;
    if (!journal.review?.destinations?.length || journal.scope !== relayrCallsScope(reviewedQueueCalls(journal.review, journal.action))) return null;
    return journal;
  } catch { return null; }
}

function pendingQueueScope(key: string): QueueRecoveryJournal | null {
  const journal = readQueueJournal(key);
  return journal && loadRelayrPendingSession(journal.scope) ? journal : null;
}

export function saveQueueJournal(journal: QueueRecoveryJournal): void {
  const text = JSON.stringify(journal, (_key, value) => typeof value === "bigint" ? { bigint: value.toString() } : value);
  for (const destination of journal.review.destinations) {
    const key = queueRecoveryKey(destination.chainId, destination.projectId);
    const existing = pendingQueueScope(key);
    if (existing && existing.scope !== journal.scope) throw new Error(`Resume the pending ruleset update on ${chainName(destination.chainId)} first.`);
    window.localStorage.setItem(key, text);
    if (window.localStorage.getItem(key) !== text) throw new Error("Allow browser storage before queueing rules on multiple chains.");
  }
}

/** Overlapping chain selections share a lock before publishing recovery aliases. */
async function withQueueDestinationLocks<T>(destinations: readonly Pick<QueueDestination, "chainId" | "projectId">[], run: () => Promise<T>): Promise<T> {
  if (typeof navigator === "undefined" || !navigator.locks) {
    if (destinations.length < 2) return run();
    throw new Error("Use a browser with Web Locks support to queue rules on multiple chains.");
  }
  const keys = destinations.map(destination => queueRecoveryKey(destination.chainId, destination.projectId)).sort();
  const lock = async (index: number): Promise<T> => index === keys.length ? run() : await navigator.locks.request(keys[index], { ifAvailable: true }, async held => {
    if (!held) throw new Error("A ruleset update for this project is already running in another tab.");
    return lock(index + 1);
  });
  return lock(0);
}

function clearQueueJournal(journal: QueueRecoveryJournal): void {
  for (const destination of journal.review.destinations) {
    const key = queueRecoveryKey(destination.chainId, destination.projectId);
    if (readQueueJournal(key)?.scope === journal.scope) window.localStorage.removeItem(key);
  }
}

export function QueueRecovery({ journal, onComplete }: { journal: QueueRecoveryJournal; onComplete: () => void }) {
  const { address } = useWallet();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("A ruleset update is awaiting confirmation. Resume its saved bundle before queueing more rules.");
  return <div className="space-y-3">
    <p className="text-sm text-smoke-700">{status}</p>
    <TxError error={error} />
    <button className="btn-primary min-h-[44px] px-5 text-sm" disabled={busy || !address} onClick={async () => {
      if (!address) return;
      setBusy(true); setError(null);
      try {
        if (address.toLowerCase() !== journal.review.account.toLowerCase()) throw new Error("Connect the wallet that reviewed this ruleset update.");
        const saved = loadRelayrPendingSession(journal.scope);
        if (saved?.paymentStatus === "unpaid") {
          await runAuthorityCalls({ calls: reviewedQueueCalls(journal.review, journal.action), onProgress: progress => setStatus(progress.message) });
        } else await resumeRelayrSession({ scope: journal.scope, account: address, onProgress: progress => {
          if (progress.phase === "executing") setStatus(`Relayr reports ${progress.done}/${progress.total} complete. Verifying the original transactions…`);
          else setStatus("Checking the saved payment and destination transactions…");
        } });
        clearQueueJournal(journal);
        onComplete();
      } catch (err) { setError(err instanceof Error ? err.message : "Could not resume the ruleset update."); }
      finally { setBusy(false); }
    }}>{busy ? "Checking saved update…" : "Resume ruleset update"}</button>
  </div>;
}


type QueueDestination = {
  chainId: JBChainId;
  projectId: number;
  controller: Address;
  authority: Address;
  data: PrefillData;
};

type ReviewedDestination = QueueDestination & {
  source: PrefillSource;
  configs: JBRulesetConfig[];
  starts: number[];
  changes: TxConfirmRow[];
};

async function readQueueDestination(chainId: JBChainId, projectId: number, account: Address): Promise<QueueDestination> {
  const client = clientFor(chainId);
  const [owner, controller] = await Promise.all([
    client.readContract({ address: v6Address("JBProjects", chainId), abi: jbProjectsAbi, functionName: "ownerOf", args: [BigInt(projectId)] }),
    client.readContract({ address: v6Address("JBDirectory", chainId), abi: jbDirectoryAbi, functionName: "controllerOf", args: [BigInt(projectId)] }),
  ]);
  if (controller.toLowerCase() !== v6Address("JBController", chainId).toLowerCase()) {
    throw new Error("This chain uses a controller this editor cannot drive.");
  }
  let authority: Address | null = null;
  if (owner.toLowerCase() === account.toLowerCase()) authority = owner;
  else {
    const identity = await readAuthorityIdentity(client, owner);
    if (identity?.kind === "safe" && identity.owners.some(signer => signer.toLowerCase() === account.toLowerCase())) authority = owner;
    else if (await hasPermissions(client, { chainId, operator: account, account: owner, projectId: BigInt(projectId), permissionIds: [JBPermissionIdsV6.QUEUE_RULESETS] })) authority = account;
  }
  if (!authority) throw new Error("This wallet cannot queue rules on this chain.");
  return { chainId, projectId, controller, authority, data: await readQueuePrefill(client, chainId, projectId, controller) };
}

function limitChanged(a: LimitDraft, b: LimitDraft): boolean {
  return a.mode !== b.mode || a.amount !== b.amount || a.currency !== b.currency;
}

/** Carry only reviewed changes to a peer, preserving every untouched chain-specific field. */
export function rulesForQueueDestination(baseline: EditorState, stage: EditorState, peer: EditorState, sourceChain: JBChainId, destinationChain: JBChainId): EditorState {
  if (sourceChain === destinationChain) return stage;
  const result = { ...peer, limits: peer.limits.map(limit => ({ ...limit })) };
  for (const field of Object.keys(baseline) as (keyof EditorState)[]) {
    if (field !== "limits" && stage[field] !== baseline[field]) {
      Object.assign(result, { [field]: stage[field] });
    }
  }
  baseline.limits.forEach((original, index) => {
    if (!limitChanged(original, stage.limits[index])) return;
    const originalToken = original.token.toLowerCase();
    const peerToken = originalToken === NATIVE_TOKEN.toLowerCase()
      ? NATIVE_TOKEN
      : originalToken === USDC_ADDRESSES[sourceChain]?.toLowerCase()
        ? USDC_ADDRESSES[destinationChain]
        : undefined;
    if (!peerToken) throw new Error(`Edit ${original.symbol} payout limits separately on each chain; its token mapping cannot be verified.`);
    const peerIndex = result.limits.findIndex(limit => limit.token.toLowerCase() === peerToken.toLowerCase());
    if (peerIndex < 0) throw new Error(`${chainName(destinationChain)} does not accept ${original.symbol}. Edit its payout limits separately.`);
    const target = result.limits[peerIndex];
    if (target.unrepresentableLimits?.length) throw new Error(`${chainName(destinationChain)} has multiple payout currencies for ${original.symbol}. Edit its limits separately.`);
    const next = stage.limits[index];
    if (next.currency !== BASE_ETH && next.currency !== BASE_USD && next.currency !== Number(BigInt(original.token) & 0xffffffffn)) {
      throw new Error(`Edit ${original.symbol} limits in currency ${next.currency} separately; its cross-chain unit cannot be verified.`);
    }
    // Base currency IDs name ETH/USD; a token-denominated currency must use
    // this destination's token address rather than the route chain's uint32.
    const currency = next.currency === BASE_ETH || next.currency === BASE_USD
      ? next.currency
      : Number(BigInt(peerToken) & 0xffffffffn);
    result.limits[peerIndex] = { ...target, mode: next.mode, amount: next.amount, currency };
  });
  return result;
}

export function queueDestinationStages(baseline: EditorState, stages: EditorState[], peer: EditorState, sourceChain: JBChainId, destinationChain: JBChainId, afterMode: AfterMode): EditorState[] {
  let previous = peer;
  const explicit = stages.map((stage, index) => {
    const mapped = rulesForQueueDestination(index === 0 ? baseline : stages[index - 1], stage, previous, sourceChain, destinationChain);
    previous = mapped;
    return mapped;
  });
  const mapped = expandAfterwards(explicit, afterMode);
  if (mapped.some((stage, index) => index < mapped.length - 1 && (stage.duration === 0 || stage.duration === FOREVER_SECONDS))) {
    throw new Error(`${chainName(destinationChain)} has a non-final ruleset with no end. Set its cycle length before adding a following ruleset.`);
  }
  return mapped;
}

/** A reviewed, ready-to-send queue: the exact config is frozen so what the
 *  owner confirms is what's sent. */
type Reviewed = {
  configs: JBRulesetConfig[];
  destinations: ReviewedDestination[];
  account: Address;
  /** Whether the new config removes all payout limits. */
  clearsPayouts: boolean;
};

export function buildQueueDestinationConfig(
    rules: EditorState,
    stageMustStart: number,
    configSource: PrefillSource,
  ): JBRulesetConfig {
    const { terminal, reservedSplits, payoutSplits } = configSource;
    const { ruleset: r, metadata: m } = configSource.entry;
    const fundAccessLimitGroups = rules.limits
      .map((l) => {
        const original = configSource.access.find(access => access.ctx.token.toLowerCase() === l.token.toLowerCase());
        return {
        terminal,
        token: l.token,
        payoutLimits: original && !limitChanged(limitDraftFrom(original), l)
          ? original.payoutLimits.map(limit => ({ ...limit }))
          : l.mode === "none"
            ? []
            : [
                {
                  amount:
                    l.mode === "unlimited"
                      ? UNLIMITED_PAYOUT
                      : parseUnits(l.amount.trim() || "0", l.decimals),
                  currency: l.currency,
                },
                ...(l.unrepresentableLimits ?? []),
              ],
        surplusAllowances: l.surplusAllowances.map((s) => ({
          amount: s.amount,
          currency: s.currency,
        })),
      }})
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
      mustStartAtOrAfter: stageMustStart,
      duration: rules.duration,
      weight: parseUnits(rules.weight.trim() || "0", 18),
      weightCutPercent: pctTo1e9(rules.weightCutPct),
      // Keep the selected source's approval hook so its future rule-change
      // condition carries forward unchanged.
      approvalHook: r.approvalHook,
      metadata: {
        ...m,
        reservedPercent: pctToBp(rules.reservedPct),
        cashOutTaxRate: pctToBp(rules.cashOutTaxPct),
        pausePay: rules.pausePay,
        pauseCreditTransfers: rules.pauseCreditTransfers,
        metadata: build721RulesetMetadata({
          metadata: Number(m.metadata ?? 0),
          pauseTransfers: rules.pause721Transfers,
        }),
        holdFees: rules.holdFees,
        ownerMustSendPayouts: rules.ownerMustSendPayouts,
        allowOwnerMinting: rules.allowOwnerMinting,
        allowSetTerminals: rules.allowSetTerminals,
        allowSetController: rules.allowSetController,
        allowTerminalMigration: rules.allowTerminalMigration,
        allowSetCustomToken: rules.allowSetCustomToken,
        allowAddAccountingContext: rules.allowAddAccountingContext,
        allowAddPriceFeed: rules.allowAddPriceFeed,
      },
      splitGroups,
      fundAccessLimitGroups,
    } as JBRulesetConfig;
  }

export function reviewedQueueCalls(review: Reviewed, action: QueueAction): AuthorityCall[] {
  return review.destinations.map(destination => ({
        ...buildQueueRulesetsAuthorityCall({
          chainId: destination.chainId, authority: destination.authority, controller: destination.controller,
          projectId: BigInt(destination.projectId), rulesetConfigurations: destination.configs, memo: "", label: "Queue new rules",
        }),
        reverifyAuthority: async () => {
          const live = await readQueueDestination(destination.chainId, destination.projectId, review.account);
          const liveSource = live.data.sources[action];
          if (live.authority.toLowerCase() !== destination.authority.toLowerCase() || live.controller.toLowerCase() !== destination.controller.toLowerCase() || queueSourceFingerprint(liveSource) !== queueSourceFingerprint(destination.source)) {
            throw new Error(`The authority, queue, or rules changed on ${chainName(destination.chainId)}. Reload and review before sending.`);
          }
          if (review.destinations.length > 1) {
            if (!relayrSupportsChains(review.destinations.map(item => item.chainId))) throw new Error("Choose supported chains from the same network family: all mainnets or all testnets.");
            const identity = await readAuthorityIdentity(clientFor(destination.chainId), live.authority);
            if (live.authority.toLowerCase() !== review.account.toLowerCase() || (identity?.kind !== "eoa" && identity?.kind !== "delegated-eoa")) throw new Error("Queue rules separately for Safe accounts and different authorities.");
          }
          const now = Math.floor(Date.now() / 1000);
          if (destination.source.option.requiresStartDate && destination.configs[0].mustStartAtOrAfter < Math.max(now + 60, Number(liveSource!.entry.ruleset.start) + 1)) {
            throw new Error("The chosen start is no longer safely in the future. Choose a later time and review again.");
          }
          const parent = action === "replace" ? BigInt(destination.source.entry.ruleset.basedOnId) === BigInt(live.data.current.ruleset.id) ? live.data.current.ruleset : null : liveSource!.entry.ruleset;
          const starts = queueStageStarts({ parent: parent ? { start: Number(parent.start), duration: Number(parent.duration) } : null, firstMust: destination.configs[0].mustStartAtOrAfter,
            stages: destination.configs.map((config, index) => ({ duration: config.duration, ...(index > 0 ? { startMode: "date" as const, startDate: new Date((config.mustStartAtOrAfter || now) * 1000).toISOString() } : {}) })), now }).starts;
          assertQueueNotice(destination.chainId, liveSource!, parent?.approvalHook as Address | undefined, starts, now);
        },
      }));
}

function RulesetEditor(props: {
  chainId: JBChainId;
  projectId: number;
  data: PrefillData;
  chains: readonly (readonly [number, number])[];
  onPending: () => void;
}) {
  const [action, setAction] = useState<QueueAction>(
    props.data.plan.defaultAction,
  );
  const source = props.data.sources[action];
  if (!source) {
    return (
      <div>
        <p className="text-sm leading-relaxed text-smoke-700">
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
  data,
  action,
  source,
  onActionChange,
  chains,
  onPending,
}: {
  chainId: JBChainId;
  projectId: number;
  data: PrefillData;
  action: QueueAction;
  source: PrefillSource;
  onActionChange: (action: QueueAction) => void;
  chains: readonly (readonly [number, number])[];
  onPending: () => void;
}) {
  const { isConnected, address, openSignIn } = useWallet();

  const { access } = source;
  const r = source.entry.ruleset;

  const baseline = useMemo(() => rulesFromSource(source), [source]);

  const projectChains = useMemo(() => Array.from(new Map([[chainId, projectId] as const, ...chains].map(([id, pid]) => [id, [id as JBChainId, pid] as const])).values()), [chainId, projectId, chains]);
  const [selectedChains, setSelectedChains] = useState<Set<number>>(() => new Set([chainId]));
  const destinationsQuery = useQuery({
    queryKey: ["queueRulesetDestinations", projectChains.map(([id, pid]) => `${id}:${pid}`).join("|"), address],
    enabled: !!address && projectChains.length > 1,
    staleTime: 30_000,
    queryFn: () => Promise.all(projectChains.map(async ([id, pid]) => {
      try {
        const destination = await readQueueDestination(id, pid, address!);
        const identity = await readAuthorityIdentity(clientFor(id), destination.authority);
        const relayable = relayrSupportsChain(id) && destination.authority.toLowerCase() === address!.toLowerCase() && (identity?.kind === "eoa" || identity?.kind === "delegated-eoa");
        return { chainId: id, destination, relayable, error: null };
      } catch (err) {
        return { chainId: id, destination: null, relayable: false, error: err instanceof Error ? err.message : "Could not verify this chain." };
      }
    })),
  });
  const primaryRelayable = destinationsQuery.data?.find(item => item.chainId === chainId)?.relayable ?? false;

  const [state, setState] = useState<EditorState>(baseline);
  const [review, setReview] = useState<Reviewed | null>(null);
  const [flowError, setFlowError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [txHash, setTxHash] = useState<`0x${string}` | null>(null);
  const [scheduledStart, setScheduledStart] = useState("");

  const [followers, setFollowers] = useState<Follower[]>([]);
  const [afterMode, setAfterMode] = useState<AfterMode>("cycle");

  const patch = (p: Partial<EditorState>) => {
    setState((s) => ({ ...s, ...p }));
    setReview(null);
    setFlowError(null);
  };
  const patchFollower = (id: string, p: Partial<Follower>) => {
    setFollowers((fs) => fs.map((f) => (f.id === id ? { ...f, ...p } : f)));
    setReview(null);
    setFlowError(null);
  };
  const addFollower = () => {
    setFollowers((fs) => {
      const prev = fs.length ? fs[fs.length - 1].rules : state;
      return [
        ...fs,
        {
          id: crypto.randomUUID(),
          rules: { ...prev, limits: prev.limits.map((l) => ({ ...l })) },
          startMode: "cycles",
          startCycles: "1",
          startDate: "",
        },
      ];
    });
    setReview(null);
    setFlowError(null);
  };
  const removeFollower = (id: string) => {
    setFollowers((fs) => fs.filter((f) => f.id !== id));
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
  // A weight of exactly 1 wei collides with the JBRulesets inherit sentinel: raw `1` means
  // "inherit the previous ruleset's decayed weight" (JBRulesets.sol:822-823), not "one
  // attowei of issuance". Typing 0.000000000000000001 would therefore queue a completely
  // different — and immutable — encoding from the one shown.
  const weightValid = isWeightValid(state.weight);
  const limitsOk = (rules: EditorState) =>
    rules.limits.every((l) => l.mode !== "limited" || Number(l.amount) > 0);
  const limitsValid = limitsOk(state);
  const stagesRules = [state, ...followers.map((f) => f.rules)];
  const followersValid = followers.every(
    (f) => isWeightValid(f.rules.weight) && limitsOk(f.rules) && followerStartOk(f),
  );
  // A non-final ruleset with no cycle length never ends, so the next one would
  // start at the same instant and clobber it.
  const nonFinalOpenEnded = stagesRules.some(
    (rules, i) => i < stagesRules.length - 1 && rules.duration === 0,
  );
  const lastRules = stagesRules[stagesRules.length - 1];
  const lastTimed =
    lastRules.duration > 0 && lastRules.duration !== FOREVER_SECONDS;
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

  // The ruleset the queued Ruleset #1 is based on: the source itself when
  // basing on current or appending after the tail; when replacing, the
  // replaced ruleset's own parent (unknown here unless it is current).
  const parentRuleset =
    action === "replace"
      ? BigInt(r.basedOnId) === BigInt(data.current.ruleset.id)
        ? data.current.ruleset
        : null
      : r;
  const allStages = expandAfterwards(stagesRules, afterMode);
  const stageStarts = (now: number) =>
    queueStageStarts({
      parent: parentRuleset
        ? {
            start: Number(parentRuleset.start),
            duration: Number(parentRuleset.duration),
          }
        : null,
      firstMust: mustStartAtOrAfter,
      stages: allStages.map((rules, i) => ({
        duration: rules.duration,
        ...(i >= 1 && i <= followers.length ? followers[i - 1] : {}),
      })),
      now,
    });
  // A ruleset queued now that starts sooner than its approval hook's deadline
  // is rejected (JBDeadline → Failed) and silently never takes effect. The
  // parent's hook governs Ruleset #1; #1's hook (carried from the source)
  // governs everything queued after it.
  const noticeClash = (() => {
    const now = Math.floor(Date.now() / 1000);
    const { starts } = stageStarts(now);
    const parentSecs = deadlineSecondsForHook(
      parentRuleset?.approvalHook as Address | undefined,
      chainId,
    );
    const hourly = (secs: number) =>
      formatDuration(Math.max(0, Math.floor(secs / 3600) * 3600), {
        exact: true,
        zeroLabel: "moments",
      });
    if (parentSecs && starts[0] - now < parentSecs) {
      return `Ruleset #1 would start ${hourly(starts[0] - now)} after queueing, sooner than the parent ruleset's ${formatDuration(parentSecs, { exact: true })} rule-change notice, so its approval hook would reject it and it would never take effect. Choose a later start.`;
    }
    const secs = deadlineSecondsForHook(r.approvalHook as Address, chainId);
    if (!secs) return null;
    for (let i = 1; i < starts.length; i++) {
      if (starts[i] - now < secs) {
        const who =
          i < stagesRules.length
            ? `Ruleset #${i + 1}`
            : "The closing ruleset (Afterwards)";
        return `${who} would start ${hourly(starts[i] - now)} after queueing, sooner than the ${formatDuration(secs, { exact: true })} rule-change notice, so the approval hook would reject it and it would never take effect. Shorten the earlier cycles' count or make them run longer.`;
      }
    }
    return null;
  })();


  const handleReview = async () => {
    if (!isConnected || !address) { openSignIn(); return; }
    if (!weightValid || !limitsValid || !startValid || busy) return;
    if (!followersValid || nonFinalOpenEnded || (selectedChains.size === 1 && noticeClash)) return;
    if (limitBlock) { setFlowError(limitBlock); return; }
    if (changes.length === 0 && followers.length === 0) {
      setFlowError("Nothing changed — edit a rule to queue an update."); return;
    }
    setBusy(true); setFlowError(null);
    try {
      for (const [id, pid] of projectChains.filter(([id]) => selectedChains.has(id))) {
        if (pendingQueueScope(queueRecoveryKey(id, pid))) {
          onPending(); throw new Error(`Resume the pending ruleset update on ${chainName(id)} first.`);
        }
      }
      const multi = selectedChains.size > 1;
      if (multi && !relayrSupportsChains(projectChains.filter(([id]) => selectedChains.has(id)).map(([id]) => id))) throw new Error("Choose supported chains from the same network family: all mainnets or all testnets.");
      const live = await Promise.all(projectChains.filter(([id]) => selectedChains.has(id)).map(([id, pid]) => readQueueDestination(id, pid, address)));
      const route = live.find(destination => destination.chainId === chainId)!;
      if (!route || queueSourceFingerprint(route.data.sources[action]) !== queueSourceFingerprint(source)) {
        throw new Error("The ruleset queue or its settings changed. Reload the editor and review the live rules again.");
      }
      if (multi) {
        for (const destination of live) {
          const identity = await readAuthorityIdentity(clientFor(destination.chainId), destination.authority);
          if (!relayrSupportsChain(destination.chainId) || destination.authority.toLowerCase() !== address.toLowerCase() || (identity?.kind !== "eoa" && identity?.kind !== "delegated-eoa")) {
            throw new Error("Queue rules separately for Safe accounts and different authorities.");
          }
        }
      }
      const now = Math.floor(Date.now() / 1000);
      const selectedSources = live.map(destination => {
        const peerSource = destination.data.sources[action];
        if (!peerSource) throw new Error(`${chainName(destination.chainId)} cannot use this queue position. Edit its queue separately.`);
        return { destination, source: peerSource };
      });
      if (action === "replace" && selectedSources.some(item => item.source.option.mustStartAtOrAfter !== source.option.mustStartAtOrAfter)) {
        throw new Error("The queued changes start at different times. Replace them separately on each chain, or choose a following ruleset.");
      }
      // A shared lower bound leaves time to sign/pay. Each parent still snaps
      // that bound to its own calendar, shown for every destination below.
      const commonMust = multi && action !== "replace" ? Math.max(
        now + 600,
        scheduledStartSeconds || 0,
        ...selectedSources.map(({ destination, source: peer }) => Math.max(peer.option.mustStartAtOrAfter ?? 0, now + (deadlineSecondsForHook(peer.entry.ruleset.approvalHook as Address, destination.chainId) ?? 0) + 600)),
      ) : mustStartAtOrAfter;
      const destinations: ReviewedDestination[] = selectedSources.map(({ destination, source: peer }) => {
        if (peer.option.requiresStartDate && (!commonMust || commonMust < Math.max(now + 60, Number(peer.entry.ruleset.start) + 1))) {
          throw new Error(`Choose a future start after the queued rules on ${chainName(destination.chainId)}.`);
        }
        const peerStages = queueDestinationStages(baseline, stagesRules, rulesFromSource(peer), chainId, destination.chainId, afterMode);
        const peerParent = action === "replace"
          ? BigInt(peer.entry.ruleset.basedOnId) === BigInt(destination.data.current.ruleset.id) ? destination.data.current.ruleset : null
          : peer.entry.ruleset;
        if (multi && !peerParent) throw new Error(`The replaced ruleset's parent could not be verified on ${chainName(destination.chainId)}. Edit this chain separately.`);
        const timing = queueStageStarts({
          parent: peerParent ? { start: Number(peerParent.start), duration: Number(peerParent.duration) } : null,
          firstMust: commonMust,
          stages: peerStages.map((rules, i) => ({ duration: rules.duration, ...(i >= 1 && i <= followers.length ? followers[i - 1] : {}) })),
          now,
        });
        assertQueueNotice(destination.chainId, peer, peerParent?.approvalHook as Address | undefined, timing.starts, now);
        return { ...destination, source: peer, configs: peerStages.map((rules, i) => buildQueueDestinationConfig(rules, timing.musts[i], peer)), starts: timing.starts,
          changes: peerStages.flatMap((rules, index) => diffRows(index === 0 ? rulesFromSource(peer) : peerStages[index - 1], rules).map(change => ({ label: `${chainName(destination.chainId)} #${index + 1}: ${change.label}`, value: `${change.from} → ${change.to}` }))),
        };
      });
      const configs = destinations.find(destination => destination.chainId === chainId)!.configs;
      const clearsPayouts = access.some(item => hasPayoutLimit(item.payoutLimits)) && configs[0].fundAccessLimitGroups.every(group => group.payoutLimits.length === 0);
      setReview({ configs, destinations, account: address, clearsPayouts });
    } catch (err) { setFlowError(err instanceof Error ? err.message : "Could not review the rules."); }
    finally { setBusy(false); }
  };

  const handleConfirm = async () => {
    if (!review || busy) return;
    if (address?.toLowerCase() !== review.account.toLowerCase()) {
      setReview(null); setFlowError("Your connected account changed — review the changes again."); return;
    }
    setBusy(true); setFlowError(null); setStatus("Rechecking every selected queue…");
    const recoveryKey = queueRecoveryKey(chainId, projectId);
    try {
      if (pendingQueueScope(recoveryKey)) { onPending(); return; }
      const calls = reviewedQueueCalls(review, action);
      const result = await withQueueDestinationLocks(review.destinations, async () => {
        for (const destination of review.destinations) {
          if (pendingQueueScope(queueRecoveryKey(destination.chainId, destination.projectId))) throw new Error(`Resume the pending ruleset update on ${chainName(destination.chainId)} first.`);
        }
        if (calls.length > 1) {
          // Freeze every destination before any signature can be published.
          saveQueueJournal({ scope: relayrCallsScope(calls), review, action });
        }
        const result = await runAuthorityCalls({ calls, onProgress: progress => setStatus(progress.message) });
        clearQueueJournal({ scope: relayrCallsScope(calls), review, action });
        return result;
      });
      setTxHash(result.directResults[0] ?? null);
      setStatus(safeOutcomeMessage(result, queueSuccessCopy(action, review.configs[0].mustStartAtOrAfter)));
      setSuccess(true);
    } catch (err) {
      setStatus(null); setFlowError(err instanceof Error ? err.message : "Could not queue the rules.");
      if (pendingQueueScope(recoveryKey)) onPending();
    } finally { setBusy(false); }
  };

  const reviewRows: TxConfirmRow[] = review
    ? [
        action === "replace"
          ? {
              label: "Replaces",
              value: `The queued change targeting ${formatRulesetDate(mustStartAtOrAfter)}`,
            }
          : action === "after"
            ? {
                label: "Starts",
                value: `No earlier than ${formatRulesetDate(mustStartAtOrAfter)}`,
              }
            : { label: "Based on", value: "The current rules" },
        ...(changes.length === 0
          ? [{ label: "Ruleset #1", value: "Unchanged" }]
          : changes.map((c) => ({
              label: c.label,
              value: `${c.from} → ${c.to}`,
            }))),
        ...followers.flatMap((f, i) => {
          const prev = i === 0 ? state : followers[i - 1].rules;
          const diff = diffRows(prev, f.rules);
          return [
            {
              label: `Ruleset #${i + 2} starts`,
              value:
                f.startMode === "date"
                  ? `${formatRulesetDate(Math.floor(new Date(f.startDate).getTime() / 1000))}, snapped to Ruleset #${i + 1}'s cycle`
                  : `After ${Number(f.startCycles) || 1} cycle${Number(f.startCycles) === 1 ? "" : "s"} of Ruleset #${i + 1}`,
            },
            ...(diff.length === 0
              ? [
                  {
                    label: `Ruleset #${i + 2} rules`,
                    value: `Same as Ruleset #${i + 1}`,
                  },
                ]
              : diff.map((c) => ({
                  label: `Ruleset #${i + 2}: ${c.label}`,
                  value: `${c.from} → ${c.to}`,
                }))),
          ];
        }),
        ...(lastTimed && afterMode !== "cycle"
          ? [
              {
                label: "Afterwards",
                value:
                  afterMode === "wait"
                    ? "Wait — payments and issuance pause until new rules are queued"
                    : "Terminate — the last terms lock in forever",
              },
            ]
          : []),
        ...review.destinations.flatMap(destination => [
          { label: chainName(destination.chainId), value: `Project #${destination.projectId}; issuance per ${currencyLabel(destination.source.entry.metadata.baseCurrency, "base currency " + destination.source.entry.metadata.baseCurrency)}` },
          ...(review.destinations.length > 1 ? destination.changes : []),
          ...destination.starts.map((start, index) => ({ label: `${chainName(destination.chainId)} ruleset #${index + 1}`, value: `Starts around ${formatRulesetDate(start)}` })),
        ]),
      ]
    : [];

  if (success && !review) {
    return (
      <div>
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
    <div>
      <p className="text-xs text-smoke-700">
        Anything you don&apos;t touch — including payout recipients and the
        rule-change deadline — carries forward from the ruleset named below.
      </p>

      {projectChains.length > 1 ? <fieldset className="mt-4 space-y-2">
        <legend className="field-label">Queue on</legend>
        {projectChains.map(([id]) => {
          const row = destinationsQuery.data?.find(item => item.chainId === id);
          const eligible = id === chainId || (primaryRelayable && relayrSupportsChains([chainId, id]) && row?.relayable && !!row.destination?.data.sources[action]);
          return <label key={id} className="flex items-start gap-2 text-sm text-smoke-700">
            <input type="checkbox" className="mt-1" checked={selectedChains.has(id)} disabled={busy || review !== null || id === chainId || !eligible} onChange={() => {
              setSelectedChains(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; });
              setReview(null); setFlowError(null);
            }} />
            <span>{chainName(id)}{id === chainId ? " (shown here)" : !row ? " — checking…" : row.error ? ` — ${row.error}` : !eligible ? " — edit this chain separately" : ""}</span>
          </label>;
        })}
        <p className="text-xs text-smoke-600">Changed rules apply to the selected chains. Choose all mainnets or all testnets; each chain keeps its other settings, recipients, and rule-change notice. Safe accounts are queued separately.</p>
      </fieldset> : null}

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

      <RulesFields
        rules={state}
        onChange={patch}
        onLimit={setLimit}
        disabled={busy}
        weightValid={weightValid}
      />

      {followers.map((f, i) => {
        const index = i + 1;
        const prev = index === 1 ? state : followers[i - 1].rules;
        const prevTimed = prev.duration > 0 && prev.duration !== FOREVER_SECONDS;
        return (
          <div
            key={f.id}
            className="mt-5 rounded-lg border border-smoke-200 bg-smoke-75 p-4"
          >
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-medium text-ink">
                Ruleset #{index + 1}
              </span>
              <button
                type="button"
                onClick={() => removeFollower(f.id)}
                disabled={busy}
                className="text-xs font-medium text-smoke-700 underline underline-offset-4 hover:text-ink"
              >
                Remove
              </button>
            </div>
            <div className="mt-3">
              <span className="field-label">Starts</span>
              <div className="mt-1.5 flex flex-wrap items-center gap-2.5">
                <select
                  value={f.startMode}
                  disabled={busy}
                  onChange={(e) =>
                    patchFollower(f.id, {
                      startMode: e.target.value as Follower["startMode"],
                    })
                  }
                  className="input-well select-caret min-h-[40px] w-36 px-3 pr-9 text-sm"
                >
                  <option value="cycles">After</option>
                  <option value="date">On a date</option>
                </select>
                {f.startMode === "cycles" ? (
                  <>
                    <input
                      type="text"
                      inputMode="numeric"
                      value={f.startCycles}
                      disabled={busy}
                      onChange={(e) =>
                        patchFollower(f.id, {
                          startCycles: e.target.value.slice(0, 5),
                        })
                      }
                      className={`input-well min-h-[40px] w-20 px-3 text-sm tabular-nums ${
                        followerStartOk(f) ? "" : "!border-red-400"
                      }`}
                    />
                    <span className="text-sm text-smoke-700">
                      cycle{Number(f.startCycles) === 1 ? "" : "s"} of Ruleset #
                      {index}
                    </span>
                  </>
                ) : (
                  <DateTimeField
                    value={f.startDate}
                    disabled={busy}
                    onChange={(startDate) => patchFollower(f.id, { startDate })}
                    ariaLabel={`Ruleset #${index + 1} start date and time`}
                    inputClassName="input-well min-h-[40px] px-3 text-sm"
                  />
                )}
              </div>
              <p className="mt-1.5 text-xs leading-relaxed text-smoke-700">
                {!prevTimed
                  ? `Ruleset #${index} needs a cycle length so Ruleset #${index + 1} knows when to start.`
                  : f.startMode === "cycles"
                    ? `Ruleset #${index} repeats that many times, then these rules take over.`
                    : `Rule changes land on cycle boundaries, so the start snaps to Ruleset #${index}'s first cycle ending at or after this date.`}
              </p>
            </div>
            <div className="mt-4">
              <RulesFields
                rules={f.rules}
                onChange={(p) =>
                  patchFollower(f.id, { rules: { ...f.rules, ...p } })
                }
                onLimit={(li, lp) =>
                  patchFollower(f.id, {
                    rules: {
                      ...f.rules,
                      limits: f.rules.limits.map((l, j) =>
                        j === li ? { ...l, ...lp } : l,
                      ),
                    },
                  })
                }
                disabled={busy}
                weightValid={isWeightValid(f.rules.weight)}
              />
            </div>
          </div>
        );
      })}

      <button
        type="button"
        onClick={addFollower}
        disabled={busy}
        className="mt-4 text-sm font-medium text-bluebs-600 underline decoration-bluebs-300 underline-offset-4 hover:text-bluebs-700"
      >
        + Add a following ruleset
      </button>

      {lastTimed ? (
        <div className="mt-5 border-t border-smoke-200 pt-4">
          <span className="field-label">
            Afterwards — when Ruleset #{stagesRules.length} ends
          </span>
          <select
            value={afterMode}
            disabled={busy}
            onChange={(e) => {
              setAfterMode(e.target.value as AfterMode);
              setReview(null);
              setFlowError(null);
            }}
            className="input-well select-caret mt-1.5 min-h-[40px] w-full max-w-xs px-3 pr-9 text-sm"
          >
            <option value="cycle">Cycle</option>
            <option value="wait">Wait</option>
            <option value="terminal">Terminate</option>
          </select>
          <p className="mt-1.5 text-xs leading-relaxed text-smoke-700">
            {afterMode === "wait"
              ? "The project idles — payments and issuance pause until the project owner queues more rules."
              : afterMode === "terminal"
                ? "These terms are locked in forever — they can never be changed again."
                : "The ruleset restarts each time it ends. Any issuance cut applies each cycle, and the project owner can still queue changes."}
          </p>
        </div>
      ) : null}

      {noticeClash && selectedChains.size === 1 ? (
        <p className="mt-4 text-xs font-medium text-red-700">{noticeClash}</p>
      ) : null}

      {limitBlock ? (
        <p className="mt-4 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900">
          {limitBlock}
        </p>
      ) : null}

      <div className="mt-4 flex justify-end">
      <button
        onClick={() => void handleReview()}
        disabled={
          busy ||
          (isConnected &&
            (!weightValid ||
              !limitsValid ||
              !startValid ||
              !followersValid ||
              nonFinalOpenEnded ||
              (selectedChains.size === 1 && !!noticeClash) ||
              !!limitBlock))
        }
        className="btn-primary min-h-[44px] px-5 text-sm"
      >
        {!isConnected ? "Sign in to continue" : "Queue new rules"}
      </button>
      </div>

      {review ? null : (
        <TxError
          error={flowError}
          className="mt-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700"
        />
      )}

      {review ? (
        <TxConfirmDialog
          open
          title={success ? "Rules queued" : "Confirm new rules"}
          rows={reviewRows}
          steps={[{ title: "Queue new rules" }]}
          activeIndex={busy ? 0 : -1}
          status={status}
          error={flowError}
          busy={busy}
          complete={success}
          action={flowError ? "Retry" : "Confirm and queue"}
          onConfirm={() => void handleConfirm()}
          onClose={() => {
            if (busy) return;
            setReview(null);
            setFlowError(null);
          }}
        >
          {review.clearsPayouts ? (
            <p className="text-sm font-medium text-red-700">
              Payout limit removed — nothing can be paid out until you set a
              new limit.
            </p>
          ) : null}
        </TxConfirmDialog>
      ) : null}
    </div>
  );
}


/** The editable rule fields for one ruleset — Ruleset #1 and every follow-on ruleset render the same set. */
function RulesFields({
  rules,
  onChange,
  onLimit,
  disabled,
  weightValid,
}: {
  rules: EditorState;
  onChange: (patch: Partial<EditorState>) => void;
  onLimit: (i: number, patch: Partial<LimitDraft>) => void;
  disabled: boolean;
  weightValid: boolean;
}) {
  const set = <K extends keyof EditorState>(key: K, value: EditorState[K]) =>
    onChange({ [key]: value } as Partial<EditorState>);
  return (
    <div className="mt-4 space-y-5">
      <section>
        <span className="field-label">Cycle length</span>
        <select
          value={rules.duration}
          disabled={disabled}
          onChange={(e) => set("duration", Number(e.target.value))}
          className="input-well select-caret mt-1.5 min-h-[40px] w-full max-w-xs px-3 pr-9 text-sm"
        >
          {DURATION_PRESETS.some(
            (p) => p.seconds === rules.duration,
          ) ? null : (
            <option value={rules.duration}>
              {formatDuration(rules.duration, {
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
          value={rules.weight}
          onChange={(v) => set("weight", v)}
          disabled={disabled}
          invalid={!weightValid}
        />
        <PctField
          label="Issuance cut each cycle"
          note={PROTOCOL_CONCEPTS.issuanceCut}
          value={rules.weightCutPct}
          onChange={(v) => set("weightCutPct", v)}
          disabled={disabled}
        />
        <PctField
          label="Reserved share"
          note={PROTOCOL_CONCEPTS.reservedShare}
          value={rules.reservedPct}
          onChange={(v) => set("reservedPct", v)}
          disabled={disabled}
        />
        <PctField
          label="Cash-out tax"
          note={PROTOCOL_CONCEPTS.cashOutTax}
          value={rules.cashOutTaxPct}
          onChange={(v) => set("cashOutTaxPct", v)}
          disabled={disabled}
        />
      </div>

      <section>
        <span className="field-label">Payout limits</span>
        <p className="mt-1 text-xs text-smoke-700">
          The most that can leave the project each cycle. Remove it and
          nothing can be paid out.
        </p>
        <div className="mt-2 space-y-3">
          {rules.limits.map((l, i) => (
            <LimitRow
              key={l.token}
              limit={l}
              disabled={disabled}
              onChange={(patch) => onLimit(i, patch)}
            />
          ))}
          {rules.limits.length === 0 ? (
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
            checked={rules.pausePay}
            onChange={(v) => set("pausePay", v)}
            disabled={disabled}
          />
          <Toggle
            label="Only project owner can send payouts"
            checked={rules.ownerMustSendPayouts}
            onChange={(v) => set("ownerMustSendPayouts", v)}
            disabled={disabled}
          />
          <Toggle
            label="Hold fees"
            checked={rules.holdFees}
            onChange={(v) => set("holdFees", v)}
            disabled={disabled}
          />
          <Toggle
            label="Pause internal credit transfers"
            checked={rules.pauseCreditTransfers}
            onChange={(v) => set("pauseCreditTransfers", v)}
            disabled={disabled}
          />
          <Toggle
            label="Pause eligible shop item transfers"
            checked={rules.pause721Transfers}
            onChange={(v) => set("pause721Transfers", v)}
            disabled={disabled}
          />
          <Toggle
            label="Allow project owner minting"
            checked={rules.allowOwnerMinting}
            onChange={(v) => set("allowOwnerMinting", v)}
            disabled={disabled}
          />
          <Toggle
            label="Allow changing terminals"
            checked={rules.allowSetTerminals}
            onChange={(v) => set("allowSetTerminals", v)}
            disabled={disabled}
          />
          <Toggle
            label="Allow changing controller"
            checked={rules.allowSetController}
            onChange={(v) => set("allowSetController", v)}
            disabled={disabled}
          />
          <Toggle
            label="Allow terminal migration"
            checked={rules.allowTerminalMigration}
            onChange={(v) => set("allowTerminalMigration", v)}
            disabled={disabled}
          />
          <Toggle
            label="Allow a custom token"
            checked={rules.allowSetCustomToken}
            onChange={(v) => set("allowSetCustomToken", v)}
            disabled={disabled}
          />
          <Toggle
            label="Allow adding accounting tokens"
            checked={rules.allowAddAccountingContext}
            onChange={(v) => set("allowAddAccountingContext", v)}
            disabled={disabled}
          />
          <Toggle
            label="Allow adding price feeds"
            checked={rules.allowAddPriceFeed}
            onChange={(v) => set("allowAddPriceFeed", v)}
            disabled={disabled}
          />
        </div>
      </section>
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

export function queueSourceFingerprint(source: PrefillSource | undefined): string {
  return JSON.stringify(source, (_key, value) => typeof value === "bigint" ? value.toString() : value);
}

function assertQueueNotice(chainId: JBChainId, source: PrefillSource, parentHook: Address | undefined, starts: number[], now: number) {
  starts.forEach((start, index) => {
    const notice = deadlineSecondsForHook(index === 0 ? parentHook : source.entry.ruleset.approvalHook as Address, chainId);
    if (notice && start - now < notice) throw new Error(`Ruleset #${index + 1} starts too soon for ${chainName(chainId)}'s rule-change notice. Choose a later start.`);
  });
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
          className="input-well select-caret min-h-[36px] max-w-xs px-2.5 pr-9 text-xs"
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
