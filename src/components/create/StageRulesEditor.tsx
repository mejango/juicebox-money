"use client";

import Link from "next/link";
import {
  CASH_OUTS_OFF_REVNET,
  FOREVER_SECONDS,
  autoIssuanceMintChain,
  routesAllFunds,
} from "@/lib/launch";
import { CashOutCurve } from "./CashOutCurve";
import {
  SplitsEditor,
  splitOk,
  splitsTotal,
} from "./SplitsEditor";
import { AddButton, CheckRow, ChipButton, OptionRow, SubSection } from "./ui";
import { AddressField } from "./AddressField";
import { DateTimeField } from "@/components/ui/DateTimeField";
import { ChainSelect } from "@/components/ChainSelect";

import {
  numOk,
  secondsLabel,
  stageCashOutTax,
  stageDurationSeconds,
  stageIssuanceOk,
  stageRoutesEverything,
  stageStartOk,
  stageTaxOk,
  type DraftStage,
} from "./stage-draft";
export {
  newDraftStage,
  stageMustStartAtOrAfter,
  stageStartOk,
  type DraftStage,
} from "./stage-draft";

const DURATION_PRESETS: [number, string][] = [
  [86_400, "1 day"],
  [3 * 86_400, "3 days"],
  [7 * 86_400, "7 days"],
  [14 * 86_400, "14 days"],
  [28 * 86_400, "28 days"],
  [30 * 86_400, "30 days"],
  [90 * 86_400, "90 days"],
  [365 * 86_400, "365 days"],
];

const CASH_OUT_TAXES = [
  { rate: 0, label: "No tax" },
  { rate: 1000, label: "10% tax" },
  { rate: 3000, label: "30% tax" },
  { rate: 5000, label: "50% tax" },
] as const;

/** Off/On cash-out choice plus the tax picker shown while cash outs are on. */
function TaxPicker({
  stage,
  set,
  disabled,
  offBlurb,
  onBlurb,
  required = false,
}: {
  stage: DraftStage;
  set: (patch: Partial<DraftStage>) => void;
  disabled: boolean;
  offBlurb: string;
  onBlurb: string;
  required?: boolean;
}) {
  const cashOutsOn = required || stage.cashOuts;
  return (
    <>
      {required ? (
        <p className="text-xs leading-relaxed text-smoke-700">{onBlurb}</p>
      ) : (
        <div className="space-y-2">
          <OptionRow
            checked={!stage.cashOuts}
            onSelect={() => set({ cashOuts: false })}
            disabled={disabled}
            title="Off"
            blurb={offBlurb}
          />
          <OptionRow
            checked={stage.cashOuts}
            onSelect={() => set({ cashOuts: true })}
            disabled={disabled}
            title="On"
            blurb={onBlurb}
          />
        </div>
      )}
      {cashOutsOn ? (
        <>
          <p className="mt-2 text-xs leading-relaxed text-smoke-700">
            A cash out tax leaves part of a partial cash out for holders who stay.
            It sets a curve, so a 10% setting does not simply subtract 10%.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {CASH_OUT_TAXES.map((tax) => (
              <ChipButton
                key={tax.rate}
                active={
                  stage.cashOuts &&
                  !stage.taxCustomOn &&
                  stage.cashOutTax === tax.rate
                }
                onClick={() =>
                  set({
                    cashOuts: true,
                    cashOutTax: tax.rate,
                    taxCustomOn: false,
                  })
                }
                disabled={disabled}
              >
                {tax.label}
              </ChipButton>
            ))}
            <ChipButton
              active={stage.taxCustomOn}
              onClick={() => set({ cashOuts: true, taxCustomOn: true })}
              disabled={disabled}
            >
              Custom…
            </ChipButton>
          </div>
          {stage.taxCustomOn ? (
            <div className="mt-2 flex items-center gap-2.5">
              <input
                type="text"
                inputMode="decimal"
                value={stage.taxCustomPct}
                onChange={(e) =>
                  set({
                    cashOuts: true,
                    taxCustomPct: e.target.value.slice(0, 5),
                  })
                }
                disabled={disabled}
                placeholder="15"
                className={`input-well min-h-[40px] w-20 px-3 text-sm tabular-nums disabled:opacity-60 ${
                  stageTaxOk(stage) ? "" : "!border-red-400"
                }`}
              />
              <span className="text-sm text-smoke-700">
                % tax (up to 99.99)
              </span>
            </div>
          ) : null}
          <CashOutCurve
            rate={stage.cashOuts ? stageCashOutTax(stage) : CASH_OUTS_OFF_REVNET}
          />
        </>
      ) : null}
    </>
  );
}

export function StageRulesEditor({
  stage,
  onChange,
  isFirst,
  isLast,
  index,
  prevDuration = 0,
  unitLabel,
  unitChoice,
  disabled,
  chainIds,
  flavor,
  tokenLabel,
  multiToken,
}: {
  stage: DraftStage;
  onChange: (stage: DraftStage) => void;
  isFirst: boolean;
  isLast: boolean;
  index: number;
  /** Previous ruleset's duration in seconds (0 = flexible); reminds the user what a cycle is. */
  prevDuration?: number;
  unitLabel: string;
  /** When set, the issuance unit is a choice (ETH/USD) picked inline. */
  unitChoice?: {
    value: "eth" | "usd";
    onChange: (value: "eth" | "usd") => void;
  };
  disabled: boolean;
  /** Selected launch chains (enables per-chain recipient overrides). */
  chainIds: number[];
  flavor: "project" | "revnet";
  /** "$TICK" when a ticker is set, else "tokens". */
  tokenLabel: string;
  /** ETH+USDC accounting: payouts configure per token. */
  multiToken: boolean;
}) {
  const isRevnet = flavor === "revnet";
  const set = (patch: Partial<DraftStage>) => onChange({ ...stage, ...patch });
  const toggleOpen = (key: string) =>
    set({ open: { ...stage.open, [key]: !stage.open[key] } });

  const duration = stageDurationSeconds(stage);
  const reservedPercent = splitsTotal(stage.reservedSplits, "percent");
  const reservedOn = reservedPercent > 0;
  const payoutsMode = stage.routedMode === "all" ? "percent" : "amount";
  const routedAll = isRevnet
    ? false
    : routesAllFunds(
        stage.payouts,
        stageRoutesEverything(stage, multiToken),
      );
  const issuanceOk = stageIssuanceOk(stage, isFirst);

  const timingSummary = isRevnet
    ? isFirst
      ? stage.scheduleOn && stage.schedule
        ? "Scheduled"
        : "At launch"
      : `${Number(stage.daysAfter) || "?"}d after Stage #${index}`
    : `${
        isFirst
          ? stage.scheduleOn && stage.schedule
            ? "Scheduled"
            : "At launch"
          : stage.startMode === "date"
            ? `On a date`
            : `After ${Number(stage.startCycles) || 1}× Ruleset #${index}`
      } | ${
        duration === 0
          ? "flexible"
          : duration === FOREVER_SECONDS
            ? "forever"
            : secondsLabel(duration)
      }`;

  const tokensSummary = issuanceOk
    ? `${
        stage.issuanceRate.trim() === "" && !isFirst
          ? "Keeps rate"
          : `${Number(stage.issuanceRate || "0").toLocaleString("en-US")} per ${unitLabel}`
      }${reservedOn ? ` | ${reservedPercent}% reserved` : ""}${
        Number(stage.cutPct) > 0 ? ` | -${Number(stage.cutPct)}% per cycle` : ""
      }`
    : "—";

  const validPayoutSplits = stage.payoutSplits.filter((s) =>
    splitOk(s, payoutsMode),
  ).length;
  const payoutsSummary =
    (stage.payouts === "none"
      ? "Funds stay in the project"
      : stage.payouts === "flexible"
        ? `Flexible withdrawals${stage.surplusCapOn ? " (capped)" : ""}`
        : validPayoutSplits === 0
          ? stage.routedMode === "all"
            ? "Routing all funds to the project owner"
            : "No payout amounts set"
          : stage.routedMode === "all"
            ? `Routing all funds to ${validPayoutSplits} recipient${validPayoutSplits === 1 ? "" : "s"}`
            : `Routing ${splitsTotal(stage.payoutSplits, "amount").toLocaleString("en-US")} ${unitLabel} to ${validPayoutSplits} recipient${validPayoutSplits === 1 ? "" : "s"}`) +
    (stage.payouts !== "none" && stage.holdFees ? " | fees held" : "");

  const cashOutsSummary = routedAll
    ? "Off — all funds committed to payouts"
    : isRevnet && !stage.cashOuts
      ? "On | 99.99% tax"
      : stage.cashOuts
      ? `On | ${stageCashOutTax(stage) === 0 ? "no tax" : `${stageCashOutTax(stage) / 100}% tax`}`
      : "Off";

  return (
    <div>
      {/* Timing */}
      <SubSection
        label="Timing"
        summary={timingSummary}
        open={!!stage.open.timing}
        onToggle={() => toggleOpen("timing")}
      >
        {isFirst ? (
          <div className="mb-3">
            <CheckRow
              checked={!stage.scheduleOn}
              onToggle={() => set({ scheduleOn: !stage.scheduleOn })}
              disabled={disabled}
              title="Launch right away"
              blurb="Rules take effect the moment your project deploys. Uncheck to schedule a start time."
            />
            {stage.scheduleOn ? (
              <DateTimeField
                value={stage.schedule}
                onChange={(schedule) => set({ schedule })}
                disabled={disabled}
                ariaLabel="Project launch date and time"
                wrapperClassName="mt-2"
                inputClassName="input-well min-h-[44px] w-full px-3.5 text-sm disabled:opacity-60"
              />
            ) : null}
          </div>
        ) : null}

        {isRevnet && !isFirst ? (
          <div>
            <span className="field-label">Starts</span>
            <div className="mt-2 flex flex-wrap items-center gap-2.5">
              <input
                type="text"
                inputMode="numeric"
                value={stage.daysAfter}
                onChange={(e) => set({ daysAfter: e.target.value.slice(0, 5) })}
                disabled={disabled}
                className={`input-well min-h-[44px] w-20 px-3 text-sm tabular-nums disabled:opacity-60 ${
                  Number(stage.daysAfter) >= 1 ? "" : "!border-red-400"
                }`}
              />
              <span className="text-sm text-smoke-700">
                days after Stage #{index} begins
              </span>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-smoke-700">
              Stage changes land on issuance-cut boundaries, so the start snaps
              to the previous stage&apos;s cut cycle.
            </p>
          </div>
        ) : null}
        {isRevnet ? null : (
          <>
            {isFirst ? null : (
              <div className="mb-3">
                <span className="field-label">Starts</span>
                <div className="mt-2 flex flex-wrap items-center gap-2.5">
                  <select
                    value={stage.startMode}
                    onChange={(e) =>
                      set({
                        startMode: e.target.value as DraftStage["startMode"],
                      })
                    }
                    disabled={disabled}
                    className="input-well select-caret min-h-[44px] w-36 px-3.5 pr-9 text-sm disabled:opacity-60"
                  >
                    <option value="cycles">After</option>
                    <option value="date">On a date</option>
                  </select>
                  {stage.startMode === "cycles" ? (
                    <>
                      <input
                        type="text"
                        inputMode="numeric"
                        value={stage.startCycles}
                        onChange={(e) =>
                          set({ startCycles: e.target.value.slice(0, 5) })
                        }
                        disabled={disabled}
                        className={`input-well min-h-[44px] w-20 px-3 text-sm tabular-nums disabled:opacity-60 ${
                          stageStartOk(stage) ? "" : "!border-red-400"
                        }`}
                      />
                      <span className="text-sm text-smoke-700">
                        cycle{Number(stage.startCycles) === 1 ? "" : "s"} of
                        Ruleset #{index}
                        {prevDuration > 0
                          ? ` (${secondsLabel(prevDuration)} each)`
                          : ""}
                      </span>
                    </>
                  ) : (
                    <DateTimeField
                      value={stage.startDate}
                      onChange={(startDate) => set({ startDate })}
                      disabled={disabled}
                      ariaLabel={`Ruleset #${index + 1} start date and time`}
                      inputClassName="input-well min-h-[44px] px-3.5 text-sm disabled:opacity-60"
                    />
                  )}
                </div>
                <p className="mt-2 text-xs leading-relaxed text-smoke-700">
                  {stage.startMode === "cycles"
                    ? `Ruleset #${index} repeats that many times, then these rules take over${
                        prevDuration > 0
                          ? ` — ${secondsLabel((Number(stage.startCycles) || 1) * prevDuration)} after Ruleset #${index} starts`
                          : ""
                      }.`
                    : `Rule changes land on cycle boundaries, so the start snaps to Ruleset #${index}'s first cycle ending at or after this date.`}
                </p>
              </div>
            )}
            <div className="mb-3">
              <CheckRow
                checked={stage.acceptPayments}
                onToggle={() => set({ acceptPayments: !stage.acceptPayments })}
                disabled={disabled}
                title="Accept payments"
                blurb="Uncheck to pause payments (and token issuance) for this ruleset — useful for a deliberate quiet period."
              />
            </div>
            <span className="field-label">Duration</span>
            <p className="mt-1 text-xs leading-relaxed text-smoke-700">
              How long these rules run. Flexible rules last until the project
              owner changes them; a fixed duration locks them in, and the next
              ruleset starts when it ends.
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2.5">
              <select
                value={stage.durationValue}
                onChange={(e) => set({ durationValue: e.target.value })}
                disabled={disabled}
                className="input-well select-caret min-h-[44px] w-44 px-3.5 pr-9 text-sm disabled:opacity-60"
              >
                <option value="0">Flexible</option>
                {DURATION_PRESETS.map(([seconds, label]) => (
                  <option key={seconds} value={String(seconds)}>
                    {label}
                  </option>
                ))}
                <option value={String(FOREVER_SECONDS)}>Forever</option>
                <option value="custom">Custom…</option>
              </select>
              {stage.durationValue === "custom" ? (
                <>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={stage.customDuration}
                    onChange={(e) =>
                      set({ customDuration: e.target.value.slice(0, 6) })
                    }
                    disabled={disabled}
                    placeholder="30"
                    className={`input-well min-h-[44px] w-20 px-3 text-sm tabular-nums disabled:opacity-60 ${
                      stageDurationSeconds(stage) > 0 ? "" : "!border-red-400"
                    }`}
                  />
                  <select
                    value={stage.customUnit}
                    onChange={(e) =>
                      set({
                        customUnit: e.target.value as DraftStage["customUnit"],
                      })
                    }
                    disabled={disabled}
                    className="input-well select-caret min-h-[44px] w-28 px-3 pr-9 text-sm disabled:opacity-60"
                  >
                    {(["hours", "days", "weeks", "years"] as const).map(
                      (unit) => (
                        <option key={unit} value={unit}>
                          {unit}
                        </option>
                      ),
                    )}
                  </select>
                </>
              ) : null}
            </div>
            {!isLast && duration === 0 ? (
              <p className="mt-2 text-xs text-red-600">
                Give this ruleset a duration — the next ruleset needs to know
                when to start.
              </p>
            ) : null}
          </>
        )}
      </SubSection>

      {/* Issuance */}
      <SubSection
        label="New tokens"
        summary={tokensSummary}
        open={!!stage.open.tokens}
        onToggle={() => toggleOpen("tokens")}
      >
        <p className="text-xs leading-relaxed text-smoke-700">
          Set how many new {tokenLabel} each payment creates. This is the
          issuance rate. You can set aside a share for chosen recipients;
          payers receive the rest. The cash out rules below decide whether
          holders can exchange {tokenLabel} for project funds.
          {!isFirst
            ? " Leave the rate empty to keep the previous ruleset’s rate."
            : ""}
        </p>
        <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-2">
          <input
            type="text"
            inputMode="decimal"
            value={stage.issuanceRate}
            onChange={(e) => set({ issuanceRate: e.target.value.slice(0, 15) })}
            disabled={disabled}
            placeholder={isFirst ? "10000" : "Keep rate"}
            className={`input-well min-h-[44px] w-36 px-3.5 text-sm tabular-nums disabled:opacity-60 ${
              issuanceOk ? "" : "!border-red-400"
            }`}
          />
          {unitChoice && isFirst ? (
            <span className="flex items-center gap-2 whitespace-nowrap text-sm text-smoke-700">
              {tokenLabel} per
              <select
                value={unitChoice.value}
                onChange={(e) =>
                  unitChoice.onChange(e.target.value as "eth" | "usd")
                }
                disabled={disabled}
                aria-label="Issuance priced in"
                className="select-caret input-well min-h-[44px] pl-3 pr-8 text-sm disabled:opacity-60"
              >
                <option value="eth">ETH</option>
                <option value="usd">USD</option>
              </select>
            </span>
          ) : (
            <span className="whitespace-nowrap text-sm text-smoke-700">
              {tokenLabel} per {unitLabel}
            </span>
          )}
        </div>
        {isRevnet ? (
          <div className="mt-3">
            <CheckRow
              checked={stage.cutOn}
              onToggle={() => set({ cutOn: !stage.cutOn })}
              disabled={disabled}
              title="Automatic cuts"
              blurb="Lower the rate by a set percentage on a schedule. The same payment then creates fewer tokens."
            />
            {stage.cutOn ? (
              <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
                <span className="text-sm text-smoke-700">cut</span>
                <input
                  type="text"
                  inputMode="decimal"
                  value={stage.cutPct}
                  onChange={(e) => set({ cutPct: e.target.value.slice(0, 5) })}
                  disabled={disabled}
                  placeholder="10"
                  className={`input-well min-h-[44px] w-20 px-3.5 text-sm tabular-nums disabled:opacity-60 ${
                    Number(stage.cutPct) > 0 && numOk(stage.cutPct, 100)
                      ? ""
                      : "!border-red-400"
                  }`}
                />
                <span className="text-sm text-smoke-700">% every</span>
                <input
                  type="text"
                  inputMode="numeric"
                  value={stage.cutFreqDays}
                  onChange={(e) =>
                    set({ cutFreqDays: e.target.value.slice(0, 5) })
                  }
                  disabled={disabled}
                  className={`input-well min-h-[44px] w-20 px-3.5 text-sm tabular-nums disabled:opacity-60 ${
                    Number(stage.cutFreqDays) >= 1 ? "" : "!border-red-400"
                  }`}
                />
                <span className="text-sm text-smoke-700">days</span>
              </div>
            ) : null}
          </div>
        ) : duration > 0 && duration !== FOREVER_SECONDS ? (
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
            <input
              type="text"
              inputMode="decimal"
              value={stage.cutPct}
              onChange={(e) => set({ cutPct: e.target.value.slice(0, 5) })}
              disabled={disabled}
              placeholder="0"
              className={`input-well min-h-[44px] w-20 px-3.5 text-sm tabular-nums disabled:opacity-60 ${
                stage.cutPct.trim() === "" || numOk(stage.cutPct, 100)
                  ? ""
                  : "!border-red-400"
              }`}
            />
            <span className="text-sm text-smoke-700">
              % fewer new tokens each time the rules repeat
            </span>
          </div>
        ) : null}
        {isRevnet ? (
          <div className="mt-4">
            {stage.reservedSplits.length > 0 ? (
              <p className="text-xs leading-relaxed text-smoke-700">
                Each recipient gets a share of new {tokenLabel}; the rest
                go to the payer.
              </p>
            ) : null}
            <SplitsEditor
              splits={stage.reservedSplits}
              onChange={(reservedSplits) => set({ reservedSplits })}
              disabled={disabled}
              bucketLabel={`new ${tokenLabel}`}
              remainderNote="go to payers"
              chainIds={chainIds}
              addLabel="Add recipient"
              allocatedLabel="set aside"
              allowHook
              allowFundMarket
            />
            <div className="mt-5 border-t border-smoke-200 pt-4">
              <span className="field-label">Tokens without payment</span>
              <p className="mt-1 text-xs leading-relaxed text-smoke-700">
                Set aside {tokenLabel} for named wallets, without a payment.
                Anyone can create these tokens for the recipients once the stage
                starts. This is called auto-issuance.
                {chainIds.length > 1
                  ? " Each mint happens once for the whole launch, on the chain you pick per row."
                  : ""}
              </p>
              {stage.autoIssuances.map((row) => (
                <div
                  key={row.id}
                  className="mt-2 rounded-lg border border-smoke-200 bg-smoke-75 p-3"
                >
                  <div className="grid gap-3 sm:grid-cols-[10rem_minmax(0,1fr)]">
                    <label>
                      <span className="mb-1 block text-[11px] font-medium text-smoke-700">
                        Amount
                      </span>
                      <div className="relative">
                        <input
                          type="text"
                          inputMode="decimal"
                          value={row.count}
                          onChange={(e) =>
                            set({
                              autoIssuances: stage.autoIssuances.map((a) =>
                                a.id === row.id
                                  ? { ...a, count: e.target.value.slice(0, 15) }
                                  : a,
                              ),
                            })
                          }
                          disabled={disabled}
                          placeholder="1000"
                          aria-label="Auto-issuance amount"
                          className="input-well min-h-[44px] w-full px-3 pr-12 text-sm tabular-nums disabled:opacity-60"
                        />
                        <span className="pointer-events-none absolute right-3 top-1/2 max-w-10 -translate-y-1/2 truncate text-xs text-smoke-500">
                          {tokenLabel}
                        </span>
                      </div>
                    </label>
                    <div>
                      <span className="mb-1 block text-[11px] font-medium text-smoke-700">
                        Beneficiary
                      </span>
                      <AddressField
                        value={row.address}
                        onChange={(v) =>
                          set({
                            autoIssuances: stage.autoIssuances.map((a) =>
                              a.id === row.id ? { ...a, address: v } : a,
                            ),
                          })
                        }
                        disabled={disabled}
                        ariaLabel="Auto-issuance beneficiary"
                      />
                    </div>
                  </div>
                  {chainIds.length > 1 ? (
                    <div className="mt-3 max-w-sm">
                      <span className="mb-1 block text-[11px] font-medium text-smoke-700">
                        Mint once on
                      </span>
                      <ChainSelect
                        options={chainIds}
                        value={autoIssuanceMintChain(chainIds, row.chainId)}
                        onChange={(chainId) =>
                          set({
                            autoIssuances: stage.autoIssuances.map((a) =>
                              a.id === row.id
                                ? { ...a, chainId }
                                : a,
                            ),
                          })
                        }
                        disabled={disabled}
                      />
                    </div>
                  ) : null}
                  <button
                    onClick={() =>
                      set({
                        autoIssuances: stage.autoIssuances.filter(
                          (a) => a.id !== row.id,
                        ),
                      })
                    }
                    disabled={disabled}
                    aria-label="Remove auto-issuance"
                    className="mt-3 inline-flex min-h-[36px] items-center text-xs font-medium text-smoke-700 underline underline-offset-2 hover:text-ink disabled:opacity-60"
                  >
                    Remove
                  </button>
                </div>
              ))}
              <div className="mt-2">
                <AddButton
                  onClick={() =>
                    set({
                      autoIssuances: [
                        ...stage.autoIssuances,
                        {
                          id: crypto.randomUUID(),
                          count: "",
                          address: "",
                          chainId: null,
                          perChain: {},
                        },
                      ],
                    })
                  }
                  disabled={disabled}
                >
                  Add auto-issuance
                </AddButton>
              </div>
            </div>
          </div>
        ) : (
          <div className="mt-4">
            {reservedOn ? (
              <p className="text-xs leading-relaxed text-smoke-700">
                Each recipient gets a percentage of new {tokenLabel}.
                These percentages add up to the total set aside.
              </p>
            ) : null}
            <SplitsEditor
              splits={stage.reservedSplits}
              onChange={(reservedSplits) =>
                set({
                  reservedSplits,
                  reservedPct: String(splitsTotal(reservedSplits, "percent")),
                })
              }
              disabled={disabled}
              bucketLabel={`new ${tokenLabel}`}
              remainderNote="go to payers"
              chainIds={chainIds}
              addLabel="Add recipient"
              allocatedLabel="set aside"
              allowHook
              allowFundMarket
              allowLock={duration > 0 && duration !== FOREVER_SECONDS}
            />
          </div>
        )}
      </SubSection>

      {/* Payouts (owner-managed money never applies to revnets) */}
      {isRevnet ? null : (
        <SubSection
          label="Payouts"
          summary={payoutsSummary}
          open={!!stage.open.payouts}
          onToggle={() => toggleOpen("payouts")}
        >
          <p className="text-xs leading-relaxed text-smoke-700">
            Set who can receive project funds. These transfers are payouts.
            Funds beyond the unused payout budget can back cash outs.
            The payout budget resets each time the rules repeat.
          </p>
          <div className="mt-3 space-y-2">
            <OptionRow
              checked={stage.payouts === "none"}
              onSelect={() => set({ payouts: "none" })}
              disabled={disabled}
              title="Keep funds in the project"
              blurb="No payouts or owner withdrawals until the rules change."
            />
            <OptionRow
              checked={stage.payouts === "flexible"}
              onSelect={() => set({ payouts: "flexible" })}
              disabled={disabled}
              title="Flexible withdrawals"
              blurb="Let the owner withdraw project funds, up to any limit you set below."
            />
            <OptionRow
              checked={stage.payouts === "routed"}
              onSelect={() => set({ payouts: "routed" })}
              disabled={disabled}
              title="Pay chosen recipients"
              blurb="Set who receives payouts. Anyone can send the transaction that pays them."
            />
          </div>
          {stage.payouts === "routed" ? (
            <div className="mt-3">
              {multiToken ? (
                <span className="field-label">ETH payouts</span>
              ) : null}
              <div className="mt-1 flex flex-wrap gap-2">
                <ChipButton
                  active={stage.routedMode === "all"}
                  onClick={() => set({ routedMode: "all" })}
                  disabled={disabled}
                >
                  Split all funds by %
                </ChipButton>
                <ChipButton
                  active={stage.routedMode === "amounts"}
                  onClick={() => set({ routedMode: "amounts" })}
                  disabled={disabled}
                >
                  Fixed {unitLabel} amounts
                </ChipButton>
              </div>
              <p className="mt-2 text-xs leading-relaxed text-smoke-700">
                {stage.routedMode === "all"
                  ? "All funds are available for payouts, divided by these percentages."
                  : `Each recipient gets up to their ${unitLabel} amount. Funds beyond the unused budget stay available for cash outs.`}
              </p>
              <SplitsEditor
                splits={stage.payoutSplits}
                onChange={(payoutSplits) => set({ payoutSplits })}
                disabled={disabled}
                bucketLabel="payouts"
                mode={payoutsMode}
                amountLabel={unitLabel}
                chainIds={chainIds}
                allowHook
                showRouting
                allowLock={duration > 0 && duration !== FOREVER_SECONDS}
              />
              {stage.payoutSplits.length === 0 ? (
                <p className="mt-2 text-xs text-smoke-700">
                  No recipients yet — payouts go to the project owner.
                </p>
              ) : null}

              {multiToken ? (
                <div className="mt-5 border-t border-smoke-200 pt-4">
                  <span className="field-label">USDC payouts</span>
                  <div className="mt-1 flex flex-wrap gap-2">
                    <ChipButton
                      active={stage.routedModeUsdc === "all"}
                      onClick={() => set({ routedModeUsdc: "all" })}
                      disabled={disabled}
                    >
                      Split all funds by %
                    </ChipButton>
                    <ChipButton
                      active={stage.routedModeUsdc === "amounts"}
                      onClick={() => set({ routedModeUsdc: "amounts" })}
                      disabled={disabled}
                    >
                      Fixed USD amounts
                    </ChipButton>
                  </div>
                  <SplitsEditor
                    splits={stage.payoutSplitsUsdc}
                    onChange={(payoutSplitsUsdc) => set({ payoutSplitsUsdc })}
                    disabled={disabled}
                    bucketLabel="USDC payouts"
                    mode={stage.routedModeUsdc === "all" ? "percent" : "amount"}
                    amountLabel="USD"
                    chainIds={chainIds}
                    allowHook
                    showRouting
                    allowLock={duration > 0 && duration !== FOREVER_SECONDS}
                  />
                  {stage.payoutSplitsUsdc.length === 0 ? (
                    <p className="mt-2 text-xs text-smoke-700">
                      No recipients yet — USDC payouts go to the project owner.
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}

          {/* The toggle must render wherever the encoding would honor it:
              gating on the ETH mode alone hid it whenever ETH routed everything
              while USDC kept a cap, silently carrying a stale "yes" into an
              immutable surplus allowance. */}
          {stage.payouts === "flexible" ||
          (stage.payouts === "routed" && !routedAll) ? (
            <div className="mt-3">
              {stage.payouts === "routed" ? (
                <CheckRow
                  checked={stage.routedSurplusOn}
                  onToggle={() =>
                    set({ routedSurplusOn: !stage.routedSurplusOn })
                  }
                  disabled={disabled}
                  title="Let the owner withdraw remaining funds"
                  blurb="The owner can withdraw funds not set aside for payouts, up to the limit below."
                />
              ) : null}
              {stage.payouts === "flexible" || stage.routedSurplusOn ? (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <span className="text-xs text-smoke-700">Withdrawals:</span>
                  <ChipButton
                    active={!stage.surplusCapOn}
                    onClick={() => set({ surplusCapOn: false })}
                    disabled={disabled}
                  >
                    Unlimited
                  </ChipButton>
                  <ChipButton
                    active={stage.surplusCapOn}
                    onClick={() => set({ surplusCapOn: true })}
                    disabled={disabled}
                  >
                    Capped
                  </ChipButton>
                  {stage.surplusCapOn ? (
                    <span className="flex items-center gap-2">
                      <input
                        type="text"
                        inputMode="decimal"
                        value={stage.surplusAmount}
                        onChange={(e) =>
                          set({ surplusAmount: e.target.value.slice(0, 20) })
                        }
                        disabled={disabled}
                        placeholder="1.0"
                        className={`input-well min-h-[40px] w-28 px-3 text-sm tabular-nums disabled:opacity-60 ${
                          Number(stage.surplusAmount) > 0
                            ? ""
                            : "!border-red-400"
                        }`}
                      />
                      <span className="whitespace-nowrap text-xs text-smoke-700">
                        {unitLabel} max, until rules change
                      </span>
                    </span>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
          {stage.payouts !== "none" ? (
            <div className="mt-5 border-t border-smoke-200 pt-4">
              <button
                onClick={() => toggleOpen("fees")}
                disabled={disabled}
                aria-expanded={!!stage.open.fees}
                className="text-xs font-medium text-smoke-700 hover:text-ink disabled:opacity-60"
              >
                Fee payment timing {stage.open.fees ? "▾" : "▸"}
              </button>
              {stage.open.fees ? (
                <>
                  <p className="mt-2 text-xs leading-relaxed text-smoke-700">
                    <Link
                      href="/learn#learn-fees"
                      className="underline underline-offset-2 hover:text-ink"
                    >
                      How fees work and what the payer receives
                    </Link>
                  </p>
                  <div className="mt-2.5">
                    <CheckRow
                      checked={stage.holdFees}
                      onToggle={() => set({ holdFees: !stage.holdFees })}
                      disabled={disabled}
                      title="Hold fees in the project"
                      blurb="Delay paying the fee. Eligible funds returned before it is processed release the matching held amount back to the project."
                    />
                  </div>
                </>
              ) : null}
            </div>
          ) : null}
        </SubSection>
      )}

      {/* Cash outs */}
      <SubSection
        label="Cash outs"
        summary={cashOutsSummary}
        open={!!stage.open.cashouts}
        onToggle={() => toggleOpen("cashouts")}
      >
        {isRevnet ? (
          <>
            <TaxPicker
              stage={stage}
              set={set}
              disabled={disabled}
              required
              offBlurb="Tokens are for support and standing — cashing out returns almost nothing."
              onBlurb={`Holders can exchange ${tokenLabel} for available project funds under the rules below, after any cash out delay.`}
            />
            {!stage.cashOuts ? (
              <p className="mt-3 rounded-lg bg-smoke-75 px-3.5 py-2.5 text-xs leading-relaxed text-smoke-700">
                Revnets can&apos;t fully disable cash outs — Off applies the
                maximum 99.99% tax, so partial cash outs return next to nothing
                while cashing out every token still claims the full treasury.
              </p>
            ) : null}
          </>
        ) : routedAll ? (
          <p className="rounded-lg bg-smoke-75 px-3.5 py-2.5 text-xs leading-relaxed text-smoke-700">
            {multiToken
              ? "Every accepted token routes all of its funds by percentage, leaving no surplus for token holders to cash out. Switch either token's payouts to fixed amounts to leave a surplus."
              : "Routing all funds by percentage leaves no surplus for token holders to cash out. Switch payouts to fixed amounts to leave a surplus."}
          </p>
        ) : (
          <TaxPicker
            stage={stage}
            set={set}
            disabled={disabled}
            offBlurb="Tokens are for support and standing — holders can't pull funds out."
            onBlurb={`Holders can exchange ${tokenLabel} for funds not set aside for payouts. This remaining balance is called surplus.`}
          />
        )}
      </SubSection>

      {/* Owner powers (revnets have no owner) */}
      {isRevnet ? null : (
        <SubSection
          label="Project owner powers"
          summary={
            [
              stage.ownerMinting ? "creates tokens" : "",
              Object.values(stage.powers).some(Boolean) ? "contract controls" : "",
            ]
              .filter(Boolean)
              .join(" | ") || "Standard"
          }
          open={!!stage.open.owner}
          onToggle={() => toggleOpen("owner")}
        >
          <CheckRow
            checked={stage.ownerMinting}
            onToggle={() => set({ ownerMinting: !stage.ownerMinting })}
            disabled={disabled}
            title={`Owner can create ${tokenLabel} without payment`}
            blurb="The owner can create any amount of new tokens. This reduces existing holders' share of the total supply."
          />
          <div className="mt-5 border-t border-smoke-200 pt-4">
            <span className="field-label">Contract controls</span>
            <p className="mt-1 text-xs leading-relaxed text-smoke-700">
              Choose which contracts and assets the owner can change. These
              powers can affect how supporter funds are used.
            </p>
            <div className="mt-2.5 space-y-2">
              {(
                [
                  [
                    "setTerminals",
                    "Change payment contracts",
                    "Add or remove the contracts that receive funds, at any time.",
                  ],
                  [
                    "setController",
                    "Change the contract that manages rules",
                    "Swap the contract that enforces the project's rules.",
                  ],
                  [
                    "terminalMigration",
                    "Move funds to a new payment contract",
                    "Move funds from the current payment contract to a new one.",
                  ],
                  [
                    "setCustomToken",
                    "Replace the token",
                    "Swap the project's token for a custom ERC-20.",
                  ],
                  [
                    "addAccountingContext",
                    "Accept more treasury tokens",
                    "Accept and account for new tokens in the treasury.",
                  ],
                  [
                    "addPriceFeed",
                    "Add price sources",
                    "Choose additional sources for currency conversions.",
                  ],
                ] as const
              ).map(([key, title, blurb]) => (
                <CheckRow
                  key={key}
                  checked={stage.powers[key]}
                  onToggle={() =>
                    set({
                      powers: { ...stage.powers, [key]: !stage.powers[key] },
                    })
                  }
                  disabled={disabled}
                  title={title}
                  blurb={blurb}
                />
              ))}
            </div>
          </div>
        </SubSection>
      )}

      {/* Extras */}
      {isRevnet ? null : (
        <SubSection
          label="Extras"
          summary={
            [
              stage.pauseCreditTransfers ? "Credits paused" : null,
              stage.pause721Transfers ? "Item transfers paused" : null,
            ]
              .filter(Boolean)
              .join(", ") || "None"
          }
          open={!!stage.open.extras}
          onToggle={() => toggleOpen("extras")}
        >
          <div className="space-y-2">
            <CheckRow
              checked={stage.pauseCreditTransfers}
              onToggle={() =>
                set({ pauseCreditTransfers: !stage.pauseCreditTransfers })
              }
              disabled={disabled}
              title="Pause credit transfers"
              blurb="Balances recorded within Juicebox, called credits, cannot move between wallets. Tokens already claimed to a wallet can still be transferred."
            />
            <CheckRow
              checked={stage.pause721Transfers}
              onToggle={() =>
                set({ pause721Transfers: !stage.pause721Transfers })
              }
              disabled={disabled}
              title="Pause eligible shop item transfers"
              blurb="Items created with ‘Transfers pausable’ can't move between wallets during this ruleset. Minting and burning still work."
            />
          </div>
        </SubSection>
      )}
    </div>
  );
}
