'use client'

import {
  JB_CHAINS,
  JBCoreContracts,
  NATIVE_TOKEN,
  jbContractAddress,
  jbControllerAbi,
  jbDirectoryAbi,
  jbMultiTerminalAbi,
  jbProjectsAbi,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import {
  buildAccountingContext,
  getCurrentRuleset,
} from '@bananapus/nana-sdk-core/v6'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import {
  parseUnits,
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
import { isKnownController } from '@/lib/manage'

/**
 * Powers card (custom projects only; website/ parity: renderPowersCard). Each
 * of the seven owner powers is a ruleset metadata flag plus, when the flag is
 * on and the connected wallet owns the project, a danger-gated action that
 * goes through useSafeTx (simulate-first). Disabled powers explain that the
 * current rules don't allow them — turning one on needs a ruleset change.
 *
 * Every action follows the FundsTab pattern: review re-reads LIVE state
 * (ownerOf, the ruleset flag, and — for controller-targeted calls — the
 * resolved controller), freezes the exact args, re-checks the connected
 * account at confirm, and only then signs.
 */
export function PowersCard({
  chainId,
  projectId,
}: {
  chainId: JBChainId
  projectId: number
}) {
  usePreloadTransactionAnimation()
  const { isConnected, address } = useWallet()
  const publicClient = usePublicClient({ chainId }) as PublicClient | undefined

  // Wallet state is client-only; keep SSR + first client render identical.
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  const { data: owner } = useReadContract({
    abi: jbProjectsAbi,
    address: jbContractAddress['6'][JBCoreContracts.JBProjects][chainId],
    functionName: 'ownerOf',
    args: [BigInt(projectId)],
    chainId,
    query: { staleTime: 30_000 },
  })

  const { data: controller } = useReadContract({
    abi: jbDirectoryAbi,
    address: jbContractAddress['6'][JBCoreContracts.JBDirectory][chainId],
    functionName: 'controllerOf',
    args: [BigInt(projectId)],
    chainId,
    query: { staleTime: 60_000 },
  })

  const { data: rulesetData, isLoading: rulesetLoading } = useQuery({
    queryKey: ['powersRuleset', chainId, projectId],
    enabled: !!publicClient,
    staleTime: 60_000,
    retry: 1,
    queryFn: () =>
      getCurrentRuleset(publicClient!, {
        chainId,
        projectId: BigInt(projectId),
      }),
  })

  const isOwner =
    mounted &&
    isConnected &&
    !!address &&
    !!owner &&
    owner.toLowerCase() === address.toLowerCase()

  const knownController = isKnownController(chainId, controller as Address)
  const metadata = rulesetData?.metadata

  return (
    <section className="card p-5">
      <span className="field-label">Powers</span>
      <p className="mt-2 text-sm leading-relaxed text-smoke-700">
        What the current rules let the owner do. Enabled powers can be used
        here; disabled ones need a ruleset change to turn on.
      </p>

      {rulesetLoading || !metadata ? (
        <p className="mt-3 text-sm text-smoke-500">Loading…</p>
      ) : (
        <ul className="mt-4 divide-y divide-smoke-100">
          {POWERS.map(power => (
            <PowerRow
              key={power.flag}
              chainId={chainId}
              projectId={projectId}
              power={power}
              enabled={!!metadata[power.flag]}
              isOwner={isOwner}
              controller={controller as Address | undefined}
              knownController={knownController}
            />
          ))}
        </ul>
      )}
    </section>
  )
}

// ---------------------------------------------------------- power descriptors --

export type PowerFlag =
  | 'allowOwnerMinting'
  | 'allowAddPriceFeed'
  | 'allowSetTerminals'
  | 'allowSetController'
  | 'allowTerminalMigration'
  | 'allowSetCustomToken'
  | 'allowAddAccountingContext'

export type FieldKind = 'address' | 'amount' | 'uint' | 'decimals' | 'bool'

export type FlowField = {
  name: string
  label: string
  kind: FieldKind
  placeholder?: string
  help?: string
  /** Initial text value; ADDR_CONNECTED / ADDR_CONTROLLER / ADDR_TERMINAL are
   *  resolved at render, otherwise used literally. */
  initial?: string | 'ADDR_CONNECTED' | 'ADDR_CONTROLLER' | 'ADDR_TERMINAL'
}

export type ResolvedValues = Record<
  string,
  Address | bigint | number | boolean
>

export type PowerDescriptor = {
  flag: PowerFlag
  label: string
  desc: string
  actionLabel: string
  danger: string
  /** setController is catastrophic — require a second acknowledgement. */
  extreme?: boolean
  /** Which contract the write targets. */
  target: 'controller' | 'directory' | 'terminal'
  functionName: string
  fields: FlowField[]
  /** Controller-targeted calls must run against the project's own controller. */
  needsController: boolean
  buildArgs: (projectId: bigint, v: ResolvedValues) => readonly unknown[]
}

export const POWERS: PowerDescriptor[] = [
  {
    flag: 'allowOwnerMinting',
    label: 'Mint tokens',
    desc: 'Mint new project tokens to any address without a payment.',
    actionLabel: 'Mint tokens',
    danger:
      'Irreversible: minting dilutes every existing token holder and cannot be undone.',
    target: 'controller',
    functionName: 'mintTokensOf',
    needsController: true,
    fields: [
      { name: 'tokenCount', label: 'Amount (tokens)', kind: 'amount', placeholder: '0.0' },
      {
        name: 'beneficiary',
        label: 'Recipient',
        kind: 'address',
        placeholder: '0x… recipient',
        initial: 'ADDR_CONNECTED',
      },
      {
        name: 'useReservedPercent',
        label: 'Also send the reserved share',
        kind: 'bool',
        help: 'On: split this mint with the reserved recipients too. Off: the recipient gets the full amount.',
      },
    ],
    buildArgs: (pid, v) => [
      pid,
      v.tokenCount as bigint,
      v.beneficiary as Address,
      '',
      v.useReservedPercent as boolean,
    ],
  },
  {
    flag: 'allowAddPriceFeed',
    label: 'Add price feed',
    // JBPrices.addPriceFeedFor is controller-only (_onlyControllerOf); the
    // owner path is JBController.addPriceFeedFor, which checks this flag and
    // forwards to JBPrices.
    desc: 'Register a price feed the project uses to convert between currencies (e.g. ETH to USD).',
    actionLabel: 'Add price feed',
    danger:
      'Irreversible: a price feed cannot be removed once added, and a wrong feed misprices the whole project.',
    target: 'controller',
    functionName: 'addPriceFeedFor',
    needsController: true,
    fields: [
      { name: 'pricingCurrency', label: 'Pricing currency (id)', kind: 'uint', placeholder: 'e.g. 2 (USD)' },
      { name: 'unitCurrency', label: 'Unit currency (id)', kind: 'uint', placeholder: 'e.g. 1 (ETH)' },
      { name: 'feed', label: 'Feed', kind: 'address', placeholder: '0x… price feed' },
    ],
    buildArgs: (pid, v) => [
      pid,
      v.pricingCurrency as bigint,
      v.unitCurrency as bigint,
      v.feed as Address,
    ],
  },
  {
    flag: 'allowSetTerminals',
    label: 'Set payment terminals',
    desc: 'Set the terminals where funds are paid in. Defaults to the standard terminal.',
    actionLabel: 'Set terminals',
    danger:
      'Dangerous: this reroutes where funds are paid in. A wrong terminal can misdirect or strand funds.',
    target: 'directory',
    functionName: 'setTerminalsOf',
    needsController: false,
    fields: [
      {
        name: 'terminal',
        label: 'Terminal',
        kind: 'address',
        placeholder: '0x… terminal',
        initial: 'ADDR_TERMINAL',
      },
    ],
    buildArgs: (pid, v) => [pid, [v.terminal as Address]],
  },
  {
    flag: 'allowSetController',
    label: 'Set controller',
    desc: 'Swap the controller contract that manages the rulesets and tokens. Defaults to the standard controller.',
    actionLabel: 'Set controller',
    danger:
      'Dangerous: this hands control of the rules and tokens to a new contract. A wrong address can permanently brick or compromise the project.',
    extreme: true,
    target: 'directory',
    functionName: 'setControllerOf',
    needsController: false,
    fields: [
      {
        name: 'controller',
        label: 'Controller',
        kind: 'address',
        placeholder: '0x… controller',
        initial: 'ADDR_CONTROLLER',
      },
    ],
    buildArgs: (pid, v) => [pid, v.controller as Address],
  },
  {
    flag: 'allowTerminalMigration',
    label: 'Migrate terminal balance',
    desc: 'Move the project’s balance for a token from the current terminal to another terminal.',
    actionLabel: 'Migrate balance',
    danger:
      'Dangerous: this moves the project’s funds to another terminal. A wrong destination can lose the funds.',
    target: 'terminal',
    functionName: 'migrateBalanceOf',
    needsController: false,
    fields: [
      {
        name: 'token',
        label: 'Token',
        kind: 'address',
        placeholder: '0x… token',
        initial: NATIVE_TOKEN,
        help: 'Use the native-token sentinel for ETH.',
      },
      { name: 'to', label: 'New terminal', kind: 'address', placeholder: '0x… destination terminal' },
    ],
    buildArgs: (pid, v) => [pid, v.token as Address, v.to as Address],
  },
  {
    flag: 'allowSetCustomToken',
    label: 'Set custom token',
    desc: 'Replace the project token with a custom ERC-20 (it must conform to IJBToken).',
    actionLabel: 'Set token',
    danger:
      'Irreversible: replacing the project token is permanent and affects every holder.',
    target: 'controller',
    functionName: 'setTokenFor',
    needsController: true,
    fields: [
      { name: 'token', label: 'Token', kind: 'address', placeholder: '0x… ERC-20 (IJBToken)' },
    ],
    buildArgs: (pid, v) => [pid, v.token as Address],
  },
  {
    flag: 'allowAddAccountingContext',
    label: 'Add accounting token',
    desc: 'Register a new token the project’s terminal accepts directly (e.g. an ERC-20 or USDC), with its decimals.',
    actionLabel: 'Add accounting token',
    danger:
      'Irreversible: once added, the terminal accepts this token forever — accounting tokens cannot be removed. Verify the token and its decimals carefully.',
    target: 'terminal',
    functionName: 'addAccountingContextsFor',
    needsController: false,
    fields: [
      { name: 'token', label: 'Token', kind: 'address', placeholder: '0x… ERC-20' },
      { name: 'decimals', label: 'Decimals', kind: 'decimals', placeholder: 'e.g. 6 (USDC), 18 (most ERC-20)' },
    ],
    // currency = uint32(uint160(token)); buildAccountingContext derives it.
    buildArgs: (pid, v) => [
      pid,
      [buildAccountingContext(v.token as Address, Number(v.decimals))],
    ],
  },
]

// ------------------------------------------------------------------ shared UI --

const etherscanHostOf = (chainId: JBChainId) =>
  JB_CHAINS[chainId]?.etherscanHostname

function etherscanTx(chainId: JBChainId, hash: `0x${string}` | null): string | null {
  const host = etherscanHostOf(chainId)
  return hash && host ? `https://${host}/tx/${hash}` : null
}

/** A validation failure with copy that's already user-ready. */
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

function actionLabel(args: {
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

// -------------------------------------------------------------------- one row --

function PowerRow({
  chainId,
  projectId,
  power,
  enabled,
  isOwner,
  controller,
  knownController,
}: {
  chainId: JBChainId
  projectId: number
  power: PowerDescriptor
  enabled: boolean
  isOwner: boolean
  controller: Address | undefined
  knownController: boolean
}) {
  const controllerBlocked = power.needsController && !knownController

  return (
    <li className="py-3.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-sm font-medium text-ink">{power.label}</span>
        <span
          className={`chip text-[11px] ${
            enabled ? 'bg-melon-100 text-melon-700' : 'bg-smoke-100 text-smoke-700'
          }`}
        >
          {enabled ? 'Enabled' : 'Disabled'}
        </span>
      </div>
      <p className="mt-1 text-xs leading-relaxed text-smoke-700">{power.desc}</p>

      {!enabled ? (
        <p className="mt-1.5 text-xs text-smoke-500">
          The current rules don’t allow this.
        </p>
      ) : isOwner && controllerBlocked ? (
        <p className="mt-1.5 text-xs text-smoke-500">
          This project uses a custom controller — this power can’t be used here.
        </p>
      ) : isOwner ? (
        <PowerFlow
          chainId={chainId}
          projectId={projectId}
          power={power}
          controller={controller}
          knownController={knownController}
        />
      ) : null}
    </li>
  )
}

// -------------------------------------------------------- generic action flow --

const CONTROLLER_ABI = jbControllerAbi as Abi
const DIRECTORY_ABI = jbDirectoryAbi as Abi
const TERMINAL_ABI = jbMultiTerminalAbi as Abi

function PowerFlow({
  chainId,
  projectId,
  power,
  controller,
  knownController,
}: {
  chainId: JBChainId
  projectId: number
  power: PowerDescriptor
  controller: Address | undefined
  knownController: boolean
}) {
  const publicClient = usePublicClient({ chainId }) as PublicClient | undefined
  const { address } = useWallet()
  const tx = useSafeTx(chainId)

  const controllerAddr = jbContractAddress['6'][JBCoreContracts.JBController][
    chainId
  ] as Address
  const directoryAddr = jbContractAddress['6'][JBCoreContracts.JBDirectory][
    chainId
  ] as Address
  const terminalAddr = jbContractAddress['6'][JBCoreContracts.JBMultiTerminal][
    chainId
  ] as Address

  // The default text for the ADDR_* sentinels, resolved once we know the chain
  // contracts + the connected wallet.
  const initialFor = (f: FlowField): string => {
    if (f.initial === 'ADDR_CONNECTED') return address ?? ''
    if (f.initial === 'ADDR_CONTROLLER') return controllerAddr
    if (f.initial === 'ADDR_TERMINAL') return terminalAddr
    return f.initial ?? ''
  }

  const [open, setOpen] = useState(false)
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(power.fields.map(f => [f.name, initialFor(f)])),
  )
  const [bools, setBools] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(
      power.fields.filter(f => f.kind === 'bool').map(f => [f.name, false]),
    ),
  )
  const [checking, setChecking] = useState(false)
  const [ack, setAck] = useState(false)
  const [ackExtreme, setAckExtreme] = useState(false)
  const [flowError, setFlowError] = useState<string | null>(null)
  const [review, setReview] = useState<{
    args: readonly unknown[]
    account: Address
    display: { label: string; value: string }[]
  } | null>(null)

  const target =
    power.target === 'controller'
      ? (controller ?? controllerAddr)
      : power.target === 'directory'
        ? directoryAddr
        : terminalAddr
  const abi =
    power.target === 'controller'
      ? CONTROLLER_ABI
      : power.target === 'directory'
        ? DIRECTORY_ABI
        : TERMINAL_ABI

  const busy = checking || txBusy(tx.phase)

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
  const setBool = (name: string, value: boolean) => {
    setBools(prev => ({ ...prev, [name]: value }))
    invalidate()
  }

  const closeAndReset = () => {
    setOpen(false)
    setValues(Object.fromEntries(power.fields.map(f => [f.name, initialFor(f)])))
    setBools(
      Object.fromEntries(
        power.fields.filter(f => f.kind === 'bool').map(f => [f.name, false]),
      ),
    )
    invalidate()
    tx.reset()
  }

  /** Resolve, validate, and freeze the args. Throws FlowError with ready copy. */
  const resolveValues = (): { resolved: ResolvedValues; display: { label: string; value: string }[] } => {
    const resolved: ResolvedValues = {}
    const display: { label: string; value: string }[] = []
    for (const f of power.fields) {
      if (f.kind === 'bool') {
        resolved[f.name] = bools[f.name] ?? false
        display.push({ label: f.label, value: bools[f.name] ? 'Yes' : 'No' })
        continue
      }
      const raw = (values[f.name] ?? '').trim()
      if (f.kind === 'address') {
        const addr = resolvedAddress(raw)
        if (!addr) throw new FlowError(`Enter a valid address for “${f.label}”.`)
        if (addr === zeroAddress) {
          throw new FlowError(`“${f.label}” can’t be the zero address.`)
        }
        resolved[f.name] = addr
        display.push({ label: f.label, value: truncateAddress(addr) })
      } else if (f.kind === 'amount') {
        if (!raw || !Number.isFinite(Number(raw)) || Number(raw) <= 0) {
          throw new FlowError(`Enter an amount for “${f.label}”.`)
        }
        let parsed: bigint
        try {
          parsed = parseUnits(raw, 18)
        } catch {
          throw new FlowError(`“${f.label}” isn’t a valid amount.`)
        }
        if (parsed <= 0n) throw new FlowError(`Enter an amount for “${f.label}”.`)
        resolved[f.name] = parsed
        display.push({ label: f.label, value: `${raw} tokens` })
      } else if (f.kind === 'uint') {
        if (!/^[0-9]+$/.test(raw)) {
          throw new FlowError(`“${f.label}” must be a whole number.`)
        }
        resolved[f.name] = BigInt(raw)
        display.push({ label: f.label, value: raw })
      } else if (f.kind === 'decimals') {
        if (!/^[0-9]+$/.test(raw)) {
          throw new FlowError(`“${f.label}” must be a whole number.`)
        }
        const n = Number(raw)
        if (n > 32) throw new FlowError('Decimals must be 32 or fewer.')
        resolved[f.name] = n
        display.push({ label: f.label, value: raw })
      }
    }
    return { resolved, display }
  }

  const handleReview = async () => {
    if (!publicClient || !address || busy) return
    setFlowError(null)
    let resolved: ResolvedValues
    let display: { label: string; value: string }[]
    try {
      ;({ resolved, display } = resolveValues())
    } catch (e) {
      setFlowError(shortError(e))
      return
    }
    setChecking(true)
    try {
      // LIVE re-reads (fail closed): the wallet must still own the project, the
      // ruleset must still allow this power, and controller-targeted calls must
      // still resolve to a known controller matching the frozen target.
      const [liveOwner, liveRuleset] = await Promise.all([
        publicClient.readContract({
          abi: jbProjectsAbi,
          address: jbContractAddress['6'][JBCoreContracts.JBProjects][chainId] as Address,
          functionName: 'ownerOf',
          args: [BigInt(projectId)],
        }) as Promise<Address>,
        getCurrentRuleset(publicClient, { chainId, projectId: BigInt(projectId) }),
      ])
      if (liveOwner.toLowerCase() !== address.toLowerCase()) {
        throw new FlowError('Your wallet no longer owns this project.')
      }
      if (!liveRuleset.metadata[power.flag]) {
        throw new FlowError('The current rules no longer allow this.')
      }
      if (power.needsController) {
        const liveController = (await publicClient.readContract({
          abi: jbDirectoryAbi,
          address: jbContractAddress['6'][JBCoreContracts.JBDirectory][chainId] as Address,
          functionName: 'controllerOf',
          args: [BigInt(projectId)],
        })) as Address
        if (
          !isKnownController(chainId, liveController) ||
          liveController.toLowerCase() !== target.toLowerCase()
        ) {
          throw new FlowError('This project’s controller changed — reopen this power.')
        }
      }
      setReview({
        args: power.buildArgs(BigInt(projectId), resolved),
        account: address,
        display,
      })
    } catch (e) {
      setFlowError(shortError(e))
    } finally {
      setChecking(false)
    }
  }

  const handleConfirm = () => {
    if (!review || !ack || busy) return
    if (power.extreme && !ackExtreme) return
    // Account-unchanged recheck: some frozen args embed the connected account.
    if (address?.toLowerCase() !== review.account.toLowerCase()) {
      invalidate()
      setFlowError('Your connected account changed — review again.')
      return
    }
    tx.send({
      chainId,
      address: target,
      abi,
      functionName: power.functionName,
      args: review.args,
    })
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="mt-3 min-h-[36px] rounded-xl border border-red-300 px-3.5 text-sm font-medium text-red-700 transition-colors hover:bg-red-50"
      >
        {power.actionLabel}
      </button>
    )
  }

  if (tx.phase === 'success') {
    return (
      <TxDone
        chainId={chainId}
        hash={tx.hash}
        message={`${power.label} done. This page picks up any change in about a minute.`}
        onDone={closeAndReset}
      />
    )
  }

  return (
    <div className="mt-3 rounded-xl border border-red-200 p-4">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium text-ink">{power.actionLabel}</span>
        <button
          onClick={closeAndReset}
          disabled={busy}
          className="text-xs font-medium text-smoke-700 hover:text-ink disabled:opacity-50"
        >
          Cancel
        </button>
      </div>

      <div className="mt-3 space-y-3">
        {power.fields.map(f =>
          f.kind === 'bool' ? (
            <label key={f.name} className="flex cursor-pointer items-start gap-2.5">
              <input
                type="checkbox"
                checked={bools[f.name] ?? false}
                onChange={e => setBool(f.name, e.target.checked)}
                disabled={busy}
                className="mt-0.5 h-4 w-4 shrink-0 accent-ink"
              />
              <span className="text-xs leading-relaxed text-smoke-700">
                <span className="font-medium text-ink">{f.label}</span>
                {f.help ? <span className="block">{f.help}</span> : null}
              </span>
            </label>
          ) : (
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
                    inputMode={f.kind === 'amount' ? 'decimal' : 'numeric'}
                    value={values[f.name] ?? ''}
                    onChange={e => setField(f.name, e.target.value)}
                    disabled={busy}
                    placeholder={f.placeholder}
                    aria-label={f.label}
                    className="input-well min-h-[44px] w-full px-4 text-sm font-medium disabled:opacity-60"
                  />
                )}
              </div>
              {f.help && f.kind !== 'address' ? (
                <span className="mt-1 block text-xs text-smoke-500">{f.help}</span>
              ) : null}
            </label>
          ),
        )}
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
          {power.danger}
        </DangerAck>
      ) : null}
      {review && power.extreme ? (
        <DangerAck checked={ackExtreme} onChange={setAckExtreme} disabled={busy}>
          I have triple-checked the controller address. Getting this wrong can
          permanently brick the project.
        </DangerAck>
      ) : null}

      <button
        onClick={review ? handleConfirm : handleReview}
        disabled={busy || (!!review && (!ack || (power.extreme && !ackExtreme)))}
        className="btn-primary mt-3 min-h-[44px] w-full text-sm"
      >
        {actionLabel({
          checking,
          phase: tx.phase,
          hasReview: !!review,
          idle: `Review ${power.actionLabel.toLowerCase()}`,
          confirm: power.actionLabel,
        })}
      </button>

      {tx.phase === 'pending' ? <PendingNote chainId={chainId} hash={tx.hash} /> : null}
      {flowError || tx.error ? <ErrorNote message={flowError ?? tx.error!} /> : null}
    </div>
  )
}
