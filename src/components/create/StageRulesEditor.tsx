'use client'

import { FOREVER_SECONDS } from '@/lib/launch'
import { CashOutCurve } from './CashOutCurve'
import {
  SplitsEditor,
  splitOk,
  splitsTotal,
  type DraftSplit,
} from './SplitsEditor'
import { CheckRow, ChipButton, OptionRow, SubSection } from './ui'

/**
 * One stage = one queued ruleset (website/ parity). Every rule here is
 * per-stage; the approval condition lives at the stages-list level.
 */

export type DraftStage = {
  id: string
  /** Duration select value: '0' Flexible, preset seconds, FOREVER, 'custom'. */
  durationValue: string
  customDuration: string
  customUnit: 'hours' | 'days' | 'weeks' | 'years'
  /** Stage 1 only: schedule a start instead of launching right away. */
  scheduleOn: boolean
  schedule: string
  /** '' on stage 2+ = keep the previous stage's (cut) rate. */
  issuanceRate: string
  /** Issuance cut per cycle, 0–100 (%). '' = none. */
  cutPct: string
  /** Revnet: days between issuance cuts. */
  cutFreqDays: string
  /** Revnet, stage 2+: starts this many days after the previous stage. */
  daysAfter: string
  reservedPct: string
  reservedSplits: DraftSplit[]
  payouts: 'none' | 'flexible' | 'routed'
  routedMode: 'all' | 'amounts'
  payoutSplits: DraftSplit[]
  holdFees: boolean
  cashOuts: boolean
  cashOutTax: number
  ownerMinting: boolean
  acceptPayments: boolean
  pauseCreditTransfers: boolean
  powers: {
    setTerminals: boolean
    setController: boolean
    terminalMigration: boolean
    setCustomToken: boolean
    addAccountingContext: boolean
    addPriceFeed: boolean
  }
  expanded: boolean
  open: Record<string, boolean>
}

export function newDraftStage(
  first: boolean,
  flavor: 'project' | 'revnet' = 'project',
): DraftStage {
  return {
    id: crypto.randomUUID(),
    durationValue: '0',
    customDuration: '',
    customUnit: 'days',
    scheduleOn: false,
    schedule: '',
    issuanceRate: first ? '10000' : '',
    cutPct: '',
    cutFreqDays: '30',
    daysAfter: '30',
    reservedPct: '0',
    reservedSplits: [],
    payouts: 'none',
    routedMode: 'all',
    payoutSplits: [],
    holdFees: false,
    cashOuts: false,
    cashOutTax: flavor === 'revnet' ? 1000 : 0,
    ownerMinting: false,
    acceptPayments: true,
    pauseCreditTransfers: false,
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
  }
}

export const DURATION_PRESETS: [number, string][] = [
  [86_400, '1 day'],
  [3 * 86_400, '3 days'],
  [7 * 86_400, '7 days'],
  [14 * 86_400, '14 days'],
  [28 * 86_400, '28 days'],
  [30 * 86_400, '30 days'],
  [90 * 86_400, '90 days'],
  [365 * 86_400, '365 days'],
]

const UNIT_SECONDS = {
  hours: 3_600,
  days: 86_400,
  weeks: 604_800,
  years: 31_536_000,
} as const

/** The stage's duration in seconds (0 = flexible). */
export function stageDurationSeconds(stage: DraftStage): number {
  if (stage.durationValue === 'custom') {
    const n = Number(stage.customDuration)
    if (!Number.isFinite(n) || n <= 0) return 0
    return Math.round(n * UNIT_SECONDS[stage.customUnit])
  }
  return Number(stage.durationValue) || 0
}

export function secondsLabel(seconds: number): string {
  if (seconds % 31_536_000 === 0 && seconds >= 31_536_000)
    return `${seconds / 31_536_000} year${seconds === 31_536_000 ? '' : 's'}`
  if (seconds % 604_800 === 0 && seconds >= 604_800)
    return `${seconds / 604_800} week${seconds === 604_800 ? '' : 's'}`
  if (seconds % 86_400 === 0 && seconds >= 86_400)
    return `${seconds / 86_400} day${seconds === 86_400 ? '' : 's'}`
  return `${Math.round(seconds / 360) / 10} hours`
}

const numOk = (value: string, max = Infinity) => {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 && n <= max
}

export function stageIssuanceOk(stage: DraftStage, isFirst: boolean): boolean {
  if (stage.issuanceRate.trim() === '') return !isFirst // later stages inherit
  return numOk(stage.issuanceRate)
}

export function stageOk(
  stage: DraftStage,
  isFirst: boolean,
  flavor: 'project' | 'revnet' = 'project',
): boolean {
  const reservedOn =
    numOk(stage.reservedPct, 100) && Number(stage.reservedPct) > 0
  const payoutsMode = stage.routedMode === 'all' ? 'percent' : 'amount'
  const common =
    stageIssuanceOk(stage, isFirst) &&
    (stage.cutPct.trim() === '' || numOk(stage.cutPct, 100)) &&
    (stage.reservedPct.trim() === '' || numOk(stage.reservedPct, 100)) &&
    (!reservedOn ||
      (stage.reservedSplits.every(s => splitOk(s, 'percent')) &&
        splitsTotal(stage.reservedSplits, 'percent') <= 100))
  if (flavor === 'revnet') {
    const cutOn = Number(stage.cutPct) > 0
    return (
      common &&
      (!cutOn || (Number(stage.cutFreqDays) >= 1 && numOk(stage.cutFreqDays))) &&
      (isFirst || Number(stage.daysAfter) >= 1) &&
      // Revnets can't turn cash outs off completely (100% tax reverts).
      (stage.cashOutTax < 10_000)
    )
  }
  return (
    common &&
    (stage.payouts !== 'routed' ||
      (stage.payoutSplits.every(s => splitOk(s, payoutsMode)) &&
        (payoutsMode !== 'percent' ||
          splitsTotal(stage.payoutSplits, 'percent') <= 100))) &&
    (stage.durationValue !== 'custom' || stageDurationSeconds(stage) > 0)
  )
}

/** Summary parts for a stage (website/'s stageSummaryRaw). */
export function stageSummaryParts(
  stage: DraftStage,
  index: number,
  unitLabel: string,
  flavor: 'project' | 'revnet' = 'project',
): string[] {
  const parts: string[] = []
  if (index === 0) {
    parts.push(
      stage.scheduleOn && stage.schedule
        ? 'Starts at a set time'
        : 'Starts at launch',
    )
  } else if (flavor === 'revnet') {
    parts.push(`Starts ${Number(stage.daysAfter) || '?'} days after Stage #${index}`)
  } else {
    parts.push(`Starts after Ruleset #${index}`)
  }
  const duration = stageDurationSeconds(stage)
  if (flavor !== 'revnet')
    parts.push(
      duration === 0
        ? 'lasts until changed'
        : duration === FOREVER_SECONDS
          ? 'lasts forever'
          : `lasts ${secondsLabel(duration)}`,
    )
  if (stage.issuanceRate.trim() === '' && index > 0) {
    parts.push('keeps issuance')
  } else if (Number(stage.issuanceRate) > 0) {
    parts.push(
      `issues ${Number(stage.issuanceRate).toLocaleString('en-US')}/${unitLabel}`,
    )
  } else {
    parts.push('no issuance')
  }
  if (Number(stage.reservedPct) > 0)
    parts.push(
      flavor === 'revnet'
        ? `${Number(stage.reservedPct)}% to splits`
        : `${Number(stage.reservedPct)}% reserved`,
    )
  if (Number(stage.cutPct) > 0)
    parts.push(
      flavor === 'revnet'
        ? `-${Number(stage.cutPct)}%/${Number(stage.cutFreqDays) || '?'}d`
        : `-${Number(stage.cutPct)}%/cycle`,
    )
  const routedAll = stage.payouts === 'routed' && stage.routedMode === 'all'
  if (flavor === 'revnet') {
    parts.push(`${stage.cashOutTax / 100}% cash out tax`)
  } else if (stage.cashOuts && !routedAll) {
    parts.push('cash outs on')
  }
  return parts
}

/** One-line stage card summary. */
export function stageSummary(
  stage: DraftStage,
  index: number,
  unitLabel: string,
  flavor: 'project' | 'revnet' = 'project',
): string {
  return stageSummaryParts(stage, index, unitLabel, flavor).join(' | ')
}

const CASH_OUT_TAXES = [
  { rate: 0, label: 'No tax' },
  { rate: 1000, label: '10% tax' },
  { rate: 3000, label: '30% tax' },
  { rate: 5000, label: '50% tax' },
] as const

export function StageRulesEditor({
  stage,
  onChange,
  isFirst,
  isLast,
  index,
  unitLabel,
  disabled,
  chainIds,
  flavor = 'project',
}: {
  stage: DraftStage
  onChange: (stage: DraftStage) => void
  isFirst: boolean
  isLast: boolean
  index: number
  unitLabel: string
  disabled: boolean
  /** Selected launch chains (enables per-chain recipient overrides). */
  chainIds: number[]
  flavor?: 'project' | 'revnet'
}) {
  const isRevnet = flavor === 'revnet'
  const set = (patch: Partial<DraftStage>) => onChange({ ...stage, ...patch })
  const toggleOpen = (key: string) =>
    set({ open: { ...stage.open, [key]: !stage.open[key] } })

  const duration = stageDurationSeconds(stage)
  const reservedOn = numOk(stage.reservedPct, 100) && Number(stage.reservedPct) > 0
  const payoutsMode = stage.routedMode === 'all' ? 'percent' : 'amount'
  const routedAll = stage.payouts === 'routed' && stage.routedMode === 'all'
  const issuanceOk = stageIssuanceOk(stage, isFirst)

  const timingSummary = isRevnet
    ? isFirst
      ? stage.scheduleOn && stage.schedule
        ? 'Scheduled'
        : 'At launch'
      : `${Number(stage.daysAfter) || '?'}d after Stage #${index}`
    : `${
        isFirst
          ? stage.scheduleOn && stage.schedule
            ? 'Scheduled'
            : 'At launch'
          : `After Ruleset #${index}`
      } | ${
        duration === 0
          ? 'flexible'
          : duration === FOREVER_SECONDS
            ? 'forever'
            : secondsLabel(duration)
      }`

  const tokensSummary = issuanceOk
    ? `${
        stage.issuanceRate.trim() === '' && !isFirst
          ? 'Keeps rate'
          : `${Number(stage.issuanceRate || '0').toLocaleString('en-US')} per ${unitLabel}`
      }${reservedOn ? ` | ${Number(stage.reservedPct)}% reserved` : ''}${
        Number(stage.cutPct) > 0 ? ` | -${Number(stage.cutPct)}%/cycle` : ''
      }`
    : '—'

  const validPayoutSplits = stage.payoutSplits.filter(s =>
    splitOk(s, payoutsMode),
  ).length
  const payoutsSummary =
    (stage.payouts === 'none'
      ? 'Funds stay in the project'
      : stage.payouts === 'flexible'
        ? 'Flexible withdrawals'
        : validPayoutSplits === 0
          ? 'Routing all funds to you'
          : stage.routedMode === 'all'
            ? `Routing all funds to ${validPayoutSplits} recipient${validPayoutSplits === 1 ? '' : 's'}`
            : `Routing ${splitsTotal(stage.payoutSplits, 'amount').toLocaleString('en-US')} ${unitLabel} to ${validPayoutSplits} recipient${validPayoutSplits === 1 ? '' : 's'}`) +
    (stage.payouts !== 'none' && stage.holdFees ? ' | fees held' : '')

  const cashOutsSummary = routedAll
    ? 'Off — all funds routed'
    : stage.cashOuts
      ? `On | ${stage.cashOutTax === 0 ? 'no tax' : `${stage.cashOutTax / 100}% tax`}`
      : 'Off'

  return (
    <div>
      {/* Timing */}
      <SubSection
        label="Timing"
        summary={timingSummary}
        open={!!stage.open.timing}
        onToggle={() => toggleOpen('timing')}
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
              <input
                type="datetime-local"
                value={stage.schedule}
                onChange={e => set({ schedule: e.target.value })}
                disabled={disabled}
                className="input-well mt-2 min-h-[44px] px-3.5 text-sm disabled:opacity-60"
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
                onChange={e => set({ daysAfter: e.target.value.slice(0, 5) })}
                disabled={disabled}
                className={`input-well min-h-[44px] w-20 px-3 text-sm tabular-nums disabled:opacity-60 ${
                  Number(stage.daysAfter) >= 1 ? '' : '!border-red-400'
                }`}
              />
              <span className="text-sm text-smoke-700">
                days after Stage #{index} begins
              </span>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-smoke-700">
              Stage changes land on issuance-cut boundaries, so the start
              snaps to the previous stage&apos;s cut cycle.
            </p>
          </div>
        ) : null}
        {isRevnet ? null : (
          <>
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
          How long these rules run. Flexible rules last until you change
          them; a fixed duration locks them in, and the next ruleset starts
          when it ends.
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2.5">
          <select
            value={stage.durationValue}
            onChange={e => set({ durationValue: e.target.value })}
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
          {stage.durationValue === 'custom' ? (
            <>
              <input
                type="text"
                inputMode="decimal"
                value={stage.customDuration}
                onChange={e => set({ customDuration: e.target.value.slice(0, 6) })}
                disabled={disabled}
                placeholder="30"
                className={`input-well min-h-[44px] w-20 px-3 text-sm tabular-nums disabled:opacity-60 ${
                  stageDurationSeconds(stage) > 0 ? '' : '!border-red-400'
                }`}
              />
              <select
                value={stage.customUnit}
                onChange={e =>
                  set({ customUnit: e.target.value as DraftStage['customUnit'] })
                }
                disabled={disabled}
                className="input-well select-caret min-h-[44px] w-28 px-3 pr-9 text-sm disabled:opacity-60"
              >
                {(['hours', 'days', 'weeks', 'years'] as const).map(unit => (
                  <option key={unit} value={unit}>
                    {unit}
                  </option>
                ))}
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

      {/* Tokens */}
      <SubSection
        label="Tokens"
        summary={tokensSummary}
        open={!!stage.open.tokens}
        onToggle={() => toggleOpen('tokens')}
      >
        <p className="text-xs leading-relaxed text-smoke-700">
          Supporters get newly issued project tokens when they pay.
          {!isFirst
            ? ' Leave the rate empty to keep the previous ruleset’s rate.'
            : ''}
        </p>
        <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-2">
          <input
            type="text"
            inputMode="decimal"
            value={stage.issuanceRate}
            onChange={e => set({ issuanceRate: e.target.value.slice(0, 15) })}
            disabled={disabled}
            placeholder={isFirst ? '10000' : 'Keep rate'}
            className={`input-well min-h-[44px] w-36 px-3.5 text-sm tabular-nums disabled:opacity-60 ${
              issuanceOk ? '' : '!border-red-400'
            }`}
          />
          <span className="text-sm text-smoke-700">
            tokens per {unitLabel} paid
          </span>
        </div>
        {isRevnet ? (
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
            <span className="text-sm text-smoke-700">cut issuance</span>
            <input
              type="text"
              inputMode="decimal"
              value={stage.cutPct}
              onChange={e => set({ cutPct: e.target.value.slice(0, 5) })}
              disabled={disabled}
              placeholder="0"
              className={`input-well min-h-[44px] w-20 px-3.5 text-sm tabular-nums disabled:opacity-60 ${
                stage.cutPct.trim() === '' || numOk(stage.cutPct, 100)
                  ? ''
                  : '!border-red-400'
              }`}
            />
            <span className="text-sm text-smoke-700">% every</span>
            <input
              type="text"
              inputMode="numeric"
              value={stage.cutFreqDays}
              onChange={e => set({ cutFreqDays: e.target.value.slice(0, 5) })}
              disabled={disabled}
              className={`input-well min-h-[44px] w-20 px-3.5 text-sm tabular-nums disabled:opacity-60 ${
                Number(stage.cutPct) > 0 && !(Number(stage.cutFreqDays) >= 1)
                  ? '!border-red-400'
                  : ''
              }`}
            />
            <span className="text-sm text-smoke-700">days</span>
          </div>
        ) : duration > 0 && duration !== FOREVER_SECONDS ? (
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
            <input
              type="text"
              inputMode="decimal"
              value={stage.cutPct}
              onChange={e => set({ cutPct: e.target.value.slice(0, 5) })}
              disabled={disabled}
              placeholder="0"
              className={`input-well min-h-[44px] w-20 px-3.5 text-sm tabular-nums disabled:opacity-60 ${
                stage.cutPct.trim() === '' || numOk(stage.cutPct, 100)
                  ? ''
                  : '!border-red-400'
              }`}
            />
            <span className="text-sm text-smoke-700">
              % issuance cut each time the rules cycle
            </span>
          </div>
        ) : null}
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
          <input
            type="text"
            inputMode="decimal"
            value={stage.reservedPct}
            onChange={e => set({ reservedPct: e.target.value.slice(0, 5) })}
            disabled={disabled}
            className={`input-well min-h-[44px] w-20 px-3.5 text-sm tabular-nums disabled:opacity-60 ${
              stage.reservedPct.trim() === '' || numOk(stage.reservedPct, 100)
                ? ''
                : '!border-red-400'
            }`}
          />
          <span className="text-sm text-smoke-700">
            {isRevnet ? '% of new tokens to splits' : '% of new tokens reserved'}
          </span>
        </div>
        {reservedOn ? (
          <div className="mt-4">
            <p className="text-xs leading-relaxed text-smoke-700">
              {isRevnet
                ? 'Where should split tokens go? Any remainder goes to the operator.'
                : 'Where should reserved tokens go? Leave empty to keep them all for yourself.'}
            </p>
            <SplitsEditor
              splits={stage.reservedSplits}
              onChange={reservedSplits => set({ reservedSplits })}
              disabled={disabled}
              bucketLabel={isRevnet ? 'split tokens' : 'reserved tokens'}
              remainderNote={isRevnet ? 'go to the operator' : 'go to you'}
              chainIds={chainIds}
            />
          </div>
        ) : null}
      </SubSection>

      {/* Payouts (owner-managed money never applies to revnets) */}
      {isRevnet ? null : (
      <SubSection
        label="Payouts"
        summary={payoutsSummary}
        open={!!stage.open.payouts}
        onToggle={() => toggleOpen('payouts')}
      >
        <div className="space-y-2">
          <OptionRow
            checked={stage.payouts === 'none'}
            onSelect={() => set({ payouts: 'none' })}
            disabled={disabled}
            title="Keep funds in the project"
            blurb="Nothing can be paid out until the rules change. The clearest promise to supporters."
          />
          <OptionRow
            checked={stage.payouts === 'flexible'}
            onSelect={() => set({ payouts: 'flexible' })}
            disabled={disabled}
            title="Flexible withdrawals"
            blurb="You can withdraw any amount from the project's surplus, any time."
          />
          <OptionRow
            checked={stage.payouts === 'routed'}
            onSelect={() => set({ payouts: 'routed' })}
            disabled={disabled}
            title="Routed payouts"
            blurb="Incoming funds route automatically to recipients you set — anyone can trigger the payout."
          />
        </div>
        {stage.payouts === 'routed' ? (
          <div className="mt-3">
            <div className="flex flex-wrap gap-2">
              <ChipButton
                active={stage.routedMode === 'all'}
                onClick={() => set({ routedMode: 'all' })}
                disabled={disabled}
              >
                Split all funds by %
              </ChipButton>
              <ChipButton
                active={stage.routedMode === 'amounts'}
                onClick={() => set({ routedMode: 'amounts' })}
                disabled={disabled}
              >
                Fixed {unitLabel} amounts
              </ChipButton>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-smoke-700">
              {stage.routedMode === 'all'
                ? 'Every incoming payment is split among the recipients by percentage.'
                : `Each recipient gets up to their ${unitLabel} amount — anything beyond stays in the project as surplus.`}
            </p>
            <SplitsEditor
              splits={stage.payoutSplits}
              onChange={payoutSplits => set({ payoutSplits })}
              disabled={disabled}
              bucketLabel="payouts"
              mode={payoutsMode}
              amountLabel={unitLabel}
              chainIds={chainIds}
            />
            {stage.payoutSplits.length === 0 ? (
              <p className="mt-2 text-xs text-smoke-700">
                No recipients yet — payouts go to you, the owner.
              </p>
            ) : null}
          </div>
        ) : null}
        {stage.payouts !== 'none' ? (
          <div className="mt-5 border-t border-smoke-200 pt-4">
            <button
              onClick={() => toggleOpen('fees')}
              disabled={disabled}
              aria-expanded={!!stage.open.fees}
              className="text-xs font-medium text-smoke-700 hover:text-ink disabled:opacity-60"
            >
              Read about fees {stage.open.fees ? '▾' : '▸'}
            </button>
            {stage.open.fees ? (
              <p className="mt-2 text-xs leading-relaxed text-smoke-700">
                Funds leaving the project — payouts and withdrawals — pay a
                small fee to the Juicebox protocol. Paying it makes you a
                part-owner of Juicebox itself, earning a cut of everyone
                else&apos;s fees. Money moving between Juicebox projects never
                pays a fee.
              </p>
            ) : null}
            <div className="mt-2.5">
              <CheckRow
                checked={stage.holdFees}
                onToggle={() => set({ holdFees: !stage.holdFees })}
                disabled={disabled}
                title="Hold fees in the project"
                blurb="Keep the fee amount in your project instead of paying it right away. Useful if you might put funds back into your Juicebox later — issuing refunds, say — since returned funds unlock the held fee."
              />
            </div>
          </div>
        ) : null}
      </SubSection>
      )}

      {/* Cash outs */}
      <SubSection
        label="Cash outs"
        summary={cashOutsSummary}
        open={!!stage.open.cashouts}
        onToggle={() => toggleOpen('cashouts')}
      >
        {isRevnet ? (
          <>
            <p className="text-xs leading-relaxed text-smoke-700">
              Revnets always allow cash outs — holders can exit for their
              share of the treasury at any time. Pick the tax.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {CASH_OUT_TAXES.map(tax => (
                <ChipButton
                  key={tax.rate}
                  active={stage.cashOutTax === tax.rate}
                  onClick={() => set({ cashOutTax: tax.rate })}
                  disabled={disabled}
                >
                  {tax.label}
                </ChipButton>
              ))}
            </div>
            <p className="mt-2 text-xs leading-relaxed text-smoke-700">
              A tax leaves part of each cash out behind for holders who
              stay.
            </p>
            <CashOutCurve rate={stage.cashOutTax} />
          </>
        ) : routedAll ? (
          <p className="rounded-lg bg-smoke-75 px-3.5 py-2.5 text-xs leading-relaxed text-smoke-700">
            Routing all funds by percentage leaves no surplus for token
            holders to cash out. Switch payouts to fixed amounts to leave a
            surplus.
          </p>
        ) : (
          <>
            <div className="space-y-2">
              <OptionRow
                checked={!stage.cashOuts}
                onSelect={() => set({ cashOuts: false })}
                disabled={disabled}
                title="Off"
                blurb="Tokens are for support and standing — holders can't pull funds out."
              />
              <OptionRow
                checked={stage.cashOuts}
                onSelect={() => set({ cashOuts: true })}
                disabled={disabled}
                title="On"
                blurb="Holders can cash out tokens any time for their share of the surplus."
              />
            </div>
            {stage.cashOuts ? (
              <>
                <div className="mt-3 flex flex-wrap gap-2">
                  {CASH_OUT_TAXES.map(tax => (
                    <ChipButton
                      key={tax.rate}
                      active={stage.cashOutTax === tax.rate}
                      onClick={() => set({ cashOutTax: tax.rate })}
                      disabled={disabled}
                    >
                      {tax.label}
                    </ChipButton>
                  ))}
                </div>
                <p className="mt-2 text-xs leading-relaxed text-smoke-700">
                  A tax leaves part of each cash out behind for holders who
                  stay.
                </p>
                <CashOutCurve rate={stage.cashOutTax} />
              </>
            ) : null}
          </>
        )}
      </SubSection>

      {/* Owner powers (revnets have no owner) */}
      {isRevnet ? null : (
      <SubSection
        label="Owner powers"
        summary={
          [
            stage.ownerMinting ? 'mints tokens' : '',
            Object.values(stage.powers).some(Boolean) ? 'superpowers' : '',
          ]
            .filter(Boolean)
            .join(' | ') || 'Standard'
        }
        open={!!stage.open.owner}
        onToggle={() => toggleOpen('owner')}
      >
        <CheckRow
          checked={stage.ownerMinting}
          onToggle={() => set({ ownerMinting: !stage.ownerMinting })}
          disabled={disabled}
          title="Owner can mint tokens any time"
          blurb="Mint any amount without payment. Supporters can see this power on your project, so leave it off unless you need it."
        />
        <div className="mt-5 border-t border-smoke-200 pt-4">
          <span className="field-label">Superpowers</span>
          <p className="mt-1 text-xs leading-relaxed text-smoke-700">
            Deep controls most projects never need. Each one gives the owner
            real power over supporter funds — leave them off unless you know
            why you need them.
          </p>
          <div className="mt-2.5 space-y-2">
            {(
              [
                [
                  'setTerminals',
                  'Change payment terminals',
                  'Add or remove the contracts that receive funds, at any time.',
                ],
                [
                  'setController',
                  'Change the controller',
                  "Swap the contract that enforces the project's rules.",
                ],
                [
                  'terminalMigration',
                  'Migrate terminals',
                  'Move funds to a new version of a terminal.',
                ],
                [
                  'setCustomToken',
                  'Replace the token',
                  "Swap the project's token for a custom ERC-20.",
                ],
                [
                  'addAccountingContext',
                  'Add accounting tokens',
                  'Accept and account for new tokens in the treasury.',
                ],
                [
                  'addPriceFeed',
                  'Add price feeds',
                  'Register new price feeds the project prices against.',
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
          summary={stage.pauseCreditTransfers ? 'Credits paused' : 'None'}
          open={!!stage.open.extras}
          onToggle={() => toggleOpen('extras')}
        >
          <CheckRow
            checked={stage.pauseCreditTransfers}
            onToggle={() =>
              set({ pauseCreditTransfers: !stage.pauseCreditTransfers })
            }
            disabled={disabled}
            title="Pause credit transfers"
            blurb="Supporters' internal credits can't be moved between wallets. Claimed ERC-20 tokens stay transferable."
          />
        </SubSection>
      )}
    </div>
  )
}
