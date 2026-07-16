'use client'

import { isAddress } from 'viem'
import { AddButton } from './ui'

/**
 * Shared split-row editor for reserved tokens, routed payouts, and item
 * sale splits. Each row picks a recipient type first (website/ parity):
 * an address, or a project — which also needs a token beneficiary (who
 * receives the tokens the paid project issues). Percentages are out of 100
 * of the bucket being split; any unallocated remainder goes to the owner.
 */

export type SplitsMode = 'percent' | 'amount'

export type DraftSplit = {
  id: number
  /** Percent (0–100) in 'percent' mode; a currency amount in 'amount' mode. */
  value: string
  kind: 'address' | 'project'
  /** The receiving address ('address' kind). */
  recipient: string
  /** The receiving project id ('project' kind). */
  projectId: string
  /** Who receives the paid project's tokens ('project' kind, required). */
  beneficiary: string
}

let nextId = 1

export function newDraftSplit(): DraftSplit {
  return {
    id: nextId++,
    value: '',
    kind: 'address',
    recipient: '',
    projectId: '',
    beneficiary: '',
  }
}

export function splitValueOk(value: string, mode: SplitsMode): boolean {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return false
  return mode === 'percent' ? n <= 100 : true
}

function projectIdOk(projectId: string): boolean {
  return /^#?\d{1,10}$/.test(projectId.trim()) && Number(projectId.replace('#', '')) > 0
}

export function splitOk(split: DraftSplit, mode: SplitsMode): boolean {
  if (!splitValueOk(split.value, mode)) return false
  return split.kind === 'address'
    ? isAddress(split.recipient.trim())
    : projectIdOk(split.projectId) && isAddress(split.beneficiary.trim())
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
        <div
          key={split.id}
          className="mt-2 rounded-lg border border-smoke-200 bg-white p-2.5"
        >
          <div className="flex items-start gap-2">
            <input
              type="text"
              inputMode="decimal"
              value={split.value}
              onChange={e => update(split.id, { value: e.target.value.slice(0, 10) })}
              disabled={disabled}
              placeholder={mode === 'percent' ? '%' : amountLabel}
              aria-label={mode === 'percent' ? 'Percent' : `Amount (${amountLabel})`}
              className={`input-well min-h-[44px] w-20 shrink-0 px-3 text-sm tabular-nums disabled:opacity-60 ${
                split.value && !splitValueOk(split.value, mode)
                  ? '!border-red-400'
                  : ''
              }`}
            />
            <span className="mt-3 shrink-0 text-sm text-smoke-700">to</span>
            <select
              value={split.kind}
              onChange={e =>
                update(split.id, { kind: e.target.value as DraftSplit['kind'] })
              }
              disabled={disabled}
              aria-label="Recipient type"
              className="input-well select-caret min-h-[44px] w-28 shrink-0 px-3 pr-8 text-sm disabled:opacity-60"
            >
              <option value="address">Address</option>
              <option value="project">Project</option>
            </select>
            {split.kind === 'address' ? (
              <input
                type="text"
                value={split.recipient}
                onChange={e =>
                  update(split.id, { recipient: e.target.value.trim().slice(0, 64) })
                }
                disabled={disabled}
                placeholder="0x…"
                aria-label="Recipient address"
                className={`input-well min-h-[44px] min-w-0 flex-1 px-3 font-mono text-xs disabled:opacity-60 ${
                  split.recipient && !isAddress(split.recipient.trim())
                    ? '!border-red-400'
                    : ''
                }`}
              />
            ) : (
              <input
                type="text"
                inputMode="numeric"
                value={split.projectId}
                onChange={e =>
                  update(split.id, { projectId: e.target.value.trim().slice(0, 11) })
                }
                disabled={disabled}
                placeholder="#12"
                aria-label="Project id"
                className={`input-well min-h-[44px] w-24 px-3 text-sm tabular-nums disabled:opacity-60 ${
                  split.projectId && !projectIdOk(split.projectId)
                    ? '!border-red-400'
                    : ''
                }`}
              />
            )}
            <button
              onClick={() => onChange(splits.filter(s => s.id !== split.id))}
              disabled={disabled}
              aria-label="Remove recipient"
              className="mt-3 shrink-0 text-xs font-medium text-smoke-700 underline underline-offset-2 hover:text-ink disabled:opacity-60"
            >
              Remove
            </button>
          </div>
          {split.kind === 'project' ? (
            <div className="mt-2 flex items-center gap-2">
              <span className="shrink-0 text-xs text-smoke-700">
                who gets the project&apos;s tokens:
              </span>
              <input
                type="text"
                value={split.beneficiary}
                onChange={e =>
                  update(split.id, {
                    beneficiary: e.target.value.trim().slice(0, 42),
                  })
                }
                disabled={disabled}
                placeholder="0x…"
                aria-label="Token beneficiary"
                className={`input-well min-h-[40px] min-w-0 flex-1 px-3 font-mono text-xs disabled:opacity-60 ${
                  split.beneficiary && !isAddress(split.beneficiary.trim())
                    ? '!border-red-400'
                    : ''
                }`}
              />
            </div>
          ) : null}
        </div>
      ))}

      <div className="mt-2 flex flex-wrap items-baseline justify-between gap-2">
        <AddButton
          onClick={() => onChange([...splits, newDraftSplit()])}
          disabled={disabled}
        >
          Add a recipient
        </AddButton>
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
