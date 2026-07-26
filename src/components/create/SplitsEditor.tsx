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
  kind: 'address' | 'project' | 'hook'
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
  /** Per-chain amount overrides ('amount' mode payout rows). */
  perChainAmount: Record<number, string>
  perChainOpen: boolean
  /** 'hook' kind: the Fund market LP hook, or a custom hook address. */
  hookKind: 'fundmarket' | 'custom'
  hookAddress: string
  /** Project payout routing: pay (default) or add to balance. */
  preferAddToBalance: boolean
  /** Lock this split until a date (datetime-local; '' = unlocked). */
  lockedUntil: string
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
    perChainAmount: {},
    perChainOpen: false,
    hookKind: 'fundmarket',
    hookAddress: '',
    preferAddToBalance: false,
    lockedUntil: '',
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
  if (split.lockedUntil && Number.isNaN(new Date(split.lockedUntil).getTime()))
    return false
  const overrides = Object.values(split.perChain).filter(v => v.trim() !== '')
  if (split.kind === 'address') {
    return (
      resolvedAddress(split.recipient) !== null &&
      overrides.every(v => resolvedAddress(v) !== null)
    )
  }
  if (split.kind === 'hook') {
    if (split.hookKind === 'fundmarket') return true
    return (
      resolvedAddress(split.hookAddress) !== null &&
      // Optional project + beneficiary riders must be valid when set.
      (split.projectId.trim() === '' || projectIdOk(split.projectId)) &&
      (split.beneficiary.trim() === '' ||
        resolvedAddress(split.beneficiary) !== null)
    )
  }
  const beneficiaryOverrides = Object.values(split.perChainBeneficiary).filter(
    v => v.trim() !== '',
  )
  return (
    projectIdOk(split.projectId) &&
    (split.preferAddToBalance ||
      resolvedAddress(split.beneficiary) !== null) &&
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
  allocatedLabel = 'allocated',
  allowHook = false,
  allowFundMarket = false,
  showRouting = false,
  allowLock = false,
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
  /** Word after the total percent, e.g. 'allocated' or 'split limit'. */
  allocatedLabel?: string
  /** Offer split-hook recipients. */
  allowHook?: boolean
  /** Offer the Fund market LP hook preset (reserved-token splits). */
  allowFundMarket?: boolean
  /** Offer Pay vs Add-to-balance routing on project rows (payouts). */
  showRouting?: boolean
  /** Offer per-split locks (fixed-duration stages). */
  allowLock?: boolean
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
                    {allowHook ? <option value="hook">Hook</option> : null}
                  </select>
                  {split.kind === 'hook' && allowFundMarket ? (
                    <select
                      value={split.hookKind}
                      onChange={e =>
                        update(split.id, {
                          hookKind: e.target.value as DraftSplit['hookKind'],
                        })
                      }
                      disabled={disabled}
                      aria-label="Hook type"
                      className="input-well select-caret min-h-[44px] w-36 shrink-0 px-3 pr-8 text-sm disabled:opacity-60"
                    >
                      <option value="fundmarket">Fund market</option>
                      <option value="custom">Custom</option>
                    </select>
                  ) : null}
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

              {split.kind === 'hook' ? (
                split.hookKind === 'fundmarket' && allowFundMarket ? (
                  <p className="mt-2 rounded-lg bg-smoke-75 px-3 py-2 text-[11px] leading-relaxed text-smoke-700">
                    Pools split tokens into a Uniswap V4 buyback position.
                    Trading fees route back to your project.
                  </p>
                ) : (
                  <div className="mt-2 space-y-2">
                    <AddressField
                      value={split.hookAddress}
                      onChange={hookAddress => update(split.id, { hookAddress })}
                      disabled={disabled}
                      placeholder="0x… (split hook contract)"
                      ariaLabel="Split hook address"
                    />
                    <div className="flex items-center gap-2">
                      <span className="shrink-0 text-xs text-smoke-700">
                        with project (optional):
                      </span>
                      <ProjectIdField
                        value={split.projectId}
                        onChange={projectId => update(split.id, { projectId })}
                        disabled={disabled}
                        chainId={chainIds?.[0] ?? 1}
                        className="w-24"
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="shrink-0 text-xs text-smoke-700">
                        and beneficiary (optional):
                      </span>
                      <AddressField
                        value={split.beneficiary}
                        onChange={beneficiary =>
                          update(split.id, { beneficiary })
                        }
                        disabled={disabled}
                        ariaLabel="Hook beneficiary"
                        className="flex-1"
                        compact
                      />
                    </div>
                  </div>
                )
              ) : null}

              {split.kind === 'project' && showRouting ? (
                <div className="mt-2 flex items-center gap-2">
                  <span className="shrink-0 text-xs text-smoke-700">route as:</span>
                  <select
                    value={split.preferAddToBalance ? 'balance' : 'pay'}
                    onChange={e =>
                      update(split.id, {
                        preferAddToBalance: e.target.value === 'balance',
                      })
                    }
                    disabled={disabled}
                    aria-label="Payout routing"
                    className="input-well select-caret min-h-[40px] w-40 px-3 pr-8 text-xs disabled:opacity-60"
                  >
                    <option value="pay">Pay (mints tokens)</option>
                    <option value="balance">Add to balance</option>
                  </select>
                </div>
              ) : null}

              {split.kind === 'project' && !split.preferAddToBalance ? (
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

              {allowLock ? (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <label className="flex items-center gap-1.5 text-[11px] font-medium text-smoke-700">
                    <input
                      type="checkbox"
                      checked={split.lockedUntil !== ''}
                      onChange={e =>
                        update(split.id, {
                          lockedUntil: e.target.checked
                            ? new Date(Date.now() + 30 * 86_400_000)
                                .toISOString()
                                .slice(0, 16)
                            : '',
                        })
                      }
                      disabled={disabled}
                      className="h-3.5 w-3.5 accent-ink"
                    />
                    Lock until
                  </label>
                  {split.lockedUntil !== '' ? (
                    <input
                      type="datetime-local"
                      value={split.lockedUntil}
                      onChange={e =>
                        update(split.id, { lockedUntil: e.target.value })
                      }
                      disabled={disabled}
                      className="input-well min-h-[36px] px-2.5 text-xs disabled:opacity-60"
                    />
                  ) : (
                    <span className="text-[11px] text-smoke-500">
                      — locked splits can&apos;t be removed until the date
                      passes
                    </span>
                  )}
                </div>
              ) : null}

              {multiChain && split.kind !== 'hook' ? (
                <div className="-ml-[7.5rem] mt-2 border-l-2 border-smoke-200 pl-3 sm:ml-0 sm:border-l-0 sm:pl-0">
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
                        <div key={chainId} className="flex items-start gap-1.5">
                          <span className="mt-2 flex w-7 shrink-0 items-center justify-center">
                            <ChainIcon chainId={chainId} size={24} />
                          </span>
                          {mode === 'amount' ? (
                            <>
                              <input
                                type="text"
                                inputMode="decimal"
                                value={split.perChainAmount[chainId] ?? ''}
                                onChange={e =>
                                  update(split.id, {
                                    perChainAmount: {
                                      ...split.perChainAmount,
                                      [chainId]: e.target.value.slice(0, 10),
                                    },
                                  })
                                }
                                disabled={disabled}
                                placeholder={split.value.trim() || amountLabel}
                                aria-label={`Amount on ${chainName(chainId)}`}
                                className="input-well min-h-[40px] w-16 shrink-0 px-2.5 text-xs tabular-nums disabled:opacity-60 sm:w-24"
                              />
                              <span className="mt-2.5 shrink-0 text-xs text-smoke-700">
                                to
                              </span>
                            </>
                          ) : null}
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
                      <p className="pl-[34px] text-[11px] leading-relaxed text-smoke-500">
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
                  text={`${total}% ${allocatedLabel} | remaining ${bucketLabel} ${remainderNote}`}
                />
              ) : (
                `100% ${allocatedLabel}`
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
