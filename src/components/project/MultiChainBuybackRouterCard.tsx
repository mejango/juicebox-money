'use client'

import {
  JBBuybackHookContracts,
  JBRouterTerminalContracts,
  NATIVE_TOKEN,
  USDC_ADDRESSES,
  jbBuybackHookAbi,
  jbBuybackHookRegistryAbi,
  jbContractAddress,
  jbRouterTerminalRegistryAbi,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { zeroAddress, type Address } from 'viem'
import { ChainIcon } from '@/components/ChainIcon'
import { ActionRowsSkeleton } from '@/components/LoadingSkeletons'
import type { AuthorityDeployment } from '@/components/project/AuthorityOverview'
import { AddressLink } from '@/components/ui/AddressLink'
import { ChainPicker } from '@/components/ui/ChainPicker'
import { PerChainAddressField } from '@/components/ui/PerChainAddressField'
import { ErrorNote } from '@/components/ui/TxError'
import {
  clientFor,
  readAuthorityOf,
  runAuthorityCalls,
  safeOutcomeMessage,
  type AuthorityCall,
} from '@/lib/authority'
import { resolvedAddress } from '@/lib/ens'
import { truncateAddress } from '@/lib/format'
import {
  buildBuybackHookAuthorityCall,
  buildInitializeBuybackPoolAuthorityCall,
  buildRouterTerminalAuthorityCall,
} from '@/lib/transaction-builders'
import { chainName } from '@/lib/urn'

type BuybackChainState = AuthorityDeployment & {
  name: string
  authority: Address | null
  buybackRegistry: Address | null
  routerRegistry: Address | null
  buybackAvailable: boolean
  routerAvailable: boolean
  hook: Address | null
  terminal: Address | null
  poolSummary: string
  readError: string | null
}

type ActionKind = 'hook' | 'terminal' | 'pool'

type Review = {
  calls: AuthorityCall[]
  lines: string[]
}

const ACTIONS: Record<
  ActionKind,
  {
    title: string
    description: string
    danger: string
    /** The per-chain address input's noun ("<fieldLabel> per chain"). */
    fieldLabel: string
    gas: bigint
  }
> = {
  hook: {
    title: 'Set buyback hook',
    description:
      'Points the project at the hook that chooses, on every payment, whether to issue tokens or buy them on the AMM.',
    danger:
      'The buyback hook intercepts every payment. A wrong hook can misroute or strand funds.',
    fieldLabel: 'Buyback hook',
    gas: 200_000n,
  },
  terminal: {
    title: 'Set router terminal',
    description:
      'Sets the terminal the swap router forwards into after swapping USDC or another payment token.',
    danger:
      'This changes where router-swapped funds are deposited. A wrong terminal can misdirect or strand funds.',
    fieldLabel: 'Router terminal',
    gas: 200_000n,
  },
  pool: {
    title: 'Initialize buyback pool',
    description:
      'Creates and price-initializes the Uniswap v4 pool for a pair token through the project’s configured hook.',
    danger:
      'A wrong initial price lets arbitrageurs extract value. Verify the price, fee, tick spacing, pair token, and every selected chain.',
    fieldLabel: 'Pair token',
    gas: 500_000n,
  },
}

function contractAddress(
  contract: JBBuybackHookContracts | JBRouterTerminalContracts,
  chainId: JBChainId,
): Address | null {
  const deployments = jbContractAddress['6'][contract] as unknown as
    | Partial<Record<JBChainId, Address>>
    | undefined
  return deployments?.[chainId] ?? null
}

async function readChainState(
  deployment: AuthorityDeployment,
  isRevnet: boolean,
): Promise<BuybackChainState> {
  const client = clientFor(deployment.chainId)
  const buybackRegistry = contractAddress(
    JBBuybackHookContracts.JBBuybackHookRegistry,
    deployment.chainId,
  )
  const routerRegistry = contractAddress(
    JBRouterTerminalContracts.JBRouterTerminalRegistry,
    deployment.chainId,
  )

  const authority = await readAuthorityOf(client, deployment, {
    indexedOnly: isRevnet,
  })

  const [defaultHook, hook, defaultTerminal, terminal] = await Promise.all([
    buybackRegistry
      ? client
          .readContract({
            address: buybackRegistry,
            abi: jbBuybackHookRegistryAbi,
            functionName: 'defaultHook',
          })
          .catch(() => null)
      : null,
    buybackRegistry
      ? client
          .readContract({
            address: buybackRegistry,
            abi: jbBuybackHookRegistryAbi,
            functionName: 'hookOf',
            args: [BigInt(deployment.projectId)],
          })
          .catch(() => null)
      : null,
    routerRegistry
      ? client
          .readContract({
            address: routerRegistry,
            abi: jbRouterTerminalRegistryAbi,
            functionName: 'defaultTerminal',
          })
          .catch(() => null)
      : null,
    routerRegistry
      ? client
          .readContract({
            address: routerRegistry,
            abi: jbRouterTerminalRegistryAbi,
            functionName: 'terminalOf',
            args: [BigInt(deployment.projectId)],
          })
          .catch(() => null)
      : null,
  ])

  const resolvedHook =
    hook && (hook as Address) !== zeroAddress ? (hook as Address) : null
  const resolvedTerminal =
    terminal && (terminal as Address) !== zeroAddress
      ? (terminal as Address)
      : null
  const buybackAvailable =
    !!buybackRegistry && !!defaultHook && (defaultHook as Address) !== zeroAddress
  const routerAvailable =
    !!routerRegistry &&
    !!defaultTerminal &&
    (defaultTerminal as Address) !== zeroAddress

  let poolSummary = resolvedHook ? 'Not initialized' : 'Set the hook first'
  if (resolvedHook) {
    const probes: { label: string; token: Address }[] = [
      { label: 'Native', token: zeroAddress },
    ]
    const usdc = USDC_ADDRESSES[deployment.chainId]
    if (usdc) probes.push({ label: 'USDC', token: usdc })
    const windows = await Promise.all(
      probes.map(async probe => ({
        ...probe,
        twap: Number(
          await client
            .readContract({
              address: resolvedHook,
              abi: jbBuybackHookAbi,
              functionName: 'twapWindowOf',
              args: [BigInt(deployment.projectId), probe.token],
            })
            .catch(() => 0n),
        ),
      })),
    )
    const initialized = windows.filter(row => row.twap > 0)
    poolSummary = initialized.length
      ? initialized
          .map(row => `${row.label} pool · TWAP ${row.twap}s`)
          .join(', ')
      : 'Not initialized'
  }

  const shouldHaveBuyback = !!buybackRegistry
  const shouldHaveRouter = !!routerRegistry
  const readError =
    (shouldHaveBuyback && defaultHook === null) ||
    (shouldHaveRouter && defaultTerminal === null)
      ? 'Could not verify registry availability.'
      : null

  return {
    ...deployment,
    name: chainName(deployment.chainId),
    authority,
    buybackRegistry,
    routerRegistry,
    buybackAvailable,
    routerAvailable,
    hook: resolvedHook,
    terminal: resolvedTerminal,
    poolSummary,
    readError,
  }
}

function stateDiffers(
  rows: BuybackChainState[],
  pick: (row: BuybackChainState) => string | null,
): boolean {
  const values = rows.map(row => pick(row)?.toLowerCase() ?? 'unset')
  return new Set(values).size > 1
}

export function MultiChainBuybackRouterCard({
  deployments,
  isRevnet,
}: {
  deployments: AuthorityDeployment[]
  isRevnet: boolean
}) {
  const query = useQuery({
    queryKey: [
      'multiChainBuybackRouter',
      isRevnet,
      deployments
        .map(row => `${row.chainId}:${row.projectId}:${row.indexedAuthority ?? ''}`)
        .join(','),
    ],
    staleTime: 30_000,
    retry: 1,
    queryFn: () =>
      Promise.all(deployments.map(row => readChainState(row, isRevnet))),
  })
  const rows = query.data ?? []
  const hookDiffers = stateDiffers(rows, row => row.hook)
  const terminalDiffers = stateDiffers(rows, row => row.terminal)
  const poolDiffers = stateDiffers(rows, row => row.poolSummary)

  return (
    <section className="card p-5">
      <span className="field-label">Buyback &amp; swap router</span>
      <p className="mt-2 text-sm leading-relaxed text-smoke-700">
        Wire up the project’s buyback hook and swap router, then initialize its
        Uniswap pool. Select every intended chain; EOA actions use one Relayr
        payment, while Safe actions are proposed to each chain’s multisig.
      </p>

      {query.isLoading ? (
        <ActionRowsSkeleton rows={3} label="Loading buyback router" />
      ) : query.isError ? (
        <p className="mt-4 text-sm text-red-700">
          Could not read the buyback registries.
        </p>
      ) : (
        <div className="mt-4 divide-y divide-smoke-100">
          <ActionRow
            kind="hook"
            rows={rows}
            differs={hookDiffers}
            current={row => row.hook}
            onDone={() => query.refetch()}
          />
          <ActionRow
            kind="terminal"
            rows={rows}
            differs={terminalDiffers}
            current={row => row.terminal}
            onDone={() => query.refetch()}
          />
          <ActionRow
            kind="pool"
            rows={rows}
            differs={poolDiffers}
            current={row => row.poolSummary}
            onDone={() => query.refetch()}
          />
        </div>
      )}
    </section>
  )
}

function ActionRow({
  kind,
  rows,
  differs,
  current,
  onDone,
}: {
  kind: ActionKind
  rows: BuybackChainState[]
  differs: boolean
  current: (row: BuybackChainState) => Address | string | null
  onDone: () => void
}) {
  const action = ACTIONS[kind]
  const [open, setOpen] = useState(false)
  const availableRows = rows.filter(row =>
    kind === 'terminal' ? row.routerAvailable : row.buybackAvailable,
  )
  const availabilityMixed = availableRows.length !== rows.length
  const showPerChain =
    differs || availabilityMixed || rows.some(row => !!row.readError)
  const uniformValue = availableRows[0] ? current(availableRows[0]) : null

  return (
    <div className="py-4 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium text-ink">{action.title}</p>
            {differs ? (
              <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                Differs by chain
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-xs leading-relaxed text-smoke-700">
            {action.description}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen(value => !value)}
          disabled={!availableRows.length}
          className="btn-secondary min-h-[36px] shrink-0 px-3 text-xs"
        >
          {open ? 'Close' : action.title}
        </button>
      </div>

      {showPerChain ? (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {rows.map(row => {
            const available =
              kind === 'terminal' ? row.routerAvailable : row.buybackAvailable
            const value = current(row)
            return (
              <div
                key={row.chainId}
                className="flex min-w-0 items-start gap-2 rounded-lg bg-smoke-50 px-3 py-2"
              >
                <ChainIcon chainId={row.chainId} size={18} className="mt-0.5" />
                <div className="min-w-0">
                  <p className="text-xs font-medium text-smoke-700">{row.name}</p>
                  {!available ? (
                    <p className="text-xs text-smoke-500">
                      No Uniswap v4 registry here
                    </p>
                  ) : row.readError ? (
                    <p className="text-xs text-red-700">{row.readError}</p>
                  ) : kind === 'pool' ? (
                    <p className="text-xs text-smoke-700">{value ?? 'Unknown'}</p>
                  ) : value &&
                    typeof value === 'string' &&
                    value.startsWith('0x') ? (
                    <AddressLink
                      address={value as Address}
                      chainId={row.chainId}
                      className="font-mono text-xs text-ink"
                      title={value as Address}
                    />
                  ) : (
                    <p className="text-xs text-smoke-500">Not set</p>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      ) : (
        <p className="mt-3 text-xs text-smoke-700">
          <span className="text-smoke-500">Current:</span>{' '}
          {kind !== 'pool' &&
          uniformValue &&
          typeof uniformValue === 'string' &&
          uniformValue.startsWith('0x') ? (
            <AddressLink
              address={uniformValue as Address}
              chainId={availableRows[0].chainId}
              className="font-mono text-xs text-ink"
              title={uniformValue as Address}
            />
          ) : (
            <span className={uniformValue ? 'text-ink' : 'text-smoke-500'}>
              {uniformValue ?? 'Not set'}
            </span>
          )}{' '}
          <span className="text-smoke-500">
            (same on all {availableRows.length} chain
            {availableRows.length === 1 ? '' : 's'})
          </span>
        </p>
      )}

      {open ? (
        <BuybackActionForm
          kind={kind}
          rows={rows}
          onCancel={() => setOpen(false)}
          onDone={() => {
            onDone()
            setOpen(false)
          }}
        />
      ) : null}
    </div>
  )
}

function BuybackActionForm({
  kind,
  rows,
  onCancel,
  onDone,
}: {
  kind: ActionKind
  rows: BuybackChainState[]
  onCancel: () => void
  onDone: () => void
}) {
  const action = ACTIONS[kind]
  const available = useMemo(
    () =>
      rows.filter(row =>
        kind === 'terminal' ? row.routerAvailable : row.buybackAvailable,
      ),
    [kind, rows],
  )
  const [selected, setSelected] = useState<Set<number>>(
    () => new Set(available.map(row => row.chainId)),
  )
  const [addresses, setAddresses] = useState<Record<number, string>>(() =>
    Object.fromEntries(
      available.map(row => [
        row.chainId,
        kind === 'hook'
          ? row.hook ?? ''
          : kind === 'terminal'
            ? row.terminal ?? ''
            : NATIVE_TOKEN,
      ]),
    ),
  )
  const [fee, setFee] = useState('3000')
  const [tickSpacing, setTickSpacing] = useState('60')
  const [twapWindow, setTwapWindow] = useState('1800')
  const [sqrtPriceX96, setSqrtPriceX96] = useState('')
  const [ack, setAck] = useState(false)
  const [review, setReview] = useState<Review | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setReview(null)
    setAck(false)
  }, [selected, addresses, fee, tickSpacing, twapWindow, sqrtPriceX96])

  const buildReview = () => {
    setError(null)
    const chosen = available.filter(row => selected.has(row.chainId))
    if (!chosen.length) {
      setError('Choose at least one available chain.')
      return
    }
    try {
      let poolValues: {
        fee: number
        tickSpacing: number
        twapWindow: number
        sqrtPriceX96: bigint
      } | null = null
      if (kind === 'pool') {
        if (![fee, tickSpacing, twapWindow, sqrtPriceX96].every(v => /^\d+$/.test(v))) {
          throw new Error('Fee, tick spacing, TWAP window, and price must be whole numbers.')
        }
        const parsed = {
          fee: Number(fee),
          tickSpacing: Number(tickSpacing),
          twapWindow: Number(twapWindow),
          sqrtPriceX96: BigInt(sqrtPriceX96),
        }
        if (parsed.fee < 0 || parsed.fee > 0xffffff) {
          throw new Error('Fee must fit uint24.')
        }
        if (parsed.tickSpacing < 1 || parsed.tickSpacing > 0x7fffff) {
          throw new Error('Tick spacing must be a positive int24 value.')
        }
        if (parsed.twapWindow < 1 || parsed.twapWindow > 0xffffffff) {
          throw new Error('TWAP window must be between 1 and 4,294,967,295 seconds.')
        }
        if (parsed.sqrtPriceX96 <= 0n || parsed.sqrtPriceX96 >= 2n ** 160n) {
          throw new Error('Initial price must be a positive uint160 value.')
        }
        poolValues = parsed
      }

      const calls: AuthorityCall[] = []
      const lines: string[] = []
      for (const row of chosen) {
        if (!row.authority) throw new Error(`${row.name}: owner/operator is unknown.`)
        const input = addresses[row.chainId] ?? ''
        const address = resolvedAddress(input)
        if (!address) {
          throw new Error(
            `${row.name}: enter a valid ${action.fieldLabel.toLowerCase()} address.`,
          )
        }

        if (kind === 'hook') {
          if (!row.buybackRegistry) throw new Error(`${row.name}: no buyback registry.`)
          calls.push(
            buildBuybackHookAuthorityCall({
              chainId: row.chainId,
              authority: row.authority,
              registry: row.buybackRegistry,
              projectId: BigInt(row.projectId),
              hook: address,
              gas: action.gas,
              label: action.title,
            }),
          )
        } else if (kind === 'terminal') {
          if (!row.routerRegistry) throw new Error(`${row.name}: no router registry.`)
          calls.push(
            buildRouterTerminalAuthorityCall({
              chainId: row.chainId,
              authority: row.authority,
              registry: row.routerRegistry,
              projectId: BigInt(row.projectId),
              terminal: address,
              gas: action.gas,
              label: action.title,
            }),
          )
        } else {
          if (!row.buybackRegistry || !poolValues) {
            throw new Error(`${row.name}: no buyback registry.`)
          }
          calls.push(
            buildInitializeBuybackPoolAuthorityCall({
              chainId: row.chainId,
              authority: row.authority,
              registry: row.buybackRegistry,
              projectId: BigInt(row.projectId),
              fee: poolValues.fee,
              tickSpacing: poolValues.tickSpacing,
              twapWindow: BigInt(poolValues.twapWindow),
              pairToken: address,
              sqrtPriceX96: poolValues.sqrtPriceX96,
              gas: action.gas,
              label: action.title,
            }),
          )
        }
        lines.push(
          `${row.name}: ${truncateAddress(address)}${
            kind === 'pool'
              ? ` · fee ${fee} · spacing ${tickSpacing} · TWAP ${twapWindow}s · price ${sqrtPriceX96}`
              : ''
          }`,
        )
      }
      setReview({ calls, lines })
    } catch (reviewError) {
      setError(
        reviewError instanceof Error
          ? reviewError.message
          : 'Could not review this action.',
      )
    }
  }

  const submit = async () => {
    if (!review || !ack || busy) return
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
          `${action.title} completed on ${review.calls.length} chain${
            review.calls.length === 1 ? '' : 's'
          }.`,
        ),
      )
      onDone()
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : 'Could not complete this action.',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-4 rounded-xl border border-smoke-200 p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-ink">{action.title}</p>
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
          name: row.name,
          disabled:
            kind === 'terminal' ? !row.routerAvailable : !row.buybackAvailable,
        }))}
        selected={selected}
        onChange={setSelected}
        disabled={busy}
      />

      <PerChainAddressField
        className="mt-4"
        fieldLabel={action.fieldLabel}
        rows={available}
        selected={selected}
        values={addresses}
        onChange={setAddresses}
        disabled={busy}
      >
        {kind === 'pool' ? (
          <p className="mt-2 text-xs leading-relaxed text-smoke-500">
            Use the native-token sentinel for native ETH pools. USDC and other
            pair-token addresses may differ by chain.
          </p>
        ) : null}
      </PerChainAddressField>

      {kind === 'pool' ? (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <NumberField
            label="Fee (hundredths of a bip)"
            value={fee}
            onChange={setFee}
            disabled={busy}
            placeholder="3000 = 0.3%"
          />
          <NumberField
            label="Tick spacing"
            value={tickSpacing}
            onChange={setTickSpacing}
            disabled={busy}
            placeholder="60 for a 0.3% pool"
          />
          <NumberField
            label="TWAP window (seconds)"
            value={twapWindow}
            onChange={setTwapWindow}
            disabled={busy}
            placeholder="1800"
          />
          <NumberField
            label="Initial price (sqrtPriceX96)"
            value={sqrtPriceX96}
            onChange={setSqrtPriceX96}
            disabled={busy}
            placeholder="positive uint160"
          />
        </div>
      ) : null}

      {review ? (
        <div className="callout callout-info mt-4 text-xs">
          <p className="font-medium">Review the exact per-chain change</p>
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
          I verified every selected chain and value. {action.danger}
        </span>
      </label>

      <button
        type="button"
        onClick={review ? submit : buildReview}
        disabled={busy || !selected.size || (!!review && !ack)}
        className="btn-primary mt-3 min-h-[44px] w-full text-sm"
      >
        {busy ? status ?? 'Preparing…' : review ? action.title : 'Review changes'}
      </button>
      {status ? <p className="mt-2 text-xs text-smoke-700">{status}</p> : null}
      {error ? <ErrorNote message={error} /> : null}
    </div>
  )
}

function NumberField({
  label,
  value,
  onChange,
  disabled,
  placeholder,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  disabled: boolean
  placeholder: string
}) {
  return (
    <label className="block">
      <span className="field-label">{label}</span>
      <input
        type="text"
        inputMode="numeric"
        value={value}
        onChange={event => onChange(event.target.value.replace(/[^0-9]/g, ''))}
        disabled={disabled}
        placeholder={placeholder}
        className="input-well mt-1.5 min-h-[42px] w-full px-3 text-sm tabular-nums disabled:opacity-60"
      />
    </label>
  )
}
