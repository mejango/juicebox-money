import { formatUnits } from "viem";
import { decimalOk as numOk } from "@/lib/decimal";
export { decimalOk as numOk } from "@/lib/decimal";
import {
  autoIssuanceMintChain,
  CASH_OUTS_OFF_REVNET,
  createSimpleProjectStage,
  FOREVER_SECONDS,
  LAUNCH_START_DELAY_SECONDS,
  routesAllFunds,
} from "@/lib/launch";
import { resolvedAddress } from "@/lib/ens";
import { cashOutTaxValue, formatDateTime, truncateAddress } from "@/lib/format";
import { chainName } from "@/lib/urn";
import { isStickyRow, splitOk, splitsTotal, type DraftSplit } from "./SplitsEditor";

/**
 * One stage = one queued ruleset (website/ parity). Every rule here is
 * per-stage; the approval condition lives at the stages-list level.
 */

export type DraftStage = {
  id: string;
  /** Duration select value: '0' Flexible, preset seconds, FOREVER, 'custom'. */
  durationValue: string;
  customDuration: string;
  customUnit: "hours" | "days" | "weeks" | "years";
  /** Stage 1 only: schedule a start instead of launching right away. */
  scheduleOn: boolean;
  schedule: string;
  /** '' on stage 2+ = keep the previous stage's (cut) rate. */
  issuanceRate: string;
  /** Automatic issuance cuts on/off (revnet). */
  cutOn: boolean;
  /** Issuance cut per cycle, 0–100 (%). '' = none. */
  cutPct: string;
  /** Revnet: days between issuance cuts. */
  cutFreqDays: string;
  /** Revnet, stage 2+: starts this many days after the previous stage. */
  daysAfter: string;
  /** Project, stage 2+: start after N cycles of the previous ruleset, or
   *  on a date (snapped up to the previous ruleset's cycle boundary). */
  startMode: "cycles" | "date";
  startCycles: string;
  startDate: string;
  reservedPct: string;
  reservedSplits: DraftSplit[];
  payouts: "none" | "flexible" | "routed";
  routedMode: "all" | "amounts";
  payoutSplits: DraftSplit[];
  /** Multi-token (ETH+USDC): USDC's own routed config. */
  routedModeUsdc: "all" | "amounts";
  payoutSplitsUsdc: DraftSplit[];
  holdFees: boolean;
  /** Flexible: cap owner withdrawals; Routed(amounts): optional owner
   *  surplus access. */
  surplusCapOn: boolean;
  surplusAmount: string;
  routedSurplusOn: boolean;
  cashOuts: boolean;
  cashOutTax: number;
  /** Custom tax %: overrides cashOutTax when on. */
  taxCustomOn: boolean;
  taxCustomPct: string;
  ownerMinting: boolean;
  acceptPayments: boolean;
  pauseCreditTransfers: boolean;
  /** Pause transfers for shop items whose tier opted into pausing. */
  pause721Transfers: boolean;
  /** App-specific uint14 metadata; hidden bits survive imported drafts. */
  metadataExtra: number;
  /** Revnet: tokens minted to beneficiaries when the stage starts. Each
   *  row mints once, on ITS chosen chain (null = first selected chain);
   *  every chain's config encodes the full list byte-identically. */
  autoIssuances: {
    id: string;
    count: string;
    address: string;
    /** The ONE chain this row mints on; null defaults to the first
     *  selected chain at encode. Kept verbatim while unselected so a
     *  chain toggle doesn't lose the pick. */
    chainId: number | null;
    perChain: Record<number, string>;
  }[];
  powers: {
    setTerminals: boolean;
    setController: boolean;
    terminalMigration: boolean;
    setCustomToken: boolean;
    addAccountingContext: boolean;
    addPriceFeed: boolean;
  };
  expanded: boolean;
  open: Record<string, boolean>;
};

export function newDraftStage(
  first: boolean,
  flavor: "project" | "revnet" = "project",
): DraftStage {
  return {
    id: crypto.randomUUID(),
    durationValue: "0",
    customDuration: "",
    customUnit: "days",
    scheduleOn: false,
    schedule: "",
    issuanceRate: first ? "10000" : "",
    cutOn: false,
    cutPct: "",
    cutFreqDays: "30",
    daysAfter: "30",
    startMode: "cycles",
    startCycles: "1",
    startDate: "",
    reservedPct: "0",
    reservedSplits: [],
    payouts: "none",
    routedMode: "all",
    payoutSplits: [],
    routedModeUsdc: "all",
    payoutSplitsUsdc: [],
    holdFees: false,
    surplusCapOn: false,
    surplusAmount: "",
    routedSurplusOn: false,
    cashOuts: flavor === "revnet",
    cashOutTax: flavor === "revnet" ? 1000 : 0,
    taxCustomOn: false,
    taxCustomPct: "",
    ownerMinting: false,
    acceptPayments: true,
    pauseCreditTransfers: false,
    pause721Transfers: false,
    metadataExtra: 0,
    autoIssuances: [],
    powers: {
      setTerminals: false,
      setController: false,
      terminalMigration: false,
      setCustomToken: false,
      addAccountingContext: false,
      addPriceFeed: false,
    },
    expanded: first,
    open: {},
  };
}

/** The same integer-second cycle the revnet encoder sends to the contracts. */
export function revnetCutFrequency(stage: Pick<DraftStage, "cutOn" | "cutPct" | "cutFreqDays">): number {
  return stage.cutOn && Number(stage.cutPct) > 0
    ? Math.round(Number(stage.cutFreqDays || "0") * 86_400)
    : 0;
}

/** Form representation of the same preset the Simple launch encoder uses. */
export function newSimpleProjectDraftStage(): DraftStage {
  const preset = createSimpleProjectStage();
  return {
    ...newDraftStage(true),
    durationValue: String(preset.duration),
    issuanceRate: formatUnits(preset.weight, 18),
    cutPct: String(preset.weightCutPercent / 1e7),
    reservedPct: String(preset.reservedPercent / 100),
    payouts: preset.payouts,
    holdFees: preset.holdFees,
    cashOuts: preset.cashOutTaxRate !== null,
    cashOutTax: preset.cashOutTaxRate ?? 0,
    ownerMinting: preset.allowOwnerMinting,
    acceptPayments: !preset.pausePay,
    pauseCreditTransfers: preset.pauseCreditTransfers,
    pause721Transfers: preset.pause721Transfers,
    metadataExtra: preset.metadataExtra,
    powers: {
      setTerminals: preset.allowSetTerminals,
      setController: preset.allowSetController,
      terminalMigration: preset.allowTerminalMigration,
      setCustomToken: preset.allowSetCustomToken,
      addAccountingContext: preset.allowAddAccountingContext,
      addPriceFeed: preset.allowAddPriceFeed,
    },
  };
}

const UNIT_SECONDS = {
  hours: 3_600,
  days: 86_400,
  weeks: 604_800,
  years: 31_536_000,
} as const;

/** Unix seconds a later project stage must start at or after, given the
 *  previous stage's (estimated) start and duration. 0 = the previous
 *  stage's next cycle boundary, today's default encoding. */
export function stageMustStartAtOrAfter(
  stage: DraftStage,
  prevStart: number,
  prevDuration: number,
): number {
  if (stage.startMode === "date") {
    return stage.startDate
      ? Math.floor(new Date(stage.startDate).getTime() / 1000)
      : 0;
  }
  const cycles = Number(stage.startCycles) || 1;
  return cycles > 1 ? prevStart + cycles * prevDuration : 0;
}

export function stageStartOk(stage: DraftStage): boolean {
  if (stage.startMode === "date") {
    return !Number.isNaN(new Date(stage.startDate).getTime());
  }
  const n = Number(stage.startCycles);
  return Number.isInteger(n) && n >= 1;
}

/** The stage's duration in seconds (0 = flexible). */
export function stageDurationSeconds(stage: DraftStage): number {
  if (stage.durationValue === "custom") {
    const n = Number(stage.customDuration);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.round(n * UNIT_SECONDS[stage.customUnit]);
  }
  return Number(stage.durationValue) || 0;
}

export function secondsLabel(seconds: number): string {
  if (seconds % 31_536_000 === 0 && seconds >= 31_536_000)
    return `${seconds / 31_536_000} year${seconds === 31_536_000 ? "" : "s"}`;
  if (seconds % 604_800 === 0 && seconds >= 604_800)
    return `${seconds / 604_800} week${seconds === 604_800 ? "" : "s"}`;
  if (seconds % 86_400 === 0 && seconds >= 86_400)
    return `${seconds / 86_400} day${seconds === 86_400 ? "" : "s"}`;
  return `${Math.round(seconds / 360) / 10} hours`;
}

/** Effective cash-out tax out of 10000 (custom % wins when enabled). */
export function stageCashOutTax(stage: DraftStage): number {
  if (stage.taxCustomOn) {
    const n = Number(stage.taxCustomPct);
    if (Number.isFinite(n) && n >= 0 && n <= 99.99) return Math.round(n * 100);
    return 0;
  }
  return stage.cashOutTax;
}

/** The first stage's chosen start in unix seconds, or null for the default start. */
export function scheduledStart(stage: DraftStage): number | null {
  return stage.scheduleOn && stage.schedule
    ? Math.floor(new Date(stage.schedule).getTime() / 1000)
    : null;
}

/** Revnet's own minimum for a chosen start. A start that has passed by the time a
 *  revnet deploys locks cash outs and loans for the delay (REVDeployer CASH_OUT_DELAY). */
export const MIN_START_LEAD_SECONDS = 3_600;

export function scheduledStartOk(stage: DraftStage, nowSeconds: number): boolean {
  const start = scheduledStart(stage);
  return start === null || start >= nowSeconds + MIN_START_LEAD_SECONDS;
}

export function stageTaxOk(stage: DraftStage): boolean {
  if (!stage.taxCustomOn) return true;
  const n = Number(stage.taxCustomPct);
  return Number.isFinite(n) && n >= 0 && n <= 99.99;
}

export function stageIssuanceOk(stage: DraftStage, isFirst: boolean): boolean {
  if (stage.issuanceRate.trim() === "") return !isFirst; // later stages inherit
  return numOk(stage.issuanceRate);
}

export function stageOk(
  stage: DraftStage,
  isFirst: boolean,
  flavor: "project" | "revnet" = "project",
  multiToken = false,
  chainIds?: readonly number[],
): boolean {
  const payoutsMode = stage.routedMode === "all" ? "percent" : "amount";
  const issuanceOk = stageIssuanceOk(stage, isFirst);
  const splitsValid =
    stage.reservedSplits.every((s) => splitOk(s, "percent", chainIds)) &&
    splitsTotal(stage.reservedSplits, "percent") <= 100;
  const common =
    issuanceOk &&
    (stage.cutPct.trim() === "" || numOk(stage.cutPct, 100)) &&
    splitsValid;
  if (flavor === "revnet") {
    return (
      issuanceOk &&
      splitsValid &&
      (!stage.cutOn ||
        (Number(stage.cutPct) > 0 &&
          numOk(stage.cutPct, 100) &&
          Number(stage.cutFreqDays) >= 1 &&
          numOk(stage.cutFreqDays))) &&
      (isFirst || Number(stage.daysAfter) >= 1) &&
      (!stage.cashOuts || stageTaxOk(stage)) &&
      stage.autoIssuances.every(
        (a) =>
          (a.count.trim() === "" && a.address.trim() === "") ||
          (Number(a.count) > 0 && numOk(a.count) && resolvedAddress(a.address) !== null),
      )
    );
  }
  return (
    common &&
    (stage.payouts !== "routed" ||
      (stage.payoutSplits.every((s) => splitOk(s, payoutsMode, chainIds)) &&
        (payoutsMode !== "percent" ||
          splitsTotal(stage.payoutSplits, "percent") <= 100) &&
        (!multiToken ||
          (stage.payoutSplitsUsdc.every((s) =>
            splitOk(s, stage.routedModeUsdc === "all" ? "percent" : "amount", chainIds),
          ) &&
            (stage.routedModeUsdc !== "all" ||
              splitsTotal(stage.payoutSplitsUsdc, "percent") <= 100))))) &&
    (stage.durationValue !== "custom" || stageDurationSeconds(stage) > 0) &&
    (isFirst || stageStartOk(stage)) &&
    (!stage.cashOuts || stageTaxOk(stage)) &&
    (!stage.surplusCapOn ||
      (Number(stage.surplusAmount) > 0 && numOk(stage.surplusAmount)))
  );
}

/**
 * Per accepted token: does this stage route EVERYTHING out (no payout limit)?
 * The input to {@link routesAllFunds} on the draft side — `buildRoutedSplits`
 * maps these modes onto the encoded limits one-for-one ("all" ⇒ no limit,
 * "amounts" ⇒ a limit, zero-valued when no amounts are set), so the editor and
 * the encoder read the same configuration.
 */
export function stageRoutesEverything(
  stage: DraftStage,
  multiToken: boolean,
): boolean[] {
  return multiToken
    ? [stage.routedMode === "all", stage.routedModeUsdc === "all"]
    : [stage.routedMode === "all"];
}

/**
 * A payout token's switch between percent and fixed amounts. One field holds both
 * units, so its numbers are cleared: 20% must never become 20 ETH.
 */
export function routedModePatch(
  stage: DraftStage,
  token: "eth" | "usdc",
  mode: "all" | "amounts",
): Partial<DraftStage> {
  const [modeKey, splitsKey] =
    token === "eth"
      ? (["routedMode", "payoutSplits"] as const)
      : (["routedModeUsdc", "payoutSplitsUsdc"] as const);
  if (stage[modeKey] === mode) return {};
  return {
    [modeKey]: mode,
    [splitsKey]: stage[splitsKey].map((row) => ({
      ...row,
      value: "",
      perChainAmount: {},
    })),
  };
}

/** The auto-issuance rows a launch encodes, each with its one mint chain and beneficiary. */
export function encodedAutoIssuances(
  stage: Pick<DraftStage, "autoIssuances">,
  chainIds: readonly number[],
): { count: string; beneficiary: string; chainId: number }[] {
  return stage.autoIssuances.flatMap((row) => {
    const chainId = autoIssuanceMintChain(chainIds as number[], row.chainId);
    const beneficiary = row.perChain[chainId]?.trim() || row.address;
    return Number(row.count) > 0 && resolvedAddress(beneficiary) !== null
      ? [{ count: row.count, beneficiary, chainId }]
      : [];
  });
}

/** What the launch review needs beyond the stage itself. */
export type StageReview = {
  /** False when ownership goes to the dead address: nobody holds owner permissions. */
  hasOwner: boolean;
  chainIds: readonly number[];
  /** The token payout and withdrawal amounts are encoded in. */
  fundsUnit: string;
};

/** Where the terminal sends what splits leave over (JBMultiTerminal _sendPayoutsOf). */
const leftoverTo = (hasOwner: boolean) =>
  hasOwner ? "the project owner" : "a dead address, where it's lost";

const addressLabel = (value: string) =>
  /^0x/i.test(value.trim()) ? truncateAddress(value.trim()) : value.trim();

function recipientLabel(row: DraftSplit, chainIds: readonly number[]): string {
  const base =
    row.kind === "address"
      ? addressLabel(row.recipient)
      : row.kind === "project"
        ? `Project #${row.projectId.replace("#", "")}${
            row.preferAddToBalance || !row.beneficiary.trim()
              ? ""
              : ` for ${addressLabel(row.beneficiary)}`
          }`
        : isStickyRow(row)
          ? "Sticky holders"
          : row.hookKind === "custom"
            ? `Hook ${addressLabel(row.hookAddress)}`
            : "Market maker";
  return chainIds.some((id) => row.perChain[id]?.trim())
    ? `${base} (varies by chain)`
    : base;
}

function percentRecipients(rows: DraftSplit[], chainIds: readonly number[]): string {
  return rows
    .map((row) => `${Number(row.value)}% to ${recipientLabel(row, chainIds)}`)
    .join(", ");
}

function payoutPart(
  title: string,
  rows: DraftSplit[],
  mode: "all" | "amounts",
  unit: string,
  review: StageReview,
): string {
  if (mode === "all") {
    if (rows.length === 0)
      return `${title}: all funds to ${leftoverTo(review.hasOwner)}`;
    const left = 100 - splitsTotal(rows, "percent");
    return `${title}: ${percentRecipients(rows, review.chainIds)}${
      left > 0 ? `, the rest to ${leftoverTo(review.hasOwner)}` : ""
    }`;
  }
  const total = splitsTotal(rows, "amount");
  if (total === 0) return `${title}: none set`;
  const each = review.chainIds.length > 1 ? " on each chain" : "";
  const varies = rows.some((row) =>
    review.chainIds.some((id) => row.perChainAmount[id]?.trim()),
  )
    ? " (varies by chain)"
    : "";
  return `${title}: up to ${total.toLocaleString("en-US")} ${unit}${each}${varies}, ${rows
    .map((row) => `${Number(row.value).toLocaleString("en-US")} ${unit} to ${recipientLabel(row, review.chainIds)}`)
    .join(", ")}`;
}

/** The fund access limits a project stage encodes (launch.ts fundAccessLimitGroups). */
function fundsParts(stage: DraftStage, multiToken: boolean, review: StageReview): string[] {
  if (stage.payouts === "none") return ["No payouts or withdrawals"];
  const parts =
    stage.payouts !== "routed"
      ? []
      : multiToken
        ? [
            payoutPart("ETH payouts", stage.payoutSplits, stage.routedMode, "ETH", review),
            payoutPart("USDC payouts", stage.payoutSplitsUsdc, stage.routedModeUsdc, "USDC", review),
          ]
        : [payoutPart("Payouts", stage.payoutSplits, stage.routedMode, review.fundsUnit, review)];
  if (!stageWithdrawals(stage, multiToken)) return parts;
  if (!review.hasOwner) return [...parts, "Nobody can withdraw funds"];
  const each = review.chainIds.length > 1 ? " on each chain" : "";
  return [
    ...parts,
    stage.surplusCapOn
      ? `Owner can withdraw up to ${
          multiToken
            ? `${stage.surplusAmount} ETH and ${stage.surplusAmount} USDC`
            : `${stage.surplusAmount} ${review.fundsUnit}`
        }${each}`
      : `Owner can withdraw ${stage.payouts === "routed" ? "remaining" : "all"} funds`,
  ];
}

/** Whether a stage encodes a surplus allowance, the amount only the owner can use. */
function stageWithdrawals(stage: DraftStage, multiToken: boolean): boolean {
  return (
    stage.payouts === "flexible" ||
    (stage.payouts === "routed" &&
      !routesAllFunds(stage.payouts, stageRoutesEverything(stage, multiToken)) &&
      stage.routedSurplusOn)
  );
}

const POWER_LABELS: Record<keyof DraftStage["powers"], string> = {
  setTerminals: "payment contracts",
  setController: "the contract that manages rules",
  terminalMigration: "where funds are held",
  setCustomToken: "the token",
  addAccountingContext: "accepted tokens",
  addPriceFeed: "price sources",
};

function ownerParts(stage: DraftStage): string[] {
  const powers = (Object.keys(POWER_LABELS) as (keyof DraftStage["powers"])[])
    .filter((key) => stage.powers[key])
    .map((key) => POWER_LABELS[key]);
  return [
    ...(stage.ownerMinting ? ["Owner can create tokens without payment"] : []),
    ...(powers.length > 0 ? [`Owner can change ${powers.join(", ")}`] : []),
  ];
}

/** Who can take funds out under these stages. "Payout recipients" counts any token paying out. */
export function launchFundsFact(
  stages: DraftStage[],
  flavor: "project" | "revnet",
  hasOwner: boolean,
  multiToken: boolean,
  itemsRedeem = false,
): string {
  // REVDeployer gives REVLoans the only surplus allowance, and the operator has no way to funds.
  if (flavor === "revnet") return "Token holders, by cashing out or taking loans";
  const routedTokens = (stage: DraftStage): [DraftSplit[], "all" | "amounts"][] =>
    stage.payouts !== "routed"
      ? []
      : multiToken
        ? [[stage.payoutSplits, stage.routedMode], [stage.payoutSplitsUsdc, stage.routedModeUsdc]]
        : [[stage.payoutSplits, stage.routedMode]];
  const routed = stages.flatMap(routedTokens);
  const paysRecipients = routed.some(([rows]) => rows.length > 0);
  const paysOwner = routed.some(([rows, mode]) => mode === "all" && splitsTotal(rows, "percent") < 100);
  const holders = stages.some(
    (stage) => stage.cashOuts && !routesAllFunds(stage.payouts, stageRoutesEverything(stage, multiToken)),
  );
  const who = [
    ...(hasOwner && (paysOwner || stages.some((stage) => stageWithdrawals(stage, multiToken))) ? ["the project owner"] : []),
    ...(paysRecipients ? ["payout recipients"] : []),
    ...(holders ? [itemsRedeem ? "shop item holders" : "token holders"] : []),
    ...(!hasOwner && paysOwner ? ["anyone, to a dead address, where it's lost"] : []),
  ];
  if (who.length === 0)
    return hasOwner
      ? "Nobody, until the owner changes the rules"
      : "Nobody. Funds can't leave the project.";
  const list = who.length === 1 ? who[0] : `${who.slice(0, -1).join(", ")} and ${who[who.length - 1]}`;
  return list[0].toUpperCase() + list.slice(1);
}

/** Summary parts for a stage (website/'s stageSummaryRaw). Pass `review` for the launch
 *  review's full statement of what the stage encodes; cards use the short form. */
/** "after 3 cycles of Ruleset #1" / "on Jan 5, 2027 (snapped to Ruleset #1's cycle)". */
function startLabel(stage: DraftStage, index: number): string {
  if (stage.startMode === "date") {
    return stage.startDate
      ? `Starts ${formatDateTime(Math.floor(new Date(stage.startDate).getTime() / 1000))}, snapped to Ruleset #${index}'s cycle`
      : "Starts on a date";
  }
  const n = Number(stage.startCycles) || 1;
  return `Starts after ${n} cycle${n === 1 ? "" : "s"} of Ruleset #${index}`;
}

export function stageSummaryParts(
  stage: DraftStage,
  index: number,
  unitLabel: string,
  flavor: "project" | "revnet" = "project",
  multiToken = false,
  review?: StageReview,
): string[] {
  const parts: string[] = [];
  if (index === 0) {
    parts.push(
      scheduledStart(stage) !== null
        ? `Starts ${formatDateTime(scheduledStart(stage)!)}`
        : review && flavor === "revnet"
          ? `Starts about ${LAUNCH_START_DELAY_SECONDS / 60} minutes after launch`
          : "Starts at launch",
    );
  } else if (flavor === "revnet") {
    parts.push(
      `Starts ${Number(stage.daysAfter) || "?"} days after Stage #${index}`,
    );
  } else {
    parts.push(startLabel(stage, index));
  }
  const duration = stageDurationSeconds(stage);
  if (flavor !== "revnet")
    parts.push(
      duration === 0
        ? review && !review.hasOwner
          ? "Lasts forever"
          : "Lasts until changed"
        : duration === FOREVER_SECONDS
          ? "Lasts forever"
          : `Lasts ${secondsLabel(duration)}`,
    );
  const cutClause =
    Number(stage.cutPct) > 0 && (flavor !== "revnet" || stage.cutOn)
      ? flavor === "revnet"
        ? `-${Number(stage.cutPct)}% every ${Number(stage.cutFreqDays) || "?"} days`
        : `-${Number(stage.cutPct)}% per cycle`
      : "";
  if (stage.issuanceRate.trim() === "" && index > 0) {
    parts.push("Keeps issuance" + (cutClause ? `, ${cutClause}` : ""));
  } else if (Number(stage.issuanceRate) > 0) {
    parts.push(
      `Issues ${Number(stage.issuanceRate).toLocaleString("en-US")} tokens per ${unitLabel}` +
        (cutClause ? `, ${cutClause}` : ""),
    );
  } else {
    parts.push("No issuance");
  }
  if (review && flavor !== "revnet") {
    if (!stage.acceptPayments) parts.push("Payments paused");
    parts.push(...fundsParts(stage, multiToken, review));
  }
  const splitsPct = splitsTotal(stage.reservedSplits, "percent");
  if (splitsPct > 0) {
    const label =
      flavor === "revnet"
        ? `${splitsPct}% to splits`
        : `${splitsPct}% reserved`;
    parts.push(
      review
        ? `${label}: ${percentRecipients(stage.reservedSplits, review.chainIds)}`
        : label,
    );
  }
  if (review) {
    for (const row of encodedAutoIssuances(stage, review.chainIds)) {
      parts.push(
        `Mints ${Number(row.count).toLocaleString("en-US")} tokens to ${addressLabel(row.beneficiary)}${
          review.chainIds.length > 1 ? ` on ${chainName(row.chainId)}` : ""
        }`,
      );
    }
  }
  // Revnets never encode payout limits. Imported drafts may still carry an
  // old project payout mode, but it must not leak into a revnet summary and
  // falsely imply that cash outs are unavailable.
  const routedAll = flavor === "revnet"
    ? false
    : routesAllFunds(
        stage.payouts,
        stageRoutesEverything(stage, multiToken),
      );
  if (flavor === "revnet") {
    parts.push(
      stage.cashOuts
        ? `${cashOutTaxValue(stageCashOutTax(stage))} cash out tax`
        : `${cashOutTaxValue(CASH_OUTS_OFF_REVNET)} cash out tax`,
    );
  } else if (routedAll) {
    parts.push("Cash outs off, all funds can be paid out");
  } else if (stage.cashOuts) {
    parts.push(`${cashOutTaxValue(stageCashOutTax(stage))} cash out tax`);
  } else {
    parts.push("Cash outs off");
  }
  if (review?.hasOwner && flavor !== "revnet") parts.push(...ownerParts(stage));
  return parts;
}

/** One-line stage card summary. */
export function stageSummary(
  stage: DraftStage,
  index: number,
  unitLabel: string,
  flavor: "project" | "revnet" = "project",
  multiToken = false,
): string {
  return stageSummaryParts(stage, index, unitLabel, flavor, multiToken).join(
    " | ",
  );
}
