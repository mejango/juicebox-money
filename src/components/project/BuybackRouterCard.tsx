'use client'

import {
  JB_CHAINS,
  JBBuybackHookContracts,
  JBRouterTerminalContracts,
  NATIVE_TOKEN,
  jbBuybackHookRegistryAbi,
  jbContractAddress,
  jbRouterTerminalRegistryAbi,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import { useEffect, useState } from 'react'
import {
  zeroAddress,
  type Abi,
  type Address,
  type PublicClient,
} from 'viem'
import { usePublicClient, useReadContract } from 'wagmi'
import { AddressField } from '@/components/create/AddressField'
import {
  TransactionInProgress,
  usePreloadTransactionAnimation,
} from '@/components/TransactionInProgress'
import { useSafeTx } from '@/hooks/useSafeTx'
import { useWallet } from '@/hooks/useWallet'
import { resolvedAddress } from '@/lib/ens'
import { truncateAddress } from '@/lib/format'

/**
 * Buyback & swap router card (website/ parity: renderBuybackRouterCard). Shows
 * the project's current buyback hook and swap-router terminal (registry reads,
 * with "Not set" states) and, for the connected authority (owner or operator),
 * three per-project registry writes: set the buyback hook, set the router
 * terminal, and initialize the Uniswap buyback pool.
 *
 * These only work on chains with a full Uniswap v4 AMM: the registries there
 * have a default/allowlisted hook and terminal. On chains without one (no
 * registry deployment, or no default configured) the actions would revert at
 * execute, so we fail closed and show "Not available on this chain".
 *
 * Every write goes through useSafeTx (simulate-first) after a review step that
 * freezes the exact args and re-checks the connected account at confirm.
 */
export function BuybackRouterCard({
  chainId,
  projectId,
  isRevnet,
  authority,
}: {
  chainId: JBChainId
  projectId: number
  isRevnet: boolean
  /** Owner (custom) or operator (revnet) per the back office; can be null. */
  authority: string | null
}) {
  usePreloadTransactionAnimation()
  const { isConnected, address } = useWallet()

  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  const buybackRegistry = jbContractAddress['6'][
    JBBuybackHookContracts.JBBuybackHookRegistry
  ]?.[chainId] as Address | undefined
  const routerRegistry = jbContractAddress['6'][
    JBRouterTerminalContracts.JBRouterTerminalRegistry
  ]?.[chainId] as Address | undefined

  // AMM availability: the registry must be deployed here AND have a
  // default/allowlisted hook / terminal — otherwise setHookFor / setTerminalFor
  // / initializePoolFor revert. Fail closed while the read is pending or errors.
  const { data: defaultHook, isError: defaultHookError } = useReadContract({
    abi: jbBuybackHookRegistryAbi,
    address: buybackRegistry,
    functionName: 'defaultHook',
    chainId,
    query: { enabled: !!buybackRegistry, staleTime: 5 * 60_000 },
  })
  const { data: defaultTerminal, isError: defaultTerminalError } = useReadContract({
    abi: jbRouterTerminalRegistryAbi,
    address: routerRegistry,
    functionName: 'defaultTerminal',
    chainId,
    query: { enabled: !!routerRegistry, staleTime: 5 * 60_000 },
  })

  const buybackAvailable =
    !!buybackRegistry &&
    !defaultHookError &&
    !!defaultHook &&
    (defaultHook as Address) !== zeroAddress
  const routerAvailable =
    !!routerRegistry &&
    !defaultTerminalError &&
    !!defaultTerminal &&
    (defaultTerminal as Address) !== zeroAddress

  const { data: currentHook, refetch: refetchHook } = useReadContract({
    abi: jbBuybackHookRegistryAbi,
    address: buybackRegistry,
    functionName: 'hookOf',
    args: [BigInt(projectId)],
    chainId,
    query: { enabled: !!buybackRegistry, staleTime: 30_000 },
  })
  const { data: currentTerminal, refetch: refetchTerminal } = useReadContract({
    abi: jbRouterTerminalRegistryAbi,
    address: routerRegistry,
    functionName: 'terminalOf',
    args: [BigInt(projectId)],
    chainId,
    query: { enabled: !!routerRegistry, staleTime: 30_000 },
  })

  const isAuthority =
    mounted &&
    isConnected &&
    !!address &&
    !!authority &&
    address.toLowerCase() === authority.toLowerCase()

  const hook = (currentHook as Address | undefined) ?? undefined
  const terminal = (currentTerminal as Address | undefined) ?? undefined
  const hookSet = !!hook && hook !== zeroAddress
  const terminalSet = !!terminal && terminal !== zeroAddress

  return (
    <section className="card p-5">
      <span className="field-label">Buyback &amp; swap router</span>
      <p className="mt-2 text-sm leading-relaxed text-smoke-700">
        {isRevnet
          ? 'The operator can wire up the revnet’s buyback hook and swap router and initialize its Uniswap pool.'
          : 'Wire up the project’s buyback hook and swap router and initialize its Uniswap pool.'}
      </p>

      <div className="mt-4 divide-y divide-smoke-100">
        {/* Buyback hook -------------------------------------------------- */}
        <div className="py-3.5">
          <span className="text-sm font-medium text-ink">Buyback hook</span>
          <p className="mt-1 text-xs leading-relaxed text-smoke-700">
            The hook that decides, on every payment, whether to issue new tokens
            or buy them on the AMM.
          </p>
          <CurrentLine
            chainId={chainId}
            available={buybackAvailable}
            set={hookSet}
            value={hook}
          />
          {isAuthority && buybackAvailable ? (
            <ActionFlow
              chainId={chainId}
              projectId={projectId}
              target={buybackRegistry!}
              abi={jbBuybackHookRegistryAbi as Abi}
              functionName="setHookFor"
              actionLabel="Set buyback hook"
              danger="Dangerous: the buyback hook intercepts every payment and decides issuance-vs-AMM routing. A wrong hook can misroute or strand funds."
              fields={[
                {
                  name: 'hook',
                  label: 'Buyback hook',
                  kind: 'address',
                  placeholder: '0x… buyback hook',
                  initial: hookSet ? hook : '',
                },
              ]}
              buildArgs={(pid, v) => [pid, v.hook as Address]}
              onDone={() => refetchHook()}
            />
          ) : null}
        </div>

        {/* Router terminal ---------------------------------------------- */}
        <div className="py-3.5">
          <span className="text-sm font-medium text-ink">Swap router terminal</span>
          <p className="mt-1 text-xs leading-relaxed text-smoke-700">
            The terminal the swap router forwards into for this project (used
            when paying in USDC and other tokens).
          </p>
          <CurrentLine
            chainId={chainId}
            available={routerAvailable}
            set={terminalSet}
            value={terminal}
          />
          {isAuthority && routerAvailable ? (
            <ActionFlow
              chainId={chainId}
              projectId={projectId}
              target={routerRegistry!}
              abi={jbRouterTerminalRegistryAbi as Abi}
              functionName="setTerminalFor"
              actionLabel="Set router terminal"
              danger="Dangerous: this reroutes where router-swapped funds are deposited. A wrong terminal can misdirect or strand funds."
              fields={[
                {
                  name: 'terminal',
                  label: 'Router terminal',
                  kind: 'address',
                  placeholder: '0x… router terminal',
                  initial: terminalSet ? terminal : '',
                },
              ]}
              buildArgs={(pid, v) => [pid, v.terminal as Address]}
              onDone={() => refetchTerminal()}
            />
          ) : null}
        </div>

        {/* Initialize buyback pool -------------------------------------- */}
        <div className="py-3.5">
          <span className="text-sm font-medium text-ink">Buyback pool</span>
          <p className="mt-1 text-xs leading-relaxed text-smoke-700">
            Create and price-initialize the Uniswap v4 buyback pool, keyed by the
            pair (terminal) token. Set the buyback hook first — the pool is
            created through the project’s configured hook.
          </p>
          {!buybackAvailable ? (
            <p className="mt-1.5 text-xs text-smoke-500">
              Not available on this chain.
            </p>
          ) : null}
          {isAuthority && buybackAvailable ? (
            <ActionFlow
              chainId={chainId}
              projectId={projectId}
              target={buybackRegistry!}
              abi={jbBuybackHookRegistryAbi as Abi}
              functionName="initializePoolFor"
              actionLabel="Initialize buyback pool"
              danger="Dangerous: a wrong initial price (sqrtPriceX96) lets arbitrageurs drain value from the pool. Set it to the issuance rate, and verify the fee and tick-spacing pair."
              extreme
              fields={[
                { name: 'fee', label: 'Fee (hundredths of a bip)', kind: 'uint', placeholder: 'e.g. 3000 (0.3%), 10000 (1%)' },
                { name: 'tickSpacing', label: 'Tick spacing', kind: 'uint', placeholder: 'matches fee: 0.3% → 60, 1% → 200, 0.05% → 10' },
                { name: 'twapWindow', label: 'TWAP window (seconds)', kind: 'uint', placeholder: 'e.g. 1800 (30 min)' },
                {
                  name: 'terminalToken',
                  label: 'Pair (terminal) token',
                  kind: 'address',
                  placeholder: '0x… pair token',
                  initial: NATIVE_TOKEN,
                  help: 'Use the native-token sentinel for native ETH pools; otherwise the pair token (e.g. USDC).',
                },
                { name: 'sqrtPriceX96', label: 'Initial price (sqrtPriceX96)', kind: 'uint', placeholder: 'pool price as sqrtPriceX96 (issuance rate)' },
              ]}
              buildArgs={(pid, v) => [
                pid,
                v.fee as bigint,
                v.tickSpacing as bigint,
                v.twapWindow as bigint,
                v.terminalToken as Address,
                v.sqrtPriceX96 as bigint,
              ]}
            />
          ) : null}
        </div>
      </div>
    </section>
  )
}

function CurrentLine({
  chainId,
  available,
  set,
  value,
}: {
  chainId: JBChainId
  available: boolean
  set: boolean
  value: Address | undefined
}) {
  if (!available) {
    return (
      <p className="mt-1.5 text-xs text-smoke-500">Not available on this chain.</p>
    )
  }
  if (!set || !value) {
    return <p className="mt-1.5 text-xs text-smoke-500">Not set</p>
  }
  return (
    <p className="mt-1.5 text-xs text-smoke-700">
      Current: <EtherscanAddress chainId={chainId} address={value} />
    </p>
  )
}

// ------------------------------------------------------------------ shared UI --

const etherscanHostOf = (chainId: JBChainId) =>
  JB_CHAINS[chainId]?.etherscanHostname

function etherscanTx(chainId: JBChainId, hash: `0x${string}` | null): string | null {
  const host = etherscanHostOf(chainId)
  return hash && host ? `https://${host}/tx/${hash}` : null
}

function EtherscanAddress({
  chainId,
  address,
}: {
  chainId: JBChainId
  address: string
}) {
  const host = etherscanHostOf(chainId)
  const label = truncateAddress(address)
  if (!host) return <span className="font-mono text-ink">{label}</span>
  return (
    <a
      href={`https://${host}/address/${address}`}
      target="_blank"
      rel="noopener noreferrer"
      className="font-mono text-ink hover:underline"
    >
      {label}
    </a>
  )
}

class FlowError extends Error {}

function shortError(e: unknown): string {
  if (e instanceof FlowError) return e.message
  if (!(e instanceof Error)) return 'Something went wrong.'
  const message =
    'shortMessage' in e && typeof e.shortMessage === 'string'
      ? e.shortMessage
      : e.message
  if (/denied|rejected/i.test(message)) return 'Transaction cancelled.'
  return message.split('\n')[0]
}

const txBusy = (phase: string) =>
  phase === 'simulating' || phase === 'signing' || phase === 'pending'

function actionLabelText(args: {
  checking: boolean
  phase: string
  hasReview: boolean
  idle: string
  confirm: string
}): string {
  if (args.checking) return 'Checking onchain state…'
  if (args.phase === 'simulating') return 'Double-checking the transaction…'
  if (args.phase === 'signing') return 'Confirm in your wallet…'
  if (args.phase === 'pending') return 'Sending…'
  return args.hasReview ? args.confirm : args.idle
}

function DangerAck({
  checked,
  onChange,
  disabled,
  children,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled: boolean
  children: React.ReactNode
}) {
  return (
    <label className="mt-3 flex cursor-pointer items-start gap-2.5 rounded-lg border border-red-300 bg-red-50 px-3.5 py-3">
      <input
        type="checkbox"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
        disabled={disabled}
        className="mt-0.5 h-4 w-4 shrink-0 accent-red-600"
      />
      <span className="text-xs leading-relaxed text-red-700">{children}</span>
    </label>
  )
}

function ErrorNote({ message }: { message: string }) {
  return (
    <p className="mt-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
      {message}
    </p>
  )
}

function PendingNote({
  chainId,
  hash,
}: {
  chainId: JBChainId
  hash: `0x${string}` | null
}) {
  const url = etherscanTx(chainId, hash)
  if (!url) return null
  return (
    <TransactionInProgress className="mt-3">
      Waiting for confirmation —{' '}
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="underline underline-offset-2"
      >
        view transaction
      </a>
    </TransactionInProgress>
  )
}

function TxDone({
  chainId,
  hash,
  message,
  onDone,
}: {
  chainId: JBChainId
  hash: `0x${string}` | null
  message: string
  onDone: () => void
}) {
  const url = etherscanTx(chainId, hash)
  return (
    <div className="mt-3 rounded-xl border border-smoke-200 p-4">
      <p className="text-sm font-medium text-ink">{message}</p>
      <div className="mt-2 flex gap-3 text-sm font-semibold">
        {url ? (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-bluebs-600 underline underline-offset-2 hover:text-bluebs-700"
          >
            View transaction
          </a>
        ) : null}
        <button onClick={onDone} className="text-smoke-700 hover:text-ink">
          Done
        </button>
      </div>
    </div>
  )
}

// -------------------------------------------------------- generic action flow --

type FlowField = {
  name: string
  label: string
  kind: 'address' | 'uint'
  placeholder?: string
  help?: string
  initial?: string
}

type ResolvedValues = Record<string, Address | bigint>

function ActionFlow({
  chainId,
  projectId,
  target,
  abi,
  functionName,
  actionLabel,
  danger,
  extreme,
  fields,
  buildArgs,
  onDone,
}: {
  chainId: JBChainId
  projectId: number
  target: Address
  abi: Abi
  functionName: string
  actionLabel: string
  danger: string
  extreme?: boolean
  fields: FlowField[]
  buildArgs: (projectId: bigint, v: ResolvedValues) => readonly unknown[]
  onDone?: () => void
}) {
  const { address } = useWallet()
  const tx = useSafeTx(chainId)

  const [open, setOpen] = useState(false)
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map(f => [f.name, f.initial ?? ''])),
  )
  const [ack, setAck] = useState(false)
  const [ackExtreme, setAckExtreme] = useState(false)
  const [flowError, setFlowError] = useState<string | null>(null)
  const [review, setReview] = useState<{
    args: readonly unknown[]
    account: Address
    display: { label: string; value: string }[]
  } | null>(null)

  const busy = txBusy(tx.phase)

  const invalidate = () => {
    setReview(null)
    setAck(false)
    setAckExtreme(false)
    setFlowError(null)
  }

  const setField = (name: string, value: string) => {
    setValues(prev => ({ ...prev, [name]: value }))
    invalidate()
  }

  const closeAndReset = () => {
    setOpen(false)
    setValues(Object.fromEntries(fields.map(f => [f.name, f.initial ?? ''])))
    invalidate()
    tx.reset()
  }

  useEffect(() => {
    if (tx.phase === 'success') onDone?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tx.phase])

  const handleReview = () => {
    if (!address || busy) return
    setFlowError(null)
    const resolved: ResolvedValues = {}
    const display: { label: string; value: string }[] = []
    try {
      for (const f of fields) {
        const raw = (values[f.name] ?? '').trim()
        if (f.kind === 'address') {
          const addr = resolvedAddress(raw)
          if (!addr) throw new FlowError(`Enter a valid address for “${f.label}”.`)
          resolved[f.name] = addr
          display.push({ label: f.label, value: truncateAddress(addr) })
        } else {
          if (!/^[0-9]+$/.test(raw)) {
            throw new FlowError(`“${f.label}” must be a whole number.`)
          }
          resolved[f.name] = BigInt(raw)
          display.push({ label: f.label, value: raw })
        }
      }
    } catch (e) {
      setFlowError(shortError(e))
      return
    }
    setReview({
      args: buildArgs(BigInt(projectId), resolved),
      account: address,
      display,
    })
  }

  const handleConfirm = () => {
    if (!review || !ack || busy) return
    if (extreme && !ackExtreme) return
    if (address?.toLowerCase() !== review.account.toLowerCase()) {
      invalidate()
      setFlowError('Your connected account changed — review again.')
      return
    }
    tx.send({
      chainId,
      address: target,
      abi,
      functionName,
      args: review.args,
    })
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="mt-3 min-h-[36px] rounded-xl border border-red-300 px-3.5 text-sm font-medium text-red-700 transition-colors hover:bg-red-50"
      >
        {actionLabel}
      </button>
    )
  }

  if (tx.phase === 'success') {
    return (
      <TxDone
        chainId={chainId}
        hash={tx.hash}
        message={`${actionLabel} done. This page picks up the change in about a minute.`}
        onDone={closeAndReset}
      />
    )
  }

  return (
    <div className="mt-3 rounded-xl border border-red-200 p-4">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium text-ink">{actionLabel}</span>
        <button
          onClick={closeAndReset}
          disabled={busy}
          className="text-xs font-medium text-smoke-700 hover:text-ink disabled:opacity-50"
        >
          Cancel
        </button>
      </div>

      <div className="mt-3 space-y-3">
        {fields.map(f => (
          <label key={f.name} className="block">
            <span className="field-label">{f.label}</span>
            <div className="mt-1.5">
              {f.kind === 'address' ? (
                <AddressField
                  value={values[f.name] ?? ''}
                  onChange={v => setField(f.name, v)}
                  disabled={busy}
                  placeholder={f.placeholder}
                  ariaLabel={f.label}
                />
              ) : (
                <input
                  type="text"
                  inputMode="numeric"
                  value={values[f.name] ?? ''}
                  onChange={e => setField(f.name, e.target.value)}
                  disabled={busy}
                  placeholder={f.placeholder}
                  aria-label={f.label}
                  className="input-well min-h-[44px] w-full px-4 text-sm font-medium disabled:opacity-60"
                />
              )}
            </div>
            {f.help ? (
              <span className="mt-1 block text-xs text-smoke-500">{f.help}</span>
            ) : null}
          </label>
        ))}
      </div>

      {review ? (
        <div className="callout callout-info mt-3 text-xs">
          <p className="font-semibold">Review</p>
          <dl className="mt-1 space-y-0.5">
            {review.display.map(d => (
              <div key={d.label} className="flex justify-between gap-3">
                <dt className="text-smoke-700">{d.label}</dt>
                <dd className="font-mono text-ink">{d.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}

      {review ? (
        <DangerAck checked={ack} onChange={setAck} disabled={busy}>
          {danger}
        </DangerAck>
      ) : null}
      {review && extreme ? (
        <DangerAck checked={ackExtreme} onChange={setAckExtreme} disabled={busy}>
          I have verified the pool parameters, especially the initial price. A
          wrong price can be drained by arbitrageurs.
        </DangerAck>
      ) : null}

      <button
        onClick={review ? handleConfirm : handleReview}
        disabled={busy || (!!review && (!ack || (!!extreme && !ackExtreme)))}
        className="btn-primary mt-3 min-h-[44px] w-full text-sm"
      >
        {actionLabelText({
          checking: false,
          phase: tx.phase,
          hasReview: !!review,
          idle: `Review ${actionLabel.toLowerCase()}`,
          confirm: actionLabel,
        })}
      </button>

      {tx.phase === 'pending' ? <PendingNote chainId={chainId} hash={tx.hash} /> : null}
      {flowError || tx.error ? <ErrorNote message={flowError ?? tx.error!} /> : null}
    </div>
  )
}
