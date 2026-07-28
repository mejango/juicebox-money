"use client";

import {
  JBCoreContracts,
  SPLITS_TOTAL_PERCENT,
  jbContractAddress,
  jbDirectoryAbi,
  jbFundAccessLimitsAbi,
  jbProjectsAbi,
  jbSplitsAbi,
  type JBChainId,
} from "@bananapus/nana-sdk-core";
import {
  RESERVED_TOKEN_SPLIT_GROUP_ID,
  getAccountingContexts,
  getCurrentRuleset,
  payoutSplitGroupId,
  v6Address,
  type JBAccountingContext,
  type JBRulesetConfig,
} from "@bananapus/nana-sdk-core/v6";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { formatUnits, parseUnits, type Address, type PublicClient } from "viem";
import { usePublicClient, useReadContract } from "wagmi";
import { TxError } from "@/components/ui/TxError";
import { FormCardSkeleton } from "@/components/LoadingSkeletons";
import { txPhaseLabel, useSafeTx } from "@/hooks/useSafeTx";
import { useWallet } from "@/hooks/useWallet";
import { useViewedAccount } from "@/hooks/useViewedAccount";
import { billionthsToPct, etherscanTxUrl, formatDuration } from "@/lib/format";
import type { RawSplit } from "@/lib/splits-types";
import { tokenSymbol } from "@/lib/token-symbol";
import { buildQueueRulesetsRequest } from "@/lib/transaction-builders";

/** Payout amounts at/above this are treated as "no limit" (unlimited). */
const UNLIMITED_FLOOR = 2n ** 200n;
/** The value queued for an unlimited payout limit (uint224 max). */
const UNLIMITED_PAYOUT = 2n ** 224n - 1n;
/** ETH base currency id. */
const BASE_ETH = 1;
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
/** 0-100 percent string → basis-points-of-10000 integer, clamped. */
function pctToBp(pct: string): number {
  const n = Number(pct);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(PERCENT_OUT_OF_10000_MAX, Math.round(n * 100));
}

function currencyLabel(currency: number, symbol: string): string {
  if (currency === BASE_ETH) return "ETH";
  return symbol;
}

/**
 * Queue new rules for a CUSTOM project (website/ parity: the owner's
 * ruleset editor). Renders nothing for revnets (their stages are fixed) and
 * nothing unless the connected wallet is the on-chain owner and the project's
 * controller is one jbm can drive.
 *
 * The current ruleset + its metadata, per-token fund-access limits, and
 * payout/reserved splits are read live and prefilled. Editing builds ONE
 * JBRulesetConfig that carries forward everything untouched (approval hook,
 * data hook, splits, surplus allowances) and only changes what the owner
 * edited. A diff of just the changed rows is shown before sending
 * `queueRulesetsOf` to the resolved controller through useSafeTx.
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

  const { data: controller } = useReadContract({
    abi: jbDirectoryAbi,
    address: jbContractAddress["6"][JBCoreContracts.JBDirectory][chainId],
    functionName: "controllerOf",
    args: [BigInt(projectId)],
    chainId,
    query: { enabled: isOwner, staleTime: 60_000 },
  });

  const canonicalController = jbContractAddress["6"][
    JBCoreContracts.JBController
  ][chainId] as Address | undefined;
  const knownController =
    !!controller &&
    !!canonicalController &&
    controller.toLowerCase() === canonicalController.toLowerCase();

  // Load everything the editor prefills from, once we know the wallet owns
  // the project (avoid the reads for everyone else).
  const { data, isLoading, isError } = useQuery({
    queryKey: ["queueRulesetPrefill", chainId, projectId],
    enabled: !isRevnet && isOwner && !!publicClient,
    staleTime: 30_000,
    retry: 1,
    queryFn: async () => {
      const pid = BigInt(projectId);
      const limitsAddr = v6Address("JBFundAccessLimits", chainId);
      const splitsAddr = v6Address("JBSplits", chainId);
      const terminal = v6Address("JBMultiTerminal", chainId);

      const [current, contexts] = await Promise.all([
        getCurrentRuleset(publicClient!, { chainId, projectId: pid }),
        getAccountingContexts(publicClient!, { chainId, projectId: pid }).catch(
          () => [] as JBAccountingContext[],
        ),
      ]);
      const rid = BigInt(current.ruleset.id);

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

      // Splits to carry forward: reserved + one payout group per token.
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
        current,
        rulesetId: rid,
        terminal,
        access,
        reservedSplits,
        payoutSplits: contexts.map((ctx, i) => ({
          token: ctx.token as Address,
          splits: payoutSplits[i],
        })),
      };
    },
  });

  if (isRevnet || !isOwner || controller === undefined) return null;

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
      data={data}
    />
  );
}

/** The live state the editor prefills from. */
type PrefillData = {
  current: Awaited<ReturnType<typeof getCurrentRuleset>>;
  rulesetId: bigint;
  terminal: Address;
  access: TokenAccess[];
  reservedSplits: readonly RawSplit[];
  payoutSplits: { token: Address; splits: readonly RawSplit[] }[];
};

/** A reviewed, ready-to-send queue: the exact config is frozen so what the
 *  owner confirms is what's sent. */
type Reviewed = {
  config: JBRulesetConfig;
  account: Address;
  /** Whether the new config removes all payout limits. */
  clearsPayouts: boolean;
};

function RulesetEditor({
  chainId,
  projectId,
  controller,
  data,
}: {
  chainId: JBChainId;
  projectId: number;
  controller: Address;
  data: PrefillData;
}) {
  const { isConnected, address, openSignIn } = useWallet();
  const tx = useSafeTx(chainId);

  const { current, terminal, access, reservedSplits, payoutSplits } = data;
  const r = current.ruleset;
  const m = current.metadata;

  const baseline: EditorState = useMemo(
    () => ({
      duration: r.duration,
      weight: formatUnits(r.weight, 18),
      weightCutPct: billionthsToPct(r.weightCutPercent, 4),
      reservedPct: bpToPct(m.reservedPercent),
      cashOutTaxPct: bpToPct(m.cashOutTaxRate),
      pausePay: m.pausePay,
      pauseCreditTransfers: m.pauseCreditTransfers,
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

  const txUrl = tx.hash ? etherscanTxUrl(chainId, tx.hash) : null;
  const busy = tx.busy;

  // Which rows changed (old → new), for the confirm diff.
  const changes = useMemo(() => diffRows(baseline, state), [baseline, state]);
  const weightValid = (() => {
    const n = Number(state.weight);
    return state.weight.trim() !== "" && Number.isFinite(n) && n >= 0;
  })();
  const limitsValid = state.limits.every(
    (l) => l.mode !== "limited" || Number(l.amount) > 0,
  );

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
      mustStartAtOrAfter: 0,
      duration: state.duration,
      weight: parseUnits(state.weight.trim() || "0", 18),
      weightCutPercent: pctTo1e9(state.weightCutPct),
      // Keep the current approval hook so the rule-change deadline is unchanged.
      approvalHook: r.approvalHook,
      metadata: {
        ...m,
        reservedPercent: pctToBp(state.reservedPct),
        cashOutTaxRate: pctToBp(state.cashOutTaxPct),
        pausePay: state.pausePay,
        pauseCreditTransfers: state.pauseCreditTransfers,
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
    if (!weightValid || !limitsValid || busy) return;
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

  const handleConfirm = () => {
    if (!review || busy) return;
    if (address?.toLowerCase() !== review.account.toLowerCase()) {
      setReview(null);
      setFlowError(
        "Your connected account changed — review the changes again.",
      );
      return;
    }
    tx.send(
      buildQueueRulesetsRequest({
        chainId,
        controller,
        projectId: BigInt(projectId),
        rulesetConfigurations: [review.config],
        memo: "",
      }),
    );
  };

  if (tx.phase === "success") {
    return (
      <div className="card p-5">
        <p className="text-sm font-medium text-ink">
          New rules queued. They take effect at the start of the next cycle.
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
        Changes queue for the next cycle. Anything you don&apos;t touch —
        including payout recipients and the rule-change deadline — carries
        forward unchanged.
      </p>

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
            value={state.weightCutPct}
            onChange={(v) => set("weightCutPct", v)}
            disabled={busy}
          />
          <PctField
            label="Reserved share"
            value={state.reservedPct}
            onChange={(v) => set("reservedPct", v)}
            disabled={busy}
          />
          <PctField
            label="Cash-out tax"
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
              label="Pause token transfers"
              checked={state.pauseCreditTransfers}
              onChange={(v) => set("pauseCreditTransfers", v)}
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
          <p className="font-medium">These rules change at the next cycle:</p>
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

      <button
        onClick={review ? handleConfirm : handleReview}
        disabled={busy || (isConnected && (!weightValid || !limitsValid))}
        className="btn-primary mt-4 min-h-[44px] w-full text-sm"
      >
        {txPhaseLabel(tx.phase, {
          pending: "Queueing…",
          idle: !isConnected
            ? "Sign in to continue"
            : review
              ? "Confirm and queue"
              : "Review changes",
        })}
      </button>

      {tx.phase === "pending" && txUrl ? (
        <p className="mt-2 text-center text-xs text-smoke-700">
          Waiting for confirmation —{" "}
          <a
            href={txUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2"
          >
            view transaction
          </a>
        </p>
      ) : null}

      <TxError
        error={flowError ?? tx.error}
        className="mt-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700"
      />
    </div>
  );
}

// -------------------------------------------------------------- helpers --

function hasPayoutLimit(limits: readonly CurrencyAmount[]): boolean {
  return limits.some((l) => l.amount > 0n);
}

function limitDraftFrom(a: TokenAccess): LimitDraft {
  const first = a.payoutLimits[0];
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
  };
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
      label: "Token transfers",
      value: s.pauseCreditTransfers ? "Paused" : "Allowed",
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
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
}) {
  return (
    <label className="block">
      <span className="field-label">{label}</span>
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
