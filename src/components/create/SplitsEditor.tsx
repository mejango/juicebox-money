'use client'

import { resolvedAddress } from '@/lib/ens'
import { chainName } from '@/lib/urn'
import { ChainIcon } from '@/components/ChainIcon'
import { AddressField, ProjectIdField } from './AddressField'
import { AddButton, Piped } from './ui'

/**
 * Shared split-row editor for reserved tokens, routed payouts, and item
 * sale splits. Each row picks a recipient type first (website/ parity):
 * an address (ENS names resolve), or a project — which also needs a token
 * beneficiary. On multichain launches every row can override its recipient
 * per chain, in case the same address doesn't represent the entity
 * everywhere. Percentages are out of 100 of the bucket being split; any
 * unallocated remainder goes to the owner.
 */

export type SplitsMode = 'percent' | 'amount'

export type DraftSplit = {
  id: string
  /** Percent (0–100) in 'percent' mode; a currency amount in 'amount' mode. */
  value: string
  kind: 'address' | 'project'
  /** The receiving address ('address' kind) — 0x… or an ENS name. */
  recipient: string
  /** The receiving project id ('project' kind). */
  projectId: string
  /** Who receives the paid project's tokens ('project' kind, required). */
  beneficiary: string
  /** Per-chain overrides of the identity field (address or project id). */
  perChain: Record<number, string>
  /** Per-chain overrides of the token beneficiary ('project' kind). */
  perChainBeneficiary: Record<number, string>
  perChainOpen: boolean
}

export function newDraftSplit(): DraftSplit {
  return {
    id: crypto.randomUUID(),
    value: '',
    kind: 'address',
    recipient: '',
    projectId: '',
    beneficiary: '',
    perChain: {},
    perChainBeneficiary: {},
    perChainOpen: false,
  }
}

export function splitValueOk(value: string, mode: SplitsMode): boolean {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return false
  return mode === 'percent' ? n <= 100 : true
}

function projectIdOk(projectId: string): boolean {
  return (
    /^#?\d{1,10}$/.test(projectId.trim()) &&
    Number(projectId.replace('#', '')) > 0
  )
}

export function splitOk(split: DraftSplit, mode: SplitsMode): boolean {
  if (!splitValueOk(split.value, mode)) return false
  const overrides = Object.values(split.perChain).filter(v => v.trim() !== '')
  if (split.kind === 'address') {
    return (
      resolvedAddress(split.recipient) !== null &&
      overrides.every(v => resolvedAddress(v) !== null)
    )
  }
  const beneficiaryOverrides = Object.values(split.perChainBeneficiary).filter(
    v => v.trim() !== '',
  )
  return (
    projectIdOk(split.projectId) &&
    resolvedAddress(split.beneficiary) !== null &&
    overrides.every(projectIdOk) &&
    beneficiaryOverrides.every(v => resolvedAddress(v) !== null)
  )
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
  chainIds,
  addLabel = 'Add a recipient',
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
  /** Selected launch chains; >1 enables per-chain recipient overrides. */
  chainIds?: number[]
  addLabel?: string
}) {
  const update = (id: string, patch: Partial<DraftSplit>) => {
    onChange(splits.map(s => (s.id === id ? { ...s, ...patch } : s)))
  }
  const total = splitsTotal(splits, mode)
  const multiChain = (chainIds?.length ?? 0) > 1

  return (
    <div>
      {splits.map(split => (
        <div
          key={split.id}
          className="mt-2 rounded-lg border border-smoke-200 bg-smoke-75 p-2.5"
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
            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 items-start gap-2">
                  <select
                    value={split.kind}
                    onChange={e =>
                      update(split.id, {
                        kind: e.target.value as DraftSplit['kind'],
                        perChain: {},
                        perChainBeneficiary: {},
                      })
                    }
                    disabled={disabled}
                    aria-label="Recipient type"
                    className="input-well select-caret min-h-[44px] w-28 shrink-0 px-3 pr-8 text-sm disabled:opacity-60"
                  >
                    <option value="address">Address</option>
                    <option value="project">Project</option>
                  </select>
                  {split.kind === 'project' ? (
                    <ProjectIdField
                      value={split.projectId}
                      onChange={projectId => update(split.id, { projectId })}
                      disabled={disabled}
                      chainId={chainIds?.[0] ?? 1}
                      className="w-28"
                    />
                  ) : null}
                </div>
                <button
                  onClick={() => onChange(splits.filter(s => s.id !== split.id))}
                  disabled={disabled}
                  aria-label="Remove recipient"
                  className="mt-3 shrink-0 text-xs font-medium text-smoke-700 underline underline-offset-2 hover:text-ink disabled:opacity-60"
                >
                  Remove
                </button>
              </div>

              {split.kind === 'address' ? (
                <div className="mt-2">
                  <AddressField
                    value={split.recipient}
                    onChange={recipient => update(split.id, { recipient })}
                    disabled={disabled}
                    ariaLabel="Recipient address"
                  />
                </div>
              ) : null}

              {split.kind === 'project' ? (
                <div className="mt-2 flex items-center gap-2">
                  <span className="shrink-0 text-xs text-smoke-700">
                    who gets the project&apos;s tokens:
                  </span>
                  <AddressField
                    value={split.beneficiary}
                    onChange={beneficiary => update(split.id, { beneficiary })}
                    disabled={disabled}
                    ariaLabel="Token beneficiary"
                    className="flex-1"
                    compact
                  />
                </div>
              ) : null}

              {multiChain ? (
                <div className="mt-2">
                  <button
                    onClick={() =>
                      update(split.id, { perChainOpen: !split.perChainOpen })
                    }
                    disabled={disabled}
                    aria-expanded={split.perChainOpen}
                    className="text-[11px] font-medium text-bluebs-600 hover:text-bluebs-700 disabled:opacity-60"
                  >
                    {split.perChainOpen
                      ? 'Same on every chain'
                      : `Set per chain — if this ${split.kind === 'address' ? 'address' : 'project id'} differs by chain`}
                  </button>
                  {split.perChainOpen ? (
                    <div className="mt-2 space-y-2">
                      {chainIds!.map(chainId => (
                        <div key={chainId} className="flex items-start gap-2">
                          <span className="mt-3.5 flex w-28 shrink-0 items-center gap-1.5 text-xs text-smoke-700">
                            <ChainIcon chainId={chainId} size={14} />
                            {chainName(chainId)}
                          </span>
                          {split.kind === 'address' ? (
                            <AddressField
                              value={split.perChain[chainId] ?? ''}
                              onChange={v =>
                                update(split.id, {
                                  perChain: { ...split.perChain, [chainId]: v },
                                })
                              }
                              disabled={disabled}
                              placeholder={split.recipient.trim() || 'default'}
                              ariaLabel={`Recipient on ${chainName(chainId)}`}
                              className="flex-1"
                              compact
                            />
                          ) : (
                            <div className="min-w-0 flex-1">
                              <ProjectIdField
                                value={split.perChain[chainId] ?? ''}
                                onChange={v =>
                                  update(split.id, {
                                    perChain: { ...split.perChain, [chainId]: v },
                                  })
                                }
                                disabled={disabled}
                                chainId={chainId}
                                className="w-24"
                              />
                              <AddressField
                                value={split.perChainBeneficiary[chainId] ?? ''}
                                onChange={v =>
                                  update(split.id, {
                                    perChainBeneficiary: {
                                      ...split.perChainBeneficiary,
                                      [chainId]: v,
                                    },
                                  })
                                }
                                disabled={disabled}
                                placeholder={
                                  split.beneficiary.trim() || 'beneficiary'
                                }
                                ariaLabel={`Beneficiary on ${chainName(chainId)}`}
                                className="mt-2"
                                compact
                              />
                            </div>
                          )}
                        </div>
                      ))}
                      <p className="text-[11px] leading-relaxed text-smoke-500">
                        Empty fields use the default above.
                      </p>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ))}

      <div className="mt-2 flex flex-wrap items-baseline justify-between gap-2">
        <AddButton
          onClick={() => onChange([...splits, newDraftSplit()])}
          disabled={disabled}
        >
          {addLabel}
        </AddButton>
        {splits.length > 0 ? (
          mode === 'percent' ? (
            <span
              className={`text-xs tabular-nums ${total > 100 ? 'font-medium text-red-600' : 'text-smoke-700'}`}
            >
              {total > 100 ? (
                `${total}% — over 100%`
              ) : total < 100 ? (
                <Piped
                  text={`${total}% allocated | remaining ${bucketLabel} ${remainderNote}`}
                />
              ) : (
                '100% allocated'
              )}
            </span>
          ) : (
            <span className="text-xs tabular-nums text-smoke-700">
              {total > 0 ? (
                <Piped
                  text={`${total.toLocaleString('en-US')} ${amountLabel} total | the rest stays in the project`}
                />
              ) : (
                ''
              )}
            </span>
          )
        ) : null}
      </div>
    </div>
  )
}
