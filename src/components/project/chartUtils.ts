import {
  resolveRulesetIssuanceStages,
  rulesetIssuanceRateAt,
  type ResolvedRulesetIssuanceStage,
  type RulesetIssuanceStage,
} from "@bananapus/nana-sdk-core/v6";

/**
 * Shared projection math + formatting for the issuance/price schedule charts.
 * Mirrors website/'s issuanceAtTime + priceChartTimeBounds (projection branch):
 * within a stage the rate (weight / 1e18, tokens per base unit) cuts by
 * weightCutPercent (1e9 scale) once per elapsed `duration`; duration 0 never
 * cycles. Pure client math — no fetching.
 */

export type ChartStage = RulesetIssuanceStage;

export type ResolvedStage = ResolvedRulesetIssuanceStage;

const YEAR = 365 * 86400;

export const CHART_RANGES: { label: string; years: number }[] = [
  { label: "1 year", years: 1 },
  { label: "5 years", years: 5 },
  { label: "10 years", years: 10 },
  { label: "All", years: 0 },
];

/**
 * Sort stages and resolve each one's starting rate. Stored on-chain rulesets
 * must leave `inheritsWeight` unset: their weights are already resolved and a
 * stored zero is genuine zero issuance.
 */
export function resolveStages(stages: ChartStage[]): ResolvedStage[] {
  return resolveRulesetIssuanceStages(stages);
}

/** Issuance rate (tokens per base unit) at time t across the schedule. */
export function rateAtTime(resolved: ResolvedStage[], t: number): number {
  return rulesetIssuanceRateAt(resolved, t);
}

/**
 * Forward-looking window: t0 = min(first stage start, now). 1Y/5Y/10Y look
 * `years` ahead of now; All runs to the last stage's start plus a year, kept
 * between 1 and 10 years ahead (the final stage runs forever).
 */
export function timeBounds(
  resolved: ResolvedStage[],
  now: number,
  years: number,
): { t0: number; t1: number } {
  const first = resolved[0]?.start ?? now;
  const last = resolved[resolved.length - 1]?.start ?? now;
  const t0 = Math.min(first, now);
  let t1 =
    years > 0
      ? now + years * YEAR
      : Math.min(Math.max(last + YEAR, now + YEAR), now + 10 * YEAR);
  if (t1 <= t0) t1 = t0 + YEAR;
  return { t0, t1 };
}

/**
 * [t, rate] step points across [t0, t1]: exact cycle-boundary steps when the
 * window holds a plottable number of cuts, else a uniform 480-point sample
 * (dense schedules read as a curve either way).
 */
export function buildStepPoints(
  resolved: ResolvedStage[],
  t0: number,
  t1: number,
): [number, number][] {
  if (resolved.length === 0) return [];
  // Keep a full two-year daily schedule discrete (730/731 boundaries).
  // Falling back to uniform sampling here made small real cuts look flat.
  const MAX_BREAKS = 2_000;
  const breaks: number[] = [];
  let dense = false;
  for (let i = 0; i < resolved.length; i++) {
    const s = resolved[i];
    const end = Math.min(resolved[i + 1]?.start ?? t1, t1);
    const from = Math.max(s.start, t0);
    if (end <= from) continue;
    if (s.start > t0 && s.start < t1) breaks.push(s.start);
    if (s.duration > 0 && s.weightCutPercent > 0) {
      if ((end - from) / s.duration > MAX_BREAKS) {
        dense = true;
        break;
      }
      const k0 = Math.max(1, Math.ceil((from - s.start) / s.duration));
      for (let k = k0; s.start + k * s.duration < end; k++) {
        const t = s.start + k * s.duration;
        if (t > t0 && t < t1) breaks.push(t);
      }
    }
  }
  if (dense || breaks.length > MAX_BREAKS) {
    const N = 480;
    return Array.from({ length: N + 1 }, (_, i) => {
      const t = t0 + ((t1 - t0) * i) / N;
      return [t, rateAtTime(resolved, t)] as [number, number];
    });
  }
  const edges = [t0, ...breaks.sort((a, b) => a - b), t1];
  const pts: [number, number][] = [];
  for (let i = 0; i + 1 < edges.length; i++) {
    const v = rateAtTime(resolved, edges[i]);
    pts.push([edges[i], v], [edges[i + 1], v]);
  }
  return pts;
}

/** "6,250" / "1.25" / "0.00420" — issuance rates. */
export function formatRate(n: number): string {
  if (!isFinite(n)) return "—";
  if (n === 0) return "0";
  if (n >= 1000) {
    const decimals = Math.abs(n - Math.round(n)) < 1e-9 ? 0 : 2;
    return n.toLocaleString("en-US", {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
  }
  if (n >= 1) return n.toFixed(2).replace(/\.?0+$/, "");
  return n.toPrecision(3);
}

/** Prices (base units per token) trimmed for small numbers. */
export function formatPrice(n: number): string {
  if (!isFinite(n) || n <= 0) return "0";
  if (n >= 1000) return Math.round(n).toLocaleString("en-US");
  if (n >= 1) return n.toFixed(2);
  if (n >= 0.001) return n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  return n.toPrecision(5);
}

/** Span-aware date: "Jan 5, 2027" under two years of span, "Jan 2027" beyond. */
export function chartDateLabel(ts: number, span: number): string {
  const d = new Date(ts * 1000);
  if (span < 2 * YEAR) {
    return d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }
  return d.toLocaleDateString("en-US", { month: "short", year: "numeric" });
}
