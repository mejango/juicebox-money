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
import { ModalShell } from '@/components/ui/ModalShell'
import { TxConfirmDialog, type TxConfirmRow } from '@/components/ui/TxConfirmDialog'
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
  buildSetBuybackTwapAuthorityCall,
} from '@/lib/transaction-builders'
import { chainName } from '@/lib/urn'
import { ConceptTerm } from '@/components/project/ConceptTerm'
import { PROTOCOL_CONCEPTS } from '@/lib/protocol-concepts'

type BuybackChainState = AuthorityDeployment & {
  name: string
  authority: Address | null
  buybackRegistry: Address | null
  routerRegistry: Address | null
  buybackAvailable: boolean
  routerAvailable: boolean
  hook: Address | null
  terminal: Address | null
  /** Pair tokens with an initialized pool on this chain, and their TWAP window. */
  pools: { label: string; token: Address; twap: number }[]
  poolSummary: string
  readError: string | null
}

type ActionKind = 'hook' | 'terminal' | 'pool' | 'twap'

/** `JBBuybackHook._requireValidTwapWindow`: 5 minutes to 2 days. */
const MIN_TWAP_WINDOW = 300
const MAX_TWAP_WINDOW = 172_800

type Review = {
  calls: AuthorityCall[]
  rows: TxConfirmRow[]
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
  twap: {
    title: 'Set TWAP window',
    description:
      'Changes how far back the buyback hook averages the pool price to decide swap-vs-issue and to floor the swap. Written straight to the project’s hook.',
    danger:
      'A window longer than the pool’s price actually trends floors swaps above what the pool can fill, and every payment routed to a swap reverts. A very short window is cheaper to manipulate. 300–172800 seconds.',
    fieldLabel: 'Pair token',
    gas: 150_000n,
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
  let pools: BuybackChainState['pools'] = []
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
    pools = windows.filter(row => row.twap > 0)
    poolSummary = pools.length
      ? pools.map(row => `${row.label} pool | TWAP ${row.twap}s`).join(', ')
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
    pools,
    poolSummary,
    readError,
  }
}

/** A chain can run the action only where its target contract resolves. */
function isKindAvailable(kind: ActionKind, row: BuybackChainState): boolean {
  if (kind === 'terminal') return row.routerAvailable
  // The TWAP window lives on the hook itself, and only for an initialized pool.
  if (kind === 'twap') return row.buybackAvailable && !!row.hook && row.pools.length > 0
  return row.buybackAvailable
}

function stateDiffers(
  rows: BuybackChainState[],
  pick: (row: BuybackChainState) => string | null,
): boolean {
  const values = rows.map(row => pick(row)?.toLowerCase() ?? 'unset')
  return new Set(values).size > 1
}

/**
 * Native has two spellings here: pool probes record it as `zeroAddress`, while the TWAP form
 * defaults to the `NATIVE_TOKEN` sentinel. Comparing them raw meant the review line's lookup
 * never matched for the MOST COMMON pool type, printing "TWAP —s → Xs". The hook normalizes
 * the sentinel, so the transaction was always right — only the review text was blank.
 */
function sameToken(a: string, b: string): boolean {
  const norm = (value: string) => {
    const lower = value.toLowerCase()
    return lower === NATIVE_TOKEN.toLowerCase() ? zeroAddress : lower
  }
  return norm(a) === norm(b)
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
        Wire up the project’s buyback hook and swap router, initialize its
        Uniswap pool, and tune the pool’s TWAP window. Select every intended
        chain; EOA actions use one Relayr payment, while Safe actions are
        proposed to each chain’s multisig.
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
          <ActionRow
            kind="twap"
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
  const availableRows = rows.filter(row => isKindAvailable(kind, row))
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
            const available = isKindAvailable(kind, row)
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
                      {kind === 'twap'
                        ? 'No initialized buyback pool here'
                        : 'No Uniswap v4 registry here'}
                    </p>
                  ) : row.readError ? (
                    <p className="text-xs text-red-700">{row.readError}</p>
                  ) : kind === 'pool' || kind === 'twap' ? (
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
          kind !== 'twap' &&
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
        <ModalShell
          title={action.title}
          subtitle={action.description}
          onClose={() => setOpen(false)}
          maxWidth="max-w-xl"
        >
          <BuybackActionForm
            kind={kind}
            rows={rows}
            onDone={() => {
              onDone()
              setOpen(false)
            }}
          />
        </ModalShell>
      ) : null}
    </div>
  )
}

function BuybackActionForm({
  kind,
  rows,
  onDone,
}: {
  kind: ActionKind
  rows: BuybackChainState[]
  onDone: () => void
}) {
  const action = ACTIONS[kind]
  const available = useMemo(
    () => rows.filter(row => isKindAvailable(kind, row)),
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
            : // Pre-select the pool the chain already has, so a TWAP edit targets
              // an initialized pair instead of a native pool a USDC revnet never
              // had. Native pools read back as address(0); show the sentinel.
              kind === 'twap' && row.pools[0] && row.pools[0].token !== zeroAddress
              ? row.pools[0].token
              : NATIVE_TOKEN,
      ]),
    ),
  )
  const [fee, setFee] = useState('3000')
  const [tickSpacing, setTickSpacing] = useState('60')
  const [twapWindow, setTwapWindow] = useState(() =>
    kind === 'twap' ? String(available[0]?.pools[0]?.twap ?? 1800) : '1800',
  )
  const [sqrtPriceX96, setSqrtPriceX96] = useState('')
  const [ack, setAck] = useState(false)
  const [review, setReview] = useState<Review | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  useEffect(() => {
    setReview(null)
    setAck(false)
  }, [selected, addresses, fee, tickSpacing, twapWindow, sqrtPriceX96])

  const closeReview = () => {
    if (busy) return
    setReview(null)
    setError(null)
    if (done) onDone()
  }

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
        // Pool registration runs the SAME `_requireValidTwapWindow` bound the
        // standalone TWAP edit does; the uint32 range let an out-of-bounds
        // value through review and the danger acknowledgement, only to die in
        // the pre-flight eth_call with a raw JBBuybackHook_InvalidTwapWindow.
        if (
          parsed.twapWindow < MIN_TWAP_WINDOW ||
          parsed.twapWindow > MAX_TWAP_WINDOW
        ) {
          throw new Error(
            `The hook only accepts a TWAP window between ${MIN_TWAP_WINDOW} and ${MAX_TWAP_WINDOW} seconds.`,
          )
        }
        if (parsed.sqrtPriceX96 <= 0n || parsed.sqrtPriceX96 >= 2n ** 160n) {
          throw new Error('Initial price must be a positive uint160 value.')
        }
        poolValues = parsed
      }
      let newTwapWindow = 0
      if (kind === 'twap') {
        if (!/^\d+$/.test(twapWindow)) {
          throw new Error('Enter the TWAP window in whole seconds.')
        }
        newTwapWindow = Number(twapWindow)
        if (newTwapWindow < MIN_TWAP_WINDOW || newTwapWindow > MAX_TWAP_WINDOW) {
          throw new Error(
            `The hook only accepts a TWAP window between ${MIN_TWAP_WINDOW} and ${MAX_TWAP_WINDOW} seconds.`,
          )
        }
      }

      const calls: AuthorityCall[] = []
      const reviewRows: TxConfirmRow[] = []
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
        } else if (kind === 'twap') {
          // The registry has no setTwapWindowOf forwarder — the write goes to
          // the project's resolved hook.
          if (!row.hook) throw new Error(`${row.name}: no buyback hook set.`)
          calls.push(
            buildSetBuybackTwapAuthorityCall({
              chainId: row.chainId,
              authority: row.authority,
              hook: row.hook,
              projectId: BigInt(row.projectId),
              terminalToken: address,
              twapWindow: BigInt(newTwapWindow),
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
        reviewRows.push({
          label: row.name,
          mono: true,
          value: `${truncateAddress(address)}${
            kind === 'pool'
              ? ` | fee ${fee} | spacing ${tickSpacing} | TWAP ${twapWindow}s | price ${sqrtPriceX96}`
              : kind === 'twap'
                ? ` | TWAP ${
                    row.pools.find(
                      pool => sameToken(pool.token, address),
                    )?.twap ?? '—'
                  }s → ${twapWindow}s`
                : ''
          }`,
        })
      }
      reviewRows.push({ label: 'On', value: chosen.map(row => row.name).join(', ') })
      setStatus(null)
      setDone(false)
      setReview({ calls, rows: reviewRows })
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
      setDone(true)
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
    <div>
      <ChainPicker
        label="Run on"
        rows={rows.map(row => ({
          chainId: row.chainId,
          name: row.name,
          disabled: !isKindAvailable(kind, row),
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
        {kind === 'pool' || kind === 'twap' ? (
          <p className="mt-2 text-xs leading-relaxed text-smoke-500">
            Use the native-token sentinel for native ETH pools. USDC and other
            pair-token addresses may differ by chain.
          </p>
        ) : null}
      </PerChainAddressField>

      {kind === 'twap' ? (
        <div className="mt-4 sm:max-w-xs">
          <NumberField
            label="TWAP window (seconds)"
            note={PROTOCOL_CONCEPTS.twapWindow}
            value={twapWindow}
            onChange={setTwapWindow}
            disabled={busy}
            placeholder="1800 = 30 min"
          />
        </div>
      ) : null}

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
            note={PROTOCOL_CONCEPTS.twapWindow}
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

      <label className="mt-4 flex items-start gap-2 rounded-lg border border-red-300 bg-red-50 p-3">
        <input
          type="checkbox"
          checked={ack}
          onChange={event => setAck(event.target.checked)}
          disabled={busy}
          className="mt-0.5 accent-red-600"
        />
        <span className="text-xs leading-relaxed text-red-700">
          I verified every selected chain and value. {action.danger}
        </span>
      </label>

      <button
        type="button"
        onClick={buildReview}
        disabled={busy || !selected.size || !ack}
        className="btn-primary mt-3 min-h-[44px] w-full text-sm"
      >
        {action.title}
      </button>
      {error && !review ? <ErrorNote message={error} /> : null}
      {review ? (
        <TxConfirmDialog
          open
          title={done ? `${action.title} complete` : `Confirm ${action.title.toLowerCase()}`}
          rows={review.rows}
          steps={review.calls.map(call => ({
            key: String(call.chainId),
            title: `${action.title} on ${chainName(call.chainId)}`,
          }))}
          activeIndex={busy ? 0 : -1}
          status={status}
          error={error}
          busy={busy}
          complete={done}
          action={error ? 'Retry' : action.title}
          onConfirm={() => void submit()}
          onClose={closeReview}
        />
      ) : null}
    </div>
  )
}

function NumberField({
  label,
  value,
  onChange,
  disabled,
  placeholder,
  note,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  disabled: boolean
  placeholder: string
  /** What the field MEANS, for a term the operator may not know. */
  note?: string
}) {
  return (
    <label className="block">
      <span className="field-label">
        {note ? <ConceptTerm note={note}>{label}</ConceptTerm> : label}
      </span>
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
