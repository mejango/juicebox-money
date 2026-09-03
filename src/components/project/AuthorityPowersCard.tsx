'use client'

import {
  JBCoreContracts,
  jbContractAddress,
  jbControllerAbi,
  jbDirectoryAbi,
  jbMultiTerminalAbi,
} from '@bananapus/nana-sdk-core'
import { getCurrentRuleset } from '@bananapus/nana-sdk-core/v6'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { parseUnits, type Address } from 'viem'
import { ChainIcon } from '@/components/ChainIcon'
import { ActionRowsSkeleton } from '@/components/LoadingSkeletons'
import type { AuthorityDeployment } from '@/components/project/AuthorityOverview'
import { ChainPicker } from '@/components/ui/ChainPicker'
import { PerChainAddressField } from '@/components/ui/PerChainAddressField'
import { PerChainAddressListField } from '@/components/ui/PerChainAddressListField'
import { TxConfirmDialog, type TxConfirmRow } from '@/components/ui/TxConfirmDialog'
import { ErrorNote } from '@/components/ui/TxError'
import {
  POWERS,
  initialFieldValue,
  parseAddressList,
  type PowerDescriptor,
  type PowerFlag,
  type ResolvedValues,
} from '@/lib/projectPowers'
import { useWallet } from '@/hooks/useWallet'
import {
  clientFor,
  readAuthorityOf,
  runAuthorityCalls,
  safeOutcomeMessage,
  type AuthorityCall,
} from '@/lib/authority'
import { resolvedAddress } from '@/lib/ens'
import { truncateAddress } from '@/lib/format'
import { buildProjectPowerAuthorityCall } from '@/lib/transaction-builders'
import { chainName } from '@/lib/urn'

type PowerChainState = AuthorityDeployment & {
  name: string
  authority: Address | null
  controller: Address | null
  /** The project's CURRENT terminal list — `setTerminalsOf` replaces it wholesale. */
  terminals: readonly Address[] | null
  metadata: Partial<Record<PowerFlag, boolean>> | null
  error: string | null
}

async function readPowerState(
  deployment: AuthorityDeployment,
): Promise<PowerChainState> {
  const client = clientFor(deployment.chainId)
  const [authority, controller, terminals, ruleset] = await Promise.all([
    readAuthorityOf(client, deployment),
    client
      .readContract({
        address: jbContractAddress['6'][JBCoreContracts.JBDirectory][
          deployment.chainId
        ],
        abi: jbDirectoryAbi,
        functionName: 'controllerOf',
        args: [BigInt(deployment.projectId)],
      })
      .catch(() => null),
    // "Set terminals" replaces the whole list, so the form has to start from the live
    // one. Read here rather than in the form: a failure must NOT prefill an empty list.
    client
      .readContract({
        address: jbContractAddress['6'][JBCoreContracts.JBDirectory][
          deployment.chainId
        ],
        abi: jbDirectoryAbi,
        functionName: 'terminalsOf',
        args: [BigInt(deployment.projectId)],
      })
      .catch(() => null),
    getCurrentRuleset(client, {
      chainId: deployment.chainId,
      projectId: BigInt(deployment.projectId),
    }).catch(() => null),
  ])
  return {
    ...deployment,
    name: chainName(deployment.chainId),
    authority,
    controller: (controller as Address | null) ?? null,
    terminals: (terminals as readonly Address[] | null) ?? null,
    metadata: ruleset?.metadata ?? null,
    error:
      !authority || !controller || !ruleset
        ? 'Could not verify owner, controller, and current rules.'
        : null,
  }
}

function flagState(row: PowerChainState, flag: PowerFlag): boolean {
  return row.metadata?.[flag] === true
}

export function AuthorityPowersCard({
  deployments,
}: {
  deployments: AuthorityDeployment[]
}) {
  const query = useQuery({
    queryKey: [
      'authorityPowers',
      deployments
        .map(row => `${row.chainId}:${row.projectId}:${row.indexedAuthority ?? ''}`)
        .join(','),
    ],
    staleTime: 30_000,
    retry: 1,
    queryFn: () => Promise.all(deployments.map(readPowerState)),
  })
  const rows = query.data ?? []
  const [open, setOpen] = useState<PowerFlag | null>(null)

  return (
    <section className="card p-5">
      <span className="field-label">Powers</span>
      <p className="mt-2 text-sm leading-relaxed text-smoke-700">
        What each chain’s current rules let the owner do. Enabled powers can be
        used here; disabled ones need a ruleset change. Chain differences stay
        visible and every write follows the same Safe/Relayr path.
      </p>

      {query.isLoading ? (
        <ActionRowsSkeleton rows={5} label="Loading owner powers" />
      ) : query.isError ? (
        <p className="mt-4 text-sm text-red-700">
          Could not load the current owner powers.
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-smoke-100">
          {POWERS.map(power => (
            <PowerRow
              key={power.flag}
              power={power}
              rows={rows}
              open={open === power.flag}
              onToggle={() =>
                setOpen(current => (current === power.flag ? null : power.flag))
              }
              onDone={() => query.refetch()}
            />
          ))}
        </ul>
      )}
    </section>
  )
}

function PowerRow({
  power,
  rows,
  open,
  onToggle,
  onDone,
}: {
  power: PowerDescriptor
  rows: PowerChainState[]
  open: boolean
  onToggle: () => void
  onDone: () => void
}) {
  const enabledRows = rows.filter(row => flagState(row, power.flag))
  const differs =
    enabledRows.length > 0 && enabledRows.length !== rows.length
  const allEnabled = enabledRows.length === rows.length && rows.length > 0

  return (
    <li className="py-4 first:pt-0 last:pb-0">
      <div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium text-ink">{power.label}</p>
            {allEnabled ? (
              <span className="rounded-full bg-green-50 px-2 py-0.5 text-[11px] font-medium text-green-700">
                Enabled on all chains
              </span>
            ) : enabledRows.length === 0 ? (
              <span className="rounded-full bg-smoke-100 px-2 py-0.5 text-[11px] font-medium text-smoke-700">
                Disabled on all chains
              </span>
            ) : (
              <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                Differs by chain
              </span>
            )}
          </div>
          <p className="mt-1 text-xs leading-relaxed text-smoke-700">
            {power.desc}
          </p>
          {differs ? (
            <div className="mt-2 flex flex-wrap gap-2">
              {rows.map(row => (
                <span
                  key={row.chainId}
                  className={`inline-flex items-center gap-1.5 text-xs ${
                    flagState(row, power.flag)
                      ? 'text-green-700'
                      : 'text-smoke-500'
                  }`}
                >
                  <ChainIcon chainId={row.chainId} size={16} />
                  {row.name}: {flagState(row, power.flag) ? 'enabled' : 'disabled'}
                </span>
              ))}
            </div>
          ) : null}
        </div>
        {enabledRows.length ? (
          <button
            type="button"
            onClick={onToggle}
            className="mt-3 min-h-[36px] rounded-xl border border-red-300 px-3 text-xs font-medium text-red-700 transition-colors hover:bg-red-50"
          >
            {open ? 'Close' : power.actionLabel}
          </button>
        ) : null}
      </div>

      {open ? (
        <PowerActionForm
          power={power}
          rows={rows}
          onCancel={onToggle}
          onDone={onDone}
        />
      ) : null}
    </li>
  )
}

function PowerActionForm({
  power,
  rows,
  onCancel,
  onDone,
}: {
  power: PowerDescriptor
  rows: PowerChainState[]
  onCancel: () => void
  onDone: () => void
}) {
  const { address } = useWallet()
  const enabledRows = useMemo(
    () => rows.filter(row => flagState(row, power.flag) && !row.error),
    [power.flag, rows],
  )
  const [selected, setSelected] = useState<Set<number>>(
    () => new Set(enabledRows.map(row => row.chainId)),
  )
  const [scalars, setScalars] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      power.fields
        .filter(
          field =>
            field.kind !== 'address' &&
            field.kind !== 'addressList' &&
            field.kind !== 'bool',
        )
        .map(field => [field.name, field.initial ?? '']),
    ),
  )
  const [bools, setBools] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(
      power.fields
        .filter(field => field.kind === 'bool')
        .map(field => [field.name, false]),
    ),
  )
  const [addresses, setAddresses] = useState<
    Record<string, Record<number, string>>
  >(() =>
    Object.fromEntries(
      power.fields
        .filter(field => field.kind === 'address' || field.kind === 'addressList')
        .map(field => [
          field.name,
          Object.fromEntries(
            enabledRows.map(row => [row.chainId, initialFieldValue(field, row, address)]),
          ),
        ]),
    ),
  )
  const [review, setReview] = useState<{
    calls: AuthorityCall[]
    rows: TxConfirmRow[]
  } | null>(null)
  const [done, setDone] = useState(false)
  const [ack, setAck] = useState(false)
  const [ackExtreme, setAckExtreme] = useState(false)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!address) return
    setAddresses(current => {
      const next = { ...current }
      let changed = false
      for (const field of power.fields) {
        if (field.kind !== 'address' || field.initial !== 'ADDR_CONNECTED') continue
        const values = { ...(next[field.name] ?? {}) }
        for (const row of enabledRows) {
          if (!values[row.chainId]) {
            values[row.chainId] = address
            changed = true
          }
        }
        next[field.name] = values
      }
      return changed ? next : current
    })
  }, [address, enabledRows, power.fields])

  useEffect(() => {
    setReview(null)
    setAck(false)
    setAckExtreme(false)
  }, [selected, scalars, bools, addresses])

  const resolveSharedValues = (): ResolvedValues => {
    const values: ResolvedValues = {}
    for (const field of power.fields) {
      if (field.kind === 'address' || field.kind === 'addressList') continue
      if (field.kind === 'bool') {
        values[field.name] = bools[field.name] ?? false
        continue
      }
      const raw = (scalars[field.name] ?? '').trim()
      if (field.kind === 'amount') {
        let amount: bigint
        try {
          amount = parseUnits(raw, 18)
        } catch {
          throw new Error(`Enter a valid token amount for “${field.label}”.`)
        }
        if (amount <= 0n) throw new Error(`“${field.label}” must be above zero.`)
        values[field.name] = amount
      } else if (field.kind === 'uint') {
        if (!/^\d+$/.test(raw)) {
          throw new Error(`“${field.label}” must be a whole number.`)
        }
        values[field.name] = BigInt(raw)
      } else {
        if (!/^\d+$/.test(raw)) {
          throw new Error(`“${field.label}” must be a whole number.`)
        }
        const decimals = Number(raw)
        if (decimals < 0 || decimals > 32) {
          throw new Error('Decimals must be between 0 and 32.')
        }
        values[field.name] = decimals
      }
    }
    return values
  }

  const buildReview = () => {
    setError(null)
    setStatus(null)
    const chosen = enabledRows.filter(row => selected.has(row.chainId))
    if (!chosen.length) {
      setError('Choose at least one enabled chain.')
      return
    }
    try {
      const shared = resolveSharedValues()
      const calls: AuthorityCall[] = []
      const reviewRows: TxConfirmRow[] = [{ label: 'Power', value: power.label }]
      for (const field of power.fields) {
        if (field.kind === 'address' || field.kind === 'addressList') continue
        reviewRows.push({
          label: field.label,
          value:
            field.kind === 'bool'
              ? bools[field.name]
                ? 'Yes'
                : 'No'
              : (scalars[field.name] ?? '').trim(),
        })
      }
      for (const row of chosen) {
        if (!row.authority || !row.controller) {
          throw new Error(`${row.name}: owner or controller is unknown.`)
        }
        const values: ResolvedValues = { ...shared }
        const display: string[] = []
        for (const field of power.fields) {
          const raw = addresses[field.name]?.[row.chainId] ?? ''
          if (field.kind === 'addressList') {
            const list = parseAddressList(raw)
            if (!list) {
              throw new Error(
                `${row.name}: list at least one valid address for “${field.label}”.`,
              )
            }
            values[field.name] = list
            display.push(
              `${field.label} ${list.map(truncateAddress).join(', ')}`,
            )
            continue
          }
          if (field.kind !== 'address') continue
          const value = resolvedAddress(raw)
          if (!value) {
            throw new Error(`${row.name}: enter a valid address for “${field.label}”.`)
          }
          values[field.name] = value
          display.push(`${field.label} ${truncateAddress(value)}`)
        }

        const target =
          power.target === 'controller'
            ? row.controller
            : power.target === 'directory'
              ? (jbContractAddress['6'][JBCoreContracts.JBDirectory][
                  row.chainId
                ] as Address)
              : (jbContractAddress['6'][JBCoreContracts.JBMultiTerminal][
                  row.chainId
                ] as Address)
        const abi =
          power.target === 'controller'
            ? jbControllerAbi
            : power.target === 'directory'
              ? jbDirectoryAbi
              : jbMultiTerminalAbi
        const args = power.buildArgs(BigInt(row.projectId), values)
        calls.push(
          buildProjectPowerAuthorityCall({
            chainId: row.chainId,
            authority: row.authority,
            target,
            abi,
            functionName: power.functionName,
            args,
            contractName:
              power.target === 'controller'
                ? 'JBController'
                : power.target === 'directory'
                  ? 'JBDirectory'
                  : 'JBMultiTerminal',
            gas:
              power.flag === 'allowAddAccountingContext' ? 300_000n : 500_000n,
            label: power.actionLabel,
          }),
        )
        if (display.length) {
          reviewRows.push({ label: row.name, value: display.join(' | '), mono: true })
        }
      }
      reviewRows.push({ label: 'On', value: chosen.map(row => row.name).join(', ') })
      setReview({ calls, rows: reviewRows })
    } catch (reviewError) {
      setError(
        reviewError instanceof Error
          ? reviewError.message
          : 'Could not review this owner power.',
      )
    }
  }

  const submit = async () => {
    if (!review || !ack || (power.extreme && !ackExtreme) || busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await runAuthorityCalls({
        calls: review.calls,
        onProgress: progress => setStatus(progress.message),
      })
      setStatus(
        safeOutcomeMessage(
          result,
          `${power.label} completed on ${review.calls.length} chain${
            review.calls.length === 1 ? '' : 's'
          }.`,
        ),
      )
      setDone(true)
      onDone()
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : 'Could not complete this owner action.',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-4 rounded-xl border border-red-200 p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-ink">{power.actionLabel}</p>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="text-xs text-smoke-700 hover:text-ink"
        >
          Cancel
        </button>
      </div>

      <ChainPicker
        className="mt-4"
        label="Run on"
        rows={rows.map(row => ({
          chainId: row.chainId,
          name: (
            <>
              {row.name}
              {!flagState(row, power.flag) ? (
                <span className="text-xs text-smoke-500">disabled</span>
              ) : null}
            </>
          ),
          disabled: !(flagState(row, power.flag) && !row.error),
        }))}
        selected={selected}
        onChange={setSelected}
        disabled={busy}
      />

      <div className="mt-4 space-y-4">
        {power.fields.map(field =>
          field.kind === 'addressList' ? (
            <PerChainAddressListField
              key={field.name}
              fieldLabel={field.label}
              rows={enabledRows}
              selected={selected}
              values={addresses[field.name] ?? {}}
              onChange={values =>
                setAddresses(current => ({ ...current, [field.name]: values }))
              }
              disabled={busy}
              placeholder={field.placeholder}
              help={field.help}
            />
          ) : field.kind === 'address' ? (
            <PerChainAddressField
              key={field.name}
              fieldLabel={field.label}
              rows={enabledRows}
              selected={selected}
              values={addresses[field.name] ?? {}}
              onChange={values =>
                setAddresses(current => ({ ...current, [field.name]: values }))
              }
              disabled={busy}
              placeholder={field.placeholder}
              help={field.help}
            />
          ) : field.kind === 'bool' ? (
            <label key={field.name} className="flex items-start gap-2.5">
              <input
                type="checkbox"
                checked={bools[field.name] ?? false}
                onChange={event =>
                  setBools(current => ({
                    ...current,
                    [field.name]: event.target.checked,
                  }))
                }
                disabled={busy}
                className="mt-0.5 accent-bluebs-600"
              />
              <span className="text-xs leading-relaxed text-smoke-700">
                <span className="font-medium text-ink">{field.label}</span>
                {field.help ? <span className="block">{field.help}</span> : null}
              </span>
            </label>
          ) : (
            <label key={field.name} className="block">
              <span className="field-label">{field.label}</span>
              <input
                type="text"
                inputMode={field.kind === 'amount' ? 'decimal' : 'numeric'}
                value={scalars[field.name] ?? ''}
                onChange={event =>
                  setScalars(current => ({
                    ...current,
                    [field.name]: event.target.value,
                  }))
                }
                disabled={busy}
                placeholder={field.placeholder}
                className="input-well mt-1.5 min-h-[42px] w-full px-3 text-sm disabled:opacity-60"
              />
              {field.help ? (
                <span className="mt-1 block text-xs text-smoke-500">
                  {field.help}
                </span>
              ) : null}
            </label>
          ),
        )}
      </div>

      <button
        type="button"
        onClick={buildReview}
        disabled={busy || !selected.size}
        className="btn-primary mt-3 min-h-[44px] w-full text-sm"
      >
        Review {power.actionLabel.toLowerCase()}
      </button>
      {status && !review ? (
        <p className="mt-2 text-xs text-smoke-700">{status}</p>
      ) : null}
      {error && !review ? <ErrorNote message={error} /> : null}

      {review ? (
        <TxConfirmDialog
          open
          title={
            done ? `${power.label} complete` : `Confirm ${power.actionLabel.toLowerCase()}`
          }
          rows={review.rows}
          steps={review.calls.map(call => ({
            key: String(call.chainId),
            title: `${power.actionLabel} on ${chainName(call.chainId)}`,
          }))}
          activeIndex={busy ? 0 : -1}
          status={status}
          error={error}
          busy={busy}
          complete={done}
          action={error ? 'Retry' : power.actionLabel}
          actionDisabled={!ack || (power.extreme && !ackExtreme)}
          onConfirm={() => void submit()}
          onClose={() => {
            if (done) {
              onCancel()
              return
            }
            setReview(null)
            setAck(false)
            setAckExtreme(false)
            setError(null)
          }}
        >
          <label className="flex items-start gap-2 rounded-lg border border-red-300 bg-red-50 p-3">
            <input
              type="checkbox"
              checked={ack}
              onChange={event => setAck(event.target.checked)}
              disabled={busy || done}
              className="mt-0.5 accent-red-600"
            />
            <span className="text-xs leading-relaxed text-red-700">
              I verified every value and selected chain. {power.danger}
            </span>
          </label>
          {power.extreme ? (
            <label className="mt-2 flex items-start gap-2 rounded-lg border border-red-300 bg-red-50 p-3">
              <input
                type="checkbox"
                checked={ackExtreme}
                onChange={event => setAckExtreme(event.target.checked)}
                disabled={busy || done}
                className="mt-0.5 accent-red-600"
              />
              <span className="text-xs leading-relaxed text-red-700">
                I triple-checked each controller address. A mistake can permanently
                brick the project on that chain.
              </span>
            </label>
          ) : null}
        </TxConfirmDialog>
      ) : null}
    </div>
  )
}
