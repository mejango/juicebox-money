import { FOREVER_SECONDS, routesAllFunds } from "@/lib/launch";
import { resolvedAddress } from "@/lib/ens";
import { splitOk, splitsTotal, type DraftSplit } from "./SplitsEditor";

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

export function stageTaxOk(stage: DraftStage): boolean {
  if (!stage.taxCustomOn) return true;
  const n = Number(stage.taxCustomPct);
  return Number.isFinite(n) && n >= 0 && n <= 99.99;
}

export const numOk = (value: string, max = Infinity) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= max;
};

export function stageIssuanceOk(stage: DraftStage, isFirst: boolean): boolean {
  if (stage.issuanceRate.trim() === "") return !isFirst; // later stages inherit
  return numOk(stage.issuanceRate);
}

export function stageOk(
  stage: DraftStage,
  isFirst: boolean,
  flavor: "project" | "revnet" = "project",
  multiToken = false,
): boolean {
  const payoutsMode = stage.routedMode === "all" ? "percent" : "amount";
  const issuanceOk = stageIssuanceOk(stage, isFirst);
  const splitsValid =
    stage.reservedSplits.every((s) => splitOk(s, "percent")) &&
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
          (Number(a.count) > 0 && resolvedAddress(a.address) !== null),
      )
    );
  }
  return (
    common &&
    (stage.payouts !== "routed" ||
      (stage.payoutSplits.every((s) => splitOk(s, payoutsMode)) &&
        (payoutsMode !== "percent" ||
          splitsTotal(stage.payoutSplits, "percent") <= 100) &&
        (!multiToken ||
          (stage.payoutSplitsUsdc.every((s) =>
            splitOk(s, stage.routedModeUsdc === "all" ? "percent" : "amount"),
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

/** Summary parts for a stage (website/'s stageSummaryRaw). */
/** "after 3 cycles of Ruleset #1" / "on Jan 5, 2027 (snapped to Ruleset #1's cycle)". */
function startLabel(stage: DraftStage, index: number): string {
  if (stage.startMode === "date") {
    return stage.startDate
      ? `Starts ${new Date(stage.startDate).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}, snapped to Ruleset #${index}'s cycle`
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
): string[] {
  const parts: string[] = [];
  if (index === 0) {
    parts.push(
      stage.scheduleOn && stage.schedule
        ? "Starts at a set time"
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
        ? "Lasts until changed"
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
      `Issues ${Number(stage.issuanceRate).toLocaleString("en-US")} per ${unitLabel}` +
        (cutClause ? `, ${cutClause}` : ""),
    );
  } else {
    parts.push("No issuance");
  }
  const splitsPct = splitsTotal(stage.reservedSplits, "percent");
  if (splitsPct > 0)
    parts.push(
      flavor === "revnet"
        ? `${splitsPct}% to splits`
        : `${splitsPct}% reserved`,
    );
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
        ? `${stageCashOutTax(stage) / 100}% cash out tax`
        : "99.99% cash out tax",
    );
  } else if (stage.cashOuts && !routedAll) {
    parts.push("Cash outs on");
  }
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
