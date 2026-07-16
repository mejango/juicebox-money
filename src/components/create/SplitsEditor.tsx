'use client'

import { isAddress } from 'viem'

/**
 * Shared split-row editor for reserved tokens and routed payouts. Recipients
 * are addresses (0x…) or projects (#123). Percentages are out of 100 of the
 * bucket being split; any unallocated remainder goes to the owner.
 */

export type SplitsMode = 'percent' | 'amount'

export type DraftSplit = {
  id: number
  /** Percent (0–100) in 'percent' mode; a currency amount in 'amount' mode. */
  value: string
  recipient: string
}

let nextId = 1

export function newDraftSplit(): DraftSplit {
  return { id: nextId++, value: '', recipient: '' }
}

export function recipientOk(recipient: string): boolean {
  const r = recipient.trim()
  return isAddress(r) || /^#?\d{1,10}$/.test(r)
}

export function splitValueOk(value: string, mode: SplitsMode): boolean {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return false
  return mode === 'percent' ? n <= 100 : true
}

export function splitOk(split: DraftSplit, mode: SplitsMode): boolean {
  return splitValueOk(split.value, mode) && recipientOk(split.recipient)
}

export function splitsTotal(splits: DraftSplit[], mode: SplitsMode): number {
  return splits.reduce(
    (sum, s) => sum + (splitValueOk(s.value, mode) ? Number(s.value) : 0),
    0,
  )
}

export function SplitsEditor({
  splits,
  onChange,
  disabled,
  bucketLabel,
  mode = 'percent',
  amountLabel = '',
  remainderNote = 'go to you',
}: {
  splits: DraftSplit[]
  onChange: (splits: DraftSplit[]) => void
  disabled: boolean
  /** e.g. "reserved tokens" or "payouts" — used in the remainder note. */
  bucketLabel: string
  mode?: SplitsMode
  /** Currency label for 'amount' mode, e.g. "ETH". */
  amountLabel?: string
  /** Where the unallocated remainder goes, e.g. "go to you". */
  remainderNote?: string
}) {
  const update = (id: number, patch: Partial<DraftSplit>) => {
    onChange(splits.map(s => (s.id === id ? { ...s, ...patch } : s)))
  }
  const total = splitsTotal(splits, mode)

  return (
    <div>
      {splits.map(split => (
        <div key={split.id} className="mt-2 flex items-start gap-2">
          <label className="w-24 shrink-0">
            <input
              type="text"
              inputMode="decimal"
              value={split.value}
              onChange={e => update(split.id, { value: e.target.value.slice(0, 10) })}
              disabled={disabled}
              placeholder={mode === 'percent' ? '%' : amountLabel}
              aria-label={mode === 'percent' ? 'Percent' : `Amount (${amountLabel})`}
              className={`input-well min-h-[44px] px-3 text-sm tabular-nums disabled:opacity-60 ${
                split.value && !splitValueOk(split.value, mode)
                  ? '!border-red-400'
                  : ''
              }`}
            />
          </label>
          <input
            type="text"
            value={split.recipient}
            onChange={e => update(split.id, { recipient: e.target.value.trim().slice(0, 64) })}
            disabled={disabled}
            placeholder="0x address or project #12"
            aria-label="Recipient"
            className={`input-well min-h-[44px] min-w-0 flex-1 px-3 font-mono text-xs disabled:opacity-60 ${
              split.recipient && !recipientOk(split.recipient)
                ? '!border-red-400'
                : ''
            }`}
          />
          <button
            onClick={() => onChange(splits.filter(s => s.id !== split.id))}
            disabled={disabled}
            aria-label="Remove recipient"
            className="mt-2.5 shrink-0 text-xs font-medium text-smoke-700 underline underline-offset-2 hover:text-ink disabled:opacity-60"
          >
            Remove
          </button>
        </div>
      ))}

      <div className="mt-2 flex flex-wrap items-baseline justify-between gap-2">
        <button
          onClick={() => onChange([...splits, newDraftSplit()])}
          disabled={disabled}
          className="text-sm font-medium text-bluebs-600 hover:text-bluebs-700 disabled:opacity-60"
        >
          + Add a recipient
        </button>
        {splits.length > 0 ? (
          mode === 'percent' ? (
            <span
              className={`text-xs tabular-nums ${total > 100 ? 'font-medium text-red-600' : 'text-smoke-700'}`}
            >
              {total > 100
                ? `${total}% — over 100%`
                : total < 100
                  ? `${total}% allocated · remaining ${bucketLabel} ${remainderNote}`
                  : '100% allocated'}
            </span>
          ) : (
            <span className="text-xs tabular-nums text-smoke-700">
              {total > 0
                ? `${total.toLocaleString('en-US')} ${amountLabel} total · the rest stays in the project`
                : ''}
            </span>
          )
        ) : null}
      </div>
    </div>
  )
}
