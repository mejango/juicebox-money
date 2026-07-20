'use client'

import { getPublicClient } from '@wagmi/core'
import {
  JB_CHAINS,
  JBCoreContracts,
  jbContractAddress,
  jbControllerAbi,
  jbDirectoryAbi,
  jbMultiTerminalAbi,
  jbProjectsAbi,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import { getCurrentRuleset } from '@bananapus/nana-sdk-core/v6'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import {
  encodeFunctionData,
  parseUnits,
  type Abi,
  type Address,
  type PublicClient,
} from 'viem'
import { ChainIcon } from '@/components/ChainIcon'
import { AddressField } from '@/components/create/AddressField'
import type { AuthorityDeployment } from '@/components/project/AuthorityOverview'
import {
  POWERS,
  type FlowField,
  type PowerDescriptor,
  type PowerFlag,
  type ResolvedValues,
} from '@/lib/projectPowers'
import { useWallet } from '@/hooks/useWallet'
import { runAuthorityCalls, type AuthorityCall } from '@/lib/authority'
import { resolvedAddress } from '@/lib/ens'
import { truncateAddress } from '@/lib/format'
import { wagmiConfig } from '@/providers/Providers'

type PowerChainState = AuthorityDeployment & {
  name: string
  authority: Address | null
  controller: Address | null
  metadata: Partial<Record<PowerFlag, boolean>> | null
  error: string | null
}

function clientFor(chainId: JBChainId): PublicClient {
  const client = getPublicClient(wagmiConfig, { chainId })
  if (!client) throw new Error(`No RPC client is configured for chain ${chainId}.`)
  return client as PublicClient
}

async function readPowerState(
  deployment: AuthorityDeployment,
): Promise<PowerChainState> {
  const client = clientFor(deployment.chainId)
  const [authority, controller, ruleset] = await Promise.all([
    client
      .readContract({
        address: jbContractAddress['6'][JBCoreContracts.JBProjects][
          deployment.chainId
        ],
        abi: jbProjectsAbi,
        functionName: 'ownerOf',
        args: [BigInt(deployment.projectId)],
      })
      .catch(() => deployment.indexedAuthority),
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
    getCurrentRuleset(client, {
      chainId: deployment.chainId,
      projectId: BigInt(deployment.projectId),
    }).catch(() => null),
  ])
  return {
    ...deployment,
    name: JB_CHAINS[deployment.chainId]?.name ?? `Chain ${deployment.chainId}`,
    authority: (authority as Address | null) ?? null,
    controller: (controller as Address | null) ?? null,
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

function outcomeMessage(
  result: Awaited<ReturnType<typeof runAuthorityCalls>>,
  power: PowerDescriptor,
  chains: number,
): string {
  const queued = result.safeResults.filter(row => row.status === 'queued').length
  const waiting = result.safeResults.filter(row => row.status === 'waiting').length
  if (queued || waiting) {
    return `Safe action recorded${queued ? ` · ${queued} queued` : ''}${
      waiting ? ` · ${waiting} awaiting more approvals` : ''
    }. Complete it in Pending multisig transactions.`
  }
  return `${power.label} completed on ${chains} chain${chains === 1 ? '' : 's'}.`
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
        <p className="mt-4 text-sm text-smoke-500">Reading every chain…</p>
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
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
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
            className="min-h-[36px] shrink-0 rounded-xl border border-red-300 px-3 text-xs font-medium text-red-700 transition-colors hover:bg-red-50"
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
          onDone={() => {
            onDone()
            onToggle()
          }}
        />
      ) : null}
    </li>
  )
}

function initialAddress(
  field: FlowField,
  row: PowerChainState,
  connected: Address | undefined,
): string {
  if (field.initial === 'ADDR_CONNECTED') return connected ?? ''
  if (field.initial === 'ADDR_CONTROLLER') return row.controller ?? ''
  if (field.initial === 'ADDR_TERMINAL') {
    return (
      (jbContractAddress['6'][JBCoreContracts.JBMultiTerminal][
        row.chainId
      ] as Address | undefined) ?? ''
    )
  }
  return field.initial ?? ''
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
        .filter(field => field.kind !== 'address' && field.kind !== 'bool')
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
        .filter(field => field.kind === 'address')
        .map(field => [
          field.name,
          Object.fromEntries(
            enabledRows.map(row => [row.chainId, initialAddress(field, row, address)]),
          ),
        ]),
    ),
  )
  const [review, setReview] = useState<{
    calls: AuthorityCall[]
    lines: string[]
  } | null>(null)
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
      if (field.kind === 'address') continue
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
    const chosen = enabledRows.filter(row => selected.has(row.chainId))
    if (!chosen.length) {
      setError('Choose at least one enabled chain.')
      return
    }
    try {
      const shared = resolveSharedValues()
      const calls: AuthorityCall[] = []
      const lines: string[] = []
      for (const row of chosen) {
        if (!row.authority || !row.controller) {
          throw new Error(`${row.name}: owner or controller is unknown.`)
        }
        const values: ResolvedValues = { ...shared }
        const display: string[] = []
        for (const field of power.fields) {
          if (field.kind !== 'address') continue
          const value = resolvedAddress(addresses[field.name]?.[row.chainId] ?? '')
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
        calls.push({
          chainId: row.chainId,
          authority: row.authority,
          target,
          data: encodeFunctionData({
            abi: abi as Abi,
            functionName: power.functionName,
            args,
          }),
          gas: power.flag === 'allowAddAccountingContext' ? 300_000n : 500_000n,
          label: power.actionLabel,
        })
        lines.push(
          `${row.name}${display.length ? ` · ${display.join(' · ')}` : ''}`,
        )
      }
      setReview({ calls, lines })
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
      setStatus(outcomeMessage(result, power, review.calls.length))
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

      <div className="mt-4">
        <span className="field-label">Run on</span>
        <div className="mt-2 flex flex-wrap gap-2">
          {rows.map(row => {
            const enabled = flagState(row, power.flag) && !row.error
            return (
              <label
                key={row.chainId}
                className={`flex items-center gap-2 rounded-lg border border-smoke-200 px-3 py-2 text-sm ${
                  enabled ? 'cursor-pointer' : 'opacity-50'
                }`}
              >
                <input
                  type="checkbox"
                  checked={selected.has(row.chainId)}
                  onChange={() =>
                    setSelected(current => {
                      const next = new Set(current)
                      if (next.has(row.chainId)) next.delete(row.chainId)
                      else next.add(row.chainId)
                      return next
                    })
                  }
                  disabled={busy || !enabled}
                  className="accent-bluebs-600"
                />
                <ChainIcon chainId={row.chainId} size={18} />
                {row.name}
                {!flagState(row, power.flag) ? (
                  <span className="text-xs text-smoke-500">disabled</span>
                ) : null}
              </label>
            )
          })}
        </div>
      </div>

      <div className="mt-4 space-y-4">
        {power.fields.map(field =>
          field.kind === 'address' ? (
            <PerChainAddressField
              key={field.name}
              field={field}
              rows={enabledRows}
              selected={selected}
              values={addresses[field.name] ?? {}}
              onChange={values =>
                setAddresses(current => ({ ...current, [field.name]: values }))
              }
              disabled={busy}
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

      {review ? (
        <div className="callout callout-info mt-4 text-xs">
          <p className="font-medium">Review the exact per-chain action</p>
          <ul className="mt-2 space-y-1 font-mono">
            {review.lines.map(line => (
              <li key={line} className="break-all">
                {line}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <label className="mt-4 flex items-start gap-2 rounded-lg border border-red-300 bg-red-50 p-3">
        <input
          type="checkbox"
          checked={ack}
          onChange={event => setAck(event.target.checked)}
          disabled={busy || !review}
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
            disabled={busy || !review}
            className="mt-0.5 accent-red-600"
          />
          <span className="text-xs leading-relaxed text-red-700">
            I triple-checked each controller address. A mistake can permanently
            brick the project on that chain.
          </span>
        </label>
      ) : null}

      <button
        type="button"
        onClick={review ? submit : buildReview}
        disabled={
          busy ||
          !selected.size ||
          (!!review && (!ack || (power.extreme && !ackExtreme)))
        }
        className="btn-primary mt-3 min-h-[44px] w-full text-sm"
      >
        {busy
          ? status ?? 'Preparing…'
          : review
            ? power.actionLabel
            : `Review ${power.actionLabel.toLowerCase()}`}
      </button>
      {status ? <p className="mt-2 text-xs text-smoke-700">{status}</p> : null}
      {error ? (
        <p className="mt-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  )
}

function PerChainAddressField({
  field,
  rows,
  selected,
  values,
  onChange,
  disabled,
}: {
  field: FlowField
  rows: PowerChainState[]
  selected: Set<number>
  values: Record<number, string>
  onChange: (values: Record<number, string>) => void
  disabled: boolean
}) {
  const copyFirst = () => {
    const first = rows.find(row => selected.has(row.chainId))
    if (!first) return
    const value = values[first.chainId] ?? ''
    onChange(Object.fromEntries(rows.map(row => [row.chainId, value])))
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <span className="field-label">{field.label} per chain</span>
        {rows.length > 1 ? (
          <button
            type="button"
            onClick={copyFirst}
            disabled={disabled}
            className="text-xs text-bluebs-600 hover:underline"
          >
            Use first selected value on all
          </button>
        ) : null}
      </div>
      <div className="mt-2 space-y-2">
        {rows.map(row => (
          <div
            key={row.chainId}
            className={`grid items-start gap-2 sm:grid-cols-[9rem_1fr] ${
              selected.has(row.chainId) ? '' : 'opacity-50'
            }`}
          >
            <span className="flex min-h-[40px] items-center gap-2 text-sm text-smoke-700">
              <ChainIcon chainId={row.chainId} size={18} />
              {row.name}
            </span>
            <AddressField
              value={values[row.chainId] ?? ''}
              onChange={value => onChange({ ...values, [row.chainId]: value })}
              disabled={disabled || !selected.has(row.chainId)}
              compact
              placeholder={field.placeholder}
              ariaLabel={`${field.label} on ${row.name}`}
            />
          </div>
        ))}
      </div>
      {field.help ? (
        <p className="mt-1 text-xs text-smoke-500">{field.help}</p>
      ) : null}
    </div>
  )
}
