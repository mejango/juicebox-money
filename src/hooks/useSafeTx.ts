'use client'

import { createElement, useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactElement } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { invalidateProjectDisplayQueries } from '@/lib/project-display-cache'
import { getAccount } from '@wagmi/core'
import { WriteHeldNotice } from '@/components/ui/WriteHeldNotice'
import { settledLine, writeHolds } from '@/lib/write-holds'
import {
  BaseError,
  encodeFunctionData,
  isHash,
  keccak256,
  stringToHex,
  type Abi,
  type Address,
  type Hex,
  type TransactionReceipt,
} from 'viem'
import {
  usePublicClient,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi'
import { useWallet } from '@/hooks/useWallet'
import { useWriteHoldWatch } from '@/hooks/useWriteHoldWatch'
import { submitReviewedContractWrite } from '@/lib/contract-write'
import { captureWalletContext } from '@/lib/wallet-context'
import {
  gasWithHeadroom,
  SAFE_PROPOSAL_EXECUTED_LINE,
  SAFE_PROPOSAL_REPLACED_LINE,
  SubmittedContractWriteError,
  waitForTrackedReceipt,
  WRITE_HOLD_PENDING_LINE,
  WriteHeldError,
  WriteHoldBusyError,
  WriteHoldNonceError,
  type WriteHeldState,
  type WriteHoldClient,
  type WriteHoldSettled,
  type WriteHoldGate,
  type WriteHoldHandle,
} from '@bananapus/nana-sdk-core/review'
import { hasSafeService } from '@bananapus/nana-sdk-core/safe-service'
import { getViewAs, VIEW_AS_WRITE_BLOCKED } from '@/lib/viewAs'
import {
  requestContractTransactionReview,
  TransactionReviewCancelledError,
} from '@/lib/transaction-review'
import { chainName } from '@/lib/urn'
import { wagmiConfig } from '@/providers/Providers'
import {
  atOnceExecution,
  chainAnswer,
  findPendingSafeAppProposal,
  heldCall,
  isSafeConnection,
  readSafeAppExecution,
  reportedSafeExecution,
  SAFE_NONCE_GUIDANCE,
  SAFE_PROPOSAL_AWAITING,
  SAFE_PROPOSAL_UNCONFIRMED,
  useSafeConnection,
  waitForSafeExecutionHash,
  watchSafeProposal,
  type SafeAppCall,
} from '@/lib/safe-connector'

/** How long the block-subscription watcher gets before its silence is reported. */
const RECEIPT_WATCH_TIMEOUT_MS = 120_000
const RECEIPT_POLL_INTERVAL_MS = 4_000
/** ~10 minutes of direct lookups, matching the watcher's own retry horizon. */
const RECEIPT_POLL_ATTEMPTS = 150
/** After that, one lookup this often while the page is open. */
const RECEIPT_SLOW_POLL_INTERVAL_MS = 45_000

type PolledReceipt = NonNullable<
  Awaited<ReturnType<NonNullable<ReturnType<typeof usePublicClient>>['getTransactionReceipt']>>
>

export type TxPhase =
  | 'idle'
  | 'review'
  | 'simulating'
  | 'signing'
  | 'pending'
  /**
   * A write with no confirmed result holds its exact call: the receipt watch
   * gave up on it, or an earlier one (even from before a reload) is unproven.
   * Nothing is in flight to wait on; the user's exit sends it again.
   */
  | 'unconfirmed'
  /** With a Safe, and not settled here: awaiting its signers, or its result unproven. */
  | 'submitted'
  | 'success'
  | 'error'

type FollowClient = NonNullable<ReturnType<typeof usePublicClient>>

export type TxRequest = {
  chainId: number
  address: `0x${string}`
  abi: Abi
  functionName: string
  args: readonly unknown[]
  value?: bigint
  label?: string
}

export type TxSendOptions = {
  /**
   * The account this request was built for: the one that reviewed it, and
   * whose beneficiary, holder or recipient it names when it names one. Only
   * that account may send it: while another is connected, nothing is reviewed
   * or sent (see contract-write.ts).
   */
  reviewedAccount: Address
  reverify?: (request: TxRequest) => Promise<unknown>
  /** Persist an unknown-submission marker immediately before the wallet write. */
  beforeWrite?: () => unknown | Promise<unknown>
  /** Synchronous caller intent/mount check at the final wallet boundary. */
  assertWriteState?: () => void
  /** Called if the final wallet gate aborts a persisted intent before the wallet write. */
  onBeforeWriteAborted?: () => unknown | Promise<unknown>
  /** Called only for a typed, explicit wallet rejection of the write itself. */
  onWriteRejected?: () => unknown | Promise<unknown>
  /** An app journal (Defifa's) already holds this write; the send keeps no hold of its own. */
  journaled?: boolean
  /**
   * The write hold over that journal's record. A Safe follower's outcomes
   * (unproven, executed, a receipt) go to it, and `onChange` tells the app.
   */
  heldBy?: ExternalHold
  /**
   * The exact request was already rendered in a parent confirmation surface.
   * This skips only the second app-owned review; account checks, revalidation,
   * simulation, duplicate protection, and the wallet confirmation still run.
   */
  reviewedInParent?: boolean
  /**
   * Simulate against a confirmed prerequisite block instead of a load
   * balancer's potentially lagging `latest` view. This is required when the
   * reviewed write immediately follows an ERC-20 or Permit2 approval.
   */
  simulationBlockNumber?: bigint
  /**
   * Plain-language sentence shown at the top of the mandatory review — for
   * when the freshly re-quoted payload is materially worse than what the
   * caller's panel displayed. Raw fixed-point arguments alone are not
   * effective disclosure of that.
   */
  reviewNotice?: string
}

/**
 * The shared in-flight button copy: the fixed simulating/signing strings every
 * flow uses, the caller's `pending` progress text, and its `idle` label
 * (any non-in-flight phase falls through to `idle`). `confirm` overrides the
 * signing string for flows with more specific wallet copy.
 */
export function txPhaseLabel(
  phase: TxPhase,
  labels: { idle: string; pending: string; confirm?: string },
): string {
  if (phase === 'simulating') return 'Double-checking the transaction…'
  if (phase === 'signing') return labels.confirm ?? 'Confirm in your wallet…'
  if (phase === 'pending') return labels.pending
  return labels.idle
}

/** The call a contract write request makes. */
function callOf(request: Pick<TxRequest, 'address' | 'abi' | 'functionName' | 'args' | 'value'>): SafeAppCall {
  return {
    to: request.address,
    data: encodeFunctionData({
      abi: request.abi,
      functionName: request.functionName,
      args: request.args as unknown[],
    }),
    value: request.value,
  }
}

/** A friendly one-line message out of a viem/wagmi error. */
function friendlyTxError(e: unknown): string {
  if (e instanceof BaseError) {
    const short = e.shortMessage || e.message
    if (/user rejected|denied/i.test(short)) return 'Transaction cancelled.'
    return short
  }
  if (e instanceof Error) return e.message
  return 'Something went wrong.'
}

// ── Safe proposals ───────────────────────────────────────────────────────────

/** Where a Safe proposal is, as its follow reads it. */
type ProposalPhase =
  /** The reply may be the execution itself: Safe{Wallet} executing at once. */
  | 'checking'
  /** With the Safe, awaiting its signers. */
  | 'awaiting'
  /** Executed: its receipt is being read. */
  | 'executing'
  /**
   * Executed, and not confirmed yet: its receipt is still missing within the
   * confirmation horizon, or its transaction is not yet shown by a node behind
   * its receipt. A known proposal remains held after that horizon.
   */
  | 'confirming'
  | 'success'
  | 'failed'
  /** Over, but this app can't prove it ran: held until the user dismisses it. */
  | 'unproven'
  /** Its deadline passed before the Safe ran it, so the contract refuses it now. */
  | 'expired'
  /** Another Safe transaction used its nonce, proven at a finalized block. */
  | 'replaced'
  /** The chain shows the Safe ran it, and its execution can't be read here. */
  | 'ran'

/** How a flow shows each: in flight, with the Safe, or settled. */
const SHOWN_AS: Record<ProposalPhase, TxPhase> = {
  checking: 'pending',
  executing: 'pending',
  awaiting: 'submitted',
  confirming: 'submitted',
  unproven: 'submitted',
  success: 'success',
  failed: 'error',
  expired: 'error',
  replaced: 'error',
  ran: 'submitted',
}

const SAFE_EXECUTION_CONFIRMING = 'Executed by your Safe. Confirming it onchain.'
/** What a Safe app replied in place of a proposal or execution hash. */
const SAFE_REPLY_UNREADABLE = 'Safe did not return a proposal hash. Check Safe before sending this again.'
const SAFE_PROPOSAL_EXPIRED = "This Safe proposal's deadline passed. Review it again."
/** A receipt still missing this long after its execution was first seen is not coming. */
const RECEIPT_HORIZON_MS = 60 * 60_000

type SafeProposal = {
  chainId: number
  safe: Address
  call: SafeAppCall
  /** The safeTxHash, or the execution's own hash when Safe{Wallet} executed at once. */
  proposalHash: Hex
  phase: ProposalPhase
  executionHash: Hex | null
  receipt: TransactionReceipt | null
  /** The line for an end other than success: failed, unproven, expired or replaced. */
  message: string | null
}

/**
 * Every Safe proposal made here this session, by chain, Safe and the call it
 * holds: the exact call, with any field stamped at send time blanked
 * ({@link heldCall}). Every useSafeTx shares it and the registry follows each
 * proposal itself, so a flow that closes, remounts or changes chain never
 * drops one, and the same action is never proposed twice while one is
 * pending. Nothing is persisted: a reload starts empty, and Safe's own queue
 * answers for what it holds.
 */
const proposals = new Map<string, SafeProposal>()

/** A write the hold shows held, and the send its exit repeats. */
type HeldWrite = {
  hold: WriteHoldHandle
  request: TxRequest
  options: TxSendOptions
  /** What the hold last said; none while this flow's own send is in flight or followed. */
  state: WriteHeldState | null
  /** A Safe proposal's registry key: an accepted exit drops the registry's entry too. */
  proposalKey?: string
}

/** A Safe write is held by its call with stamped fields blanked, as the registry keys it. */
function safeHoldNamespace(key: string): string {
  return `safe:${keccak256(stringToHex(key)).slice(2)}`
}

function safeHoldOf(proposal: Pick<SafeProposal, 'chainId' | 'safe' | 'call'>, key: string): WriteHoldHandle {
  return writeHolds.open({ chainId: proposal.chainId, account: proposal.safe, safe: true, namespace: safeHoldNamespace(key), call: proposal.call })
}

/** Tell the hold how the registry saw a proposal end; the hold decides what it releases. */
/**
 * The hold an app journal keeps over a Safe write, and how the app hears of a
 * change. The send sets `recorded`; the journal calls it once it saved the
 * proposal's hash, so an outcome that ended before that still reaches the hold.
 */
export type ExternalHold = { hold: WriteHoldHandle; onChange?: () => void; recorded?: () => void }

/** Register an app journal's hold on a proposal before its follower runs. */
function registerExternalHold(key: string, heldBy: ExternalHold | undefined, client: FollowClient): void {
  if (!heldBy) {
    externalHolds.delete(key)
    return
  }
  externalHolds.set(key, heldBy)
  heldBy.recorded = () => {
    // Only an ended follow has an outcome to deliver again; a running one delivers its own.
    if (!followingProposals.has(key)) void settleSafeHold(key, client)
  }
}

/** Safe proposals an app journal holds, by registry key: their follower reports to that hold. */
const externalHolds = new Map<string, ExternalHold>()

async function settleSafeHold(key: string, client: FollowClient): Promise<void> {
  const proposal = proposals.get(key)
  if (!proposal) return
  const external = externalHolds.get(key)
  const hold = external?.hold ?? safeHoldOf(proposal, key)
  try {
    if ((proposal.phase === 'success' || proposal.phase === 'failed') && proposal.receipt) {
      await hold.onReceipt(proposal.receipt, client as never, { calls: [proposal.call] })
    } else if (proposal.phase === 'unproven') {
      // The follower gave up: the hold offers the exit, and later evidence still settles it.
      await hold.onUnproven(client as never, proposal.proposalHash)
    } else if (proposal.phase === 'ran') {
      // The chain showed it ran, but no execution hash is known: the hold looks
      // again itself. onExecuted takes only a hash believed to be the execution.
      await hold.state(client as never)
    } else if (proposal.phase === 'expired' || proposal.phase === 'replaced') {
      await hold.state(client as never)
    }
  } catch {
    // The hold keeps it; its next state() asks again.
  }
  external?.onChange?.()
}

const followingProposals = new Set<string>()
const proposalListeners = new Set<() => void>()

function subscribeProposals(listener: () => void): () => void {
  proposalListeners.add(listener)
  return () => {
    proposalListeners.delete(listener)
  }
}

function notifyProposals(): void {
  for (const listener of proposalListeners) listener()
}

function proposalKey(chainId: number, safe: Address, call: SafeAppCall): string {
  const held = heldCall(call)
  return `${chainId}:${safe.toLowerCase()}:${held.to.toLowerCase()}:${held.value ?? 0n}:${held.data.toLowerCase()}`
}

function updateProposal(key: string, next: Partial<SafeProposal>): void {
  const current = proposals.get(key)
  if (!current) return
  proposals.set(key, { ...current, ...next })
  notifyProposals()
}

/** A distinct execution hash cannot make the original Safe proposal safe to repeat. */
function unconfirmedProposal(key: string, message = SAFE_PROPOSAL_UNCONFIRMED): Partial<SafeProposal> {
  const proposal = proposals.get(key)
  // The chain showed the Safe ran it: an unreadable recheck leaves it so.
  if (proposal?.phase === 'ran') return {}
  const knownProposal = proposal?.executionHash &&
    proposal.executionHash.toLowerCase() !== proposal.proposalHash.toLowerCase()
  return { phase: knownProposal ? 'awaiting' : 'unproven', message }
}

/** Rechecks use the same follower; concurrent flows never start a second one. */
function startFollowingProposal(key: string, client: FollowClient, reply: boolean): void {
  if (followingProposals.has(key)) return
  followingProposals.add(key)
  void followProposal(key, client, reply)
    .catch(() => updateProposal(key, unconfirmedProposal(key)))
    .finally(() => {
      followingProposals.delete(key)
      void settleSafeHold(key, client)
    })
}

/**
 * A proposal holds its call until it ends: while pending, and when unproven
 * until dismissed. It ends with a result, or once it can no longer run.
 */
function holdsCall(proposal: SafeProposal | undefined): proposal is SafeProposal {
  return !!proposal && SHOWN_AS[proposal.phase] !== 'success' && SHOWN_AS[proposal.phase] !== 'error'
}

/** The execution a proposal awaiting its signers runs in, or how it ends before it runs. */
type Outcome = { executionHash: Hex } | { phase: ProposalPhase; message: string }

/**
 * Waits for the proposal's execution, from Safe's service and the chain, and
 * where the service lists the proposal, watches it: it ends early when its
 * deadline passes before the Safe ran it, or when a finalized block shows
 * another Safe transaction used its nonce ({@link watchSafeProposal}). When
 * that block shows the Safe ran it, its execution hash is still awaited; if
 * that can't be read, it ends as ran. Whichever answers first stops the other.
 */
async function awaitExecution(
  { chainId, safe, proposalHash }: SafeProposal,
  client: FollowClient,
): Promise<Outcome> {
  const stop = new AbortController()
  /** A finalized block showed the Safe ran it: an unreadable execution still ends it. */
  let ranOnChain = false
  const executed = waitForSafeExecutionHash(chainId, proposalHash, { client, signal: stop.signal }).then(
    (executionHash): Outcome => ({ executionHash }),
    async (reason: unknown): Promise<Outcome> => {
      // Safe's service says it ran and failed: the execution its record names decides.
      const reported = await reportedSafeExecution(reason, chainId, safe, proposalHash)
      return reported
        ? { executionHash: reported }
        : ranOnChain
          ? { phase: 'ran', message: SAFE_PROPOSAL_EXECUTED_LINE }
          : { phase: 'unproven', message: `${SAFE_PROPOSAL_UNCONFIRMED} ${friendlyTxError(reason)}` }
    },
  )
  const ended = hasSafeService(chainId)
    ? watchSafeProposal(client, chainId, safe, proposalHash, stop.signal).then(
        (end): Outcome | Promise<Outcome> =>
          end === 'expired'
            ? { phase: 'expired', message: SAFE_PROPOSAL_EXPIRED }
            : end === 'replaced'
              ? { phase: 'replaced', message: SAFE_PROPOSAL_REPLACED_LINE }
              : ((ranOnChain = true), executed),
      )
    : new Promise<never>(() => {})
  try {
    return await Promise.race([executed, ended])
  } finally {
    stop.abort()
  }
}

/**
 * Follow a proposal to its result, whatever becomes of the flow that made it.
 * A node that cannot answer keeps the proposal held and is asked again a
 * minute later ({@link chainAnswer}). A known proposal with uncertain execution
 * evidence stays awaiting an explicit recheck, without another wallet send.
 */
async function followProposal(key: string, client: FollowClient, reply: boolean): Promise<void> {
  const proposal = proposals.get(key)
  if (!proposal) return
  const { safe, call, proposalHash } = proposal
  // A reply the chain knows as a transaction is the execution itself; the
  // transaction read here is the one the execution is bound on.
  let execution = reply ? await atOnceExecution(client, proposalHash) : null
  let executionHash = execution ? proposalHash : null
  if (!executionHash) {
    // A recheck of one the Safe ran keeps saying so while it looks.
    if (proposal.phase !== 'ran') updateProposal(key, { phase: 'awaiting' })
    const awaited = await awaitExecution(proposal, client)
    if ('executionHash' in awaited) executionHash = awaited.executionHash
    // An execution returned at once that the node learned only after the probe
    // is the execution: the chain is asked once more before the proposal ends.
    else if (
      awaited.phase === 'unproven' &&
      (execution = await chainAnswer(() => client.getTransaction({ hash: proposalHash })))
    ) {
      executionHash = proposalHash
    } else {
      updateProposal(key, awaited.phase === 'unproven' ? unconfirmedProposal(key, awaited.message) : awaited)
      return
    }
  }
  updateProposal(key, { phase: 'executing', executionHash })
  const failed = `Safe executed the proposal, but the onchain transaction failed (${executionHash}).`
  // The execution was first seen now: its receipt has an hour from here.
  const seenAt = Date.now()
  let receipt: TransactionReceipt | null = null
  while (!receipt) {
    receipt = await waitForTrackedReceipt(client, executionHash).catch(() => null)
    if (receipt) break
    if (Date.now() - seenAt >= RECEIPT_HORIZON_MS) {
      const hash = executionHash
      receipt = await chainAnswer(() => client.getTransactionReceipt({ hash }))
      if (!receipt) {
        updateProposal(key, unconfirmedProposal(key))
        return
      }
      break
    }
    updateProposal(key, { phase: 'confirming' })
  }
  if (receipt.status !== 'success') {
    updateProposal(key, {
      ...(executionHash.toLowerCase() === proposalHash.toLowerCase()
        ? { phase: 'failed' as const, message: failed }
        : unconfirmedProposal(key)),
      receipt,
    })
    return
  }
  // Only the Safe's own event for this proposal decides it, and an execution
  // returned at once must also have run the reviewed call. Its receipt proves
  // its transaction exists, so with none read yet, a node that shows none is
  // only behind: the proposal stays held, and can end its confirm on Done.
  const atOnce = receipt.transactionHash.toLowerCase() === proposalHash.toLowerCase()
  const transaction =
    atOnce && !execution
      ? await chainAnswer(() => client.getTransaction({ hash: proposalHash }), {
          exists: true,
          onRetry: () => updateProposal(key, { phase: 'confirming' }),
        })
      : execution
  const { status } = await readSafeAppExecution({
    client: {
      getTransaction: async () => {
        if (!transaction) throw new Error(`The chain has no transaction ${proposalHash}.`)
        return transaction
      },
    },
    receipt,
    safe,
    proposalHash,
    calls: [call],
  }).catch(() => ({ status: 'unproven' as const }))
  updateProposal(
    key,
    status === 'success'
      ? { phase: 'success', receipt }
      : status === 'failed'
        ? { phase: 'failed', receipt, message: failed }
        : { ...unconfirmedProposal(key), receipt },
  )
}

/** Record a proposal and follow it; `reply` says whether the hash is the wallet's own answer. */
function recordProposal(
  proposal: Pick<SafeProposal, 'chainId' | 'safe' | 'call' | 'proposalHash'>,
  client: FollowClient,
  reply: boolean,
): string {
  const key = proposalKey(proposal.chainId, proposal.safe, proposal.call)
  proposals.set(key, {
    ...proposal,
    phase: reply ? 'checking' : 'awaiting',
    executionHash: null,
    receipt: null,
    message: null,
  })
  notifyProposals()
  startFollowingProposal(key, client, reply)
  return key
}

/**
 * The one transaction pipeline every project-page write flow uses
 * (website/ parity: exact review → simulate → send → status):
 *
 * 1. `send(request)` opens the global exact-payload review, then switches
 *    chains if needed and SIMULATES the approved call
 *    (nothing is ever sent that doesn't simulate clean), then requests the
 *    wallet signature and tracks the receipt.
 * 2. Phases drive the caller's UI; `error` carries a friendly message.
 */
export function useSafeTx(chainId: number) {
  const queryClient = useQueryClient()
  const invalidatedReceipt = useRef<string | null>(null)
  const { isConnected, isCenterWallet } = useWallet()
  const publicClient = usePublicClient({ chainId })
  const { writeContractAsync } = useWriteContract()
  const { switchChainAsync } = useSwitchChain()
  const isSafe = useSafeConnection(wagmiConfig)

  const [phase, setPhase] = useState<TxPhase>('idle')
  const [error, setError] = useState<string | null>(null)
  /** The transaction an ordinary send is waiting on. */
  const [hash, setHash] = useState<`0x${string}` | null>(null)
  /** The Safe proposal this flow shows, by its key in the registry. */
  const [shownKey, setShownKey] = useState<string | null>(null)
  const proposal = useSyncExternalStore(
    subscribeProposals,
    () => (shownKey ? proposals.get(shownKey) : undefined),
    () => undefined,
  )
  const inFlightRef = useRef(false)

  const receipt = useWaitForTransactionReceipt({
    hash: hash ?? undefined,
    chainId,
    // Bounded: a stalled watcher must surface as "confirmation unavailable",
    // never as a spinner that outlives the transaction it is watching.
    timeout: RECEIPT_WATCH_TIMEOUT_MS,
    query: { enabled: !!hash },
  })

  // The watcher subscribes to new blocks and can sit pending forever on some
  // wallet/RPC pairs even after the transaction mined (it stranded pay flows
  // at "Confirming onchain…" after a Permit2 approval). A plain receipt lookup
  // on an interval is the second source of truth; whichever answers first wins.
  const [polledReceipt, setPolledReceipt] = useState<PolledReceipt | null>(null)
  useEffect(() => {
    setPolledReceipt(null)
    if (!hash || !publicClient) return
    if (typeof publicClient.getTransactionReceipt !== 'function') return
    let cancelled = false
    let attempts = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    // Fast at first, then slowly for as long as the page is open: an unconfirmed
    // send stays locked, and this is what lifts the lock when its receipt lands.
    const poll = () => {
      attempts += 1
      void publicClient
        .getTransactionReceipt({ hash })
        .then(found => {
          if (cancelled) return
          if (found) setPolledReceipt(found)
          else schedule()
        })
        .catch(() => {
          if (!cancelled) schedule()
        })
    }
    const schedule = () => {
      timer = setTimeout(poll, attempts < RECEIPT_POLL_ATTEMPTS ? RECEIPT_POLL_INTERVAL_MS : RECEIPT_SLOW_POLL_INTERVAL_MS)
    }
    schedule()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [hash, publicClient])
  // React Query may retain the prior query's data while a new hash starts.
  // Only a receipt for this exact transaction can settle this action.
  const receiptData = hash
    ? [receipt.data, polledReceipt].find(
        candidate => candidate?.transactionHash?.toLowerCase() === hash.toLowerCase(),
      )
    : undefined

  // An ordinary send settles on its receipt's status alone. A receipt RPC
  // error leaves it pending/unknown, so the UI never invites a duplicate
  // submission merely because confirmation could not be read. A held write
  // that is tracking its hash settles the same way when its receipt lands.
  const tracking = phase === 'pending' || phase === 'unconfirmed'
  /** This flow already shows its own receipt: a hold that clears on it changes nothing here. */
  const receiptShownRef = useRef(false)
  receiptShownRef.current = !!receiptData
  const receiptReverted = tracking && receiptData?.status === 'reverted'
  // The receipt watch gave up on a transaction that has a hash. It may still
  // land, so its write stays held until its receipt proves it, but nothing is
  // in flight to hold a dialog open for.
  const watchGaveUp = !shownKey && phase === 'pending' && receipt.isError && !receiptData
  /** This flow's own pending hash, held and still followed: closing keeps it shown, so its receipt settles it here. */
  const followingHeldRef = useRef(false)

  /**
   * This flow's write as the SDK's write hold holds it, and the send its exit
   * repeats. The hold outlives this hook, the dialog and a reload; this is
   * only what this flow shows.
   */
  const [held, setHeld] = useState<HeldWrite | null>(null)
  const heldRef = useRef(held)
  const showHeld = useCallback((next: HeldWrite | null) => {
    heldRef.current = next
    setHeld(next)
  }, [])
  // A receipt for the held write's own hash is its result, whatever its
  // status. The hold releases a verified success at once, a revert at finality.
  useEffect(() => {
    const current = heldRef.current
    if (!current || !receiptData || !publicClient) return
    if (current.hold.peek().status === 'clear') return
    void current.hold.onReceipt(receiptData as TransactionReceipt, publicClient as never).catch(() => {})
  }, [receiptData, publicClient])
  /** Show what the hold says now; a cleared hold leaves this flow idle. */
  const showHoldState = useCallback((current: Omit<HeldWrite, 'state'>, state: WriteHeldState) => {
    showHeld({ ...current, state })
    // A hash still pending is followed here, so its receipt settles it.
    setHash(state.status === 'pending-known-hash' && !state.record.safe ? state.hash : null)
    setPhase('unconfirmed')
  }, [showHeld])
  /** The line a hold that ended on its own shows: never a send. */
  const [settledNotice, setSettledNotice] = useState<string | null>(null)
  const endHeld = useCallback((settled?: WriteHoldSettled) => {
    showHeld(null)
    setHash(null)
    inFlightRef.current = false
    setSettledNotice(settledLine(settled))
    setPhase('submitted')
  }, [showHeld])
  /** The hold whose exit the user accepted: its answer, not what it emits meanwhile, decides. */
  const exitingRef = useRef<WriteHoldHandle | null>(null)
  /** A result a look at the hold returned while the exit was in flight, kept for its line. */
  const exitSettledRef = useRef<WriteHoldSettled | undefined>(undefined)
  // The receipt watch gave up on this flow's own send: it enters the hold, so
  // the hold's line shows, its subscription attaches, and a time-based exit
  // can appear. Its hash is still followed for a receipt.
  useEffect(() => {
    const current = heldRef.current
    if (!watchGaveUp || !current || current.state) return
    const state = current.hold.peek()
    if (state.status === 'clear') return
    showHeld({ ...current, state })
    setPhase('unconfirmed')
  }, [watchGaveUp, showHeld])
  // While a hold is shown, another tab or the hold's own follow may change it.
  const shownHold = phase === 'unconfirmed' ? held?.hold : undefined
  useWriteHoldWatch(shownHold, publicClient as WriteHoldClient | undefined, state => {
    const current = heldRef.current
    if (!current || current.hold !== shownHold) return
    if (exitingRef.current === shownHold) {
      if (state.status === 'clear' && state.settled) exitSettledRef.current = state.settled
      return
    }
    if (state.status === 'clear') {
      if (!receiptShownRef.current) endHeld(state.settled)
    } else showHoldState(current, state)
  })

  // A Safe proposal's state is the registry's. Its confirm ends on Done while
  // the signers decide, and when its result can't be proven here; no send of
  // its action goes out until it ends, or the user dismisses an unproven
  // result after its line. One the registry no longer holds (dismissed in
  // another flow) shows nothing.
  const effectivePhase: TxPhase = shownKey
    ? proposal
      ? SHOWN_AS[proposal.phase]
      : 'idle'
    : tracking && receiptData?.status === 'success'
      ? 'success'
      : receiptReverted
        ? 'error'
        : watchGaveUp
          ? 'unconfirmed'
          : phase
  followingHeldRef.current = effectivePhase === 'unconfirmed' && !!hash && (watchGaveUp || held?.state?.status === 'pending-known-hash')
  const notice = settledNotice ?? (
    proposal?.phase === 'awaiting'
      ? (proposal.message ?? SAFE_PROPOSAL_AWAITING)
      : proposal?.phase === 'confirming'
        ? SAFE_EXECUTION_CONFIRMING
        : proposal?.phase === 'unproven' || proposal?.phase === 'ran'
          ? (proposal.message ?? SAFE_PROPOSAL_UNCONFIRMED)
          : null)
  const sendRef = useRef<(request: TxRequest, options: TxSendOptions) => Promise<Hex | null>>(async () => null)
  /** The send this flow last made, which a held Safe proposal's exit repeats. */
  const lastSendRef = useRef<{ request: TxRequest; options: TxSendOptions } | null>(null)
  // A Safe proposal this flow shows whose follower ended unproven: the hold's
  // line and exit replace the registry's notice.
  const unprovenKey = shownKey && proposal?.phase === 'unproven' ? shownKey : null
  useEffect(() => {
    const shown = unprovenKey ? proposals.get(unprovenKey) : undefined
    const last = lastSendRef.current
    if (!unprovenKey || !shown || !publicClient || !last) return
    let live = true
    const hold = safeHoldOf(shown, unprovenKey)
    void hold.onUnproven(publicClient as never, shown.proposalHash).then(state => {
      if (!live || state.status === 'clear') return
      setShownKey(null)
      showHoldState({ hold, ...last, proposalKey: unprovenKey }, state)
    }, () => {})
    return () => { live = false }
  }, [unprovenKey, publicClient, showHoldState])
  /**
   * The user checked their wallet: the hold asks the chain once more and
   * releases exactly the state the user saw, then the same send runs again,
   * only when the hold reports it released. A state that changed meanwhile
   * stays held, shown as it is now; one that ended meanwhile ends this
   * attempt with its result, and nothing is sent.
   */
  const exitHeld = useCallback(() => {
    const current = heldRef.current
    if (!current?.state?.exit || !publicClient) return
    exitingRef.current = current.hold
    exitSettledRef.current = undefined
    void current.hold.exit(current.state, { checkedWallet: true }, publicClient as never).finally(() => {
      if (exitingRef.current === current.hold) exitingRef.current = null
    }).then(
      ({ released, state }) => {
        // A hold this flow no longer shows (it ended meanwhile) is never sent again.
        if (heldRef.current?.hold !== current.hold) return
        if (released) {
          showHeld(null)
          setHash(null)
          setPhase('idle')
          inFlightRef.current = false
          if (current.proposalKey && proposals.delete(current.proposalKey)) notifyProposals()
          void sendRef.current(current.request, current.options)
        } else if (state.status === 'clear') endHeld(state.settled ?? exitSettledRef.current)
        else showHoldState(current, state)
      },
      () => {
        // Unreadable: the hold stays, as last shown.
      },
    )
  }, [endHeld, publicClient, showHeld, showHoldState])
  const shownState = held?.state ?? (effectivePhase === 'unconfirmed' && held ? held.hold.peek() : null)
  const effectiveError: string | ReactElement | null = shownKey
    ? proposal && SHOWN_AS[proposal.phase] === 'error'
      ? proposal.message
      : null
    : receiptReverted
      ? `Transaction reverted onchain${hash ? ` (${hash})` : ''}.`
      : effectivePhase === 'unconfirmed'
        ? shownState && shownState.status !== 'clear'
          ? createElement(WriteHeldNotice, {
              chainId: shownState.record.chainId,
              state: shownState,
              onExit: shownState.exit ? exitHeld : undefined,
            })
          : WRITE_HOLD_PENDING_LINE
        : error
  const awaitingProposal =
    proposal?.phase === 'checking' || proposal?.phase === 'awaiting' ? proposal.proposalHash : null

  useEffect(() => {
    if (effectivePhase === 'success' || effectivePhase === 'error') {
      inFlightRef.current = false
    }
  }, [effectivePhase])

  const confirmedChainId = proposal?.chainId ?? chainId
  const confirmedHash = proposal?.executionHash ?? receiptData?.transactionHash
  useEffect(() => {
    if (effectivePhase !== 'success' || !confirmedHash) return
    const identity = `${confirmedChainId}:${confirmedHash}`
    if (invalidatedReceipt.current === identity) return
    invalidatedReceipt.current = identity
    void invalidateProjectDisplayQueries(queryClient, confirmedChainId)
  }, [confirmedChainId, confirmedHash, effectivePhase, queryClient])

  const send = useCallback(
    async (
      request: TxRequest,
      options: TxSendOptions,
    ) => {
      if (inFlightRef.current) return null
      if (isCenterWallet) {
        setError('This action needs an external wallet. Juicebox wallet payments use their own payment review.')
        setPhase('error')
        return null
      }
      if (getViewAs()) {
        setError(VIEW_AS_WRITE_BLOCKED)
        setPhase('error')
        return null
      }
      if (!isConnected || !publicClient) {
        setError('Connect a wallet first.')
        setPhase('error')
        return null
      }
      inFlightRef.current = true
      lastSendRef.current = { request, options }
      setError(null)
      setHash(null)
      setShownKey(null)
      setPolledReceipt(null)
      setSettledNotice(null)
      showHeld(null)
      // Read once: the review, the sent gas and the proposal tracking must all
      // agree on whether a Safe proposes this call.
      const viaSafe = isSafeConnection(wagmiConfig)
      const account = options.reviewedAccount
      const assertOriginalWallet = captureWalletContext(wagmiConfig, { account, chainId: request.chainId })
      let hold: WriteHoldHandle | undefined
      /** A Safe proposal's registry key, which an accepted exit clears. */
      let safeKey: string | undefined
      /** The wallet may have been opened: whatever the send throws, the hold is asked. */
      let reachedWallet = false
      try {
        /** The exact call simulated and sent, which a Safe execution must run. */
        let sentCall = callOf(request)
        // Every write is held by the SDK's write hold from just before the
        // wallet opens until it is proven, across closing and reloads: an
        // ordinary one by its exact call, a Safe proposal by its held call.
        // A Safe proposal this session follows is also shown by the registry.
        const key = proposalKey(request.chainId, account, sentCall)
        if (viaSafe) safeKey = key
        if (!options.journaled) {
          hold = viaSafe
            ? safeHoldOf({ chainId: request.chainId, safe: account, call: sentCall }, key)
            : writeHolds.open({ chainId: request.chainId, account, safe: false, call: sentCall })
        }
        {
          if (viaSafe) {
            // An action the Safe already has, from this session or its own queue,
            // is shown as it is and never proposed again.
            let held = proposals.get(key)
            if (held?.phase === 'unproven' && options.heldBy && options.heldBy.hold.peek().status === 'clear') {
              // The app journal's hold was released by the user: propose afresh.
              proposals.delete(key)
              notifyProposals()
              held = undefined
            }
            let queued: Awaited<ReturnType<typeof findPendingSafeAppProposal>> = null
            if (!holdsCall(held) && hasSafeService(request.chainId)) {
              // Reading Safe's queue takes a moment: the flow shows it checking.
              setPhase('simulating')
              queued = await findPendingSafeAppProposal(publicClient, request.chainId, account, sentCall)
            }
            if (held?.phase === 'unproven' && !options.heldBy) {
              // Unproven here: the hold decides, with its line and exit.
              const hold = safeHoldOf(held, key)
              const state = await hold.onUnproven(publicClient as never, held.proposalHash).catch(() => hold.peek())
              if (state.status !== 'clear') {
                inFlightRef.current = false
                showHoldState({ hold, request, options, proposalKey: key }, state)
                return null
              }
            }
            if (queued && !options.heldBy) {
              // An adopted proposal is saved in its write hold, as a sent one is,
              // so its end, a dismissal or a reload never let it be proposed again
              // without the user's exit.
              const adopt = safeHoldOf({ chainId: request.chainId, safe: account, call: sentCall }, key)
              const adopted = queued
              try {
                await adopt.send(publicClient as never, async gate => {
                  await gate.beforeSend(adopted.call)
                  gate.afterSubmit(adopted.proposalHash, adopted.tx)
                })
              } catch (error) {
                // Already held: the same proposal follows as before; another is shown as held.
                if (!(error instanceof WriteHeldError) || error.state.record.hash !== adopted.proposalHash.toLowerCase()) {
                  inFlightRef.current = false
                  if (error instanceof WriteHeldError) {
                    showHoldState({ hold: adopt, request, options, proposalKey: key }, error.state)
                    return null
                  }
                  throw error
                }
              }
            }
            if (holdsCall(held) || queued) {
              registerExternalHold(key, options.heldBy, publicClient)
              if (queued) {
                const { proposalHash, call } = queued
                recordProposal({ chainId: request.chainId, safe: account, call, proposalHash }, publicClient, false)
              } else if (held?.phase === 'awaiting' || held?.phase === 'ran') {
                // Awaiting, or ran with its execution unread: look again, never propose again.
                startFollowingProposal(key, publicClient, false)
              }
              inFlightRef.current = false
              setShownKey(key)
              return proposals.get(key)!.proposalHash
            }
          }
          const submit = (gate?: WriteHoldGate) => submitReviewedContractWrite({
            request,
            expectedAccount: account,
            review: async reviewed => {
              // A review notice always opens the review, even where the caller
              // already rendered the payload — the notice exists precisely
              // because what was rendered is no longer what will be signed.
              if (options.reviewedInParent && !options.reviewNotice) return
              const description = [
                options.reviewNotice,
                viaSafe ? SAFE_NONCE_GUIDANCE : null,
                writeHolds.reviewLine(),
              ]
                .filter(Boolean)
                .join('\n\n')
              const approved = await requestContractTransactionReview(
                {
                  ...reviewed,
                  account,
                  // A Safe app signs the sent gas as safeTxGas; 0 makes a failed call revert.
                  ...(viaSafe ? { safeTxGas: 0n } : {}),
                },
                {
                  label: reviewed.label,
                  ...(description ? { description } : {}),
                  ...(viaSafe
                    ? { confirmLabel: 'Agree & continue to Safe' }
                    : {}),
                },
              )
              if (!approved) throw new TransactionReviewCancelledError()
            },
            switchChain: async reviewedChainId => {
              if (getAccount(wagmiConfig).chainId === reviewedChainId) return
              await switchChainAsync({ chainId: reviewedChainId }).catch(() => {
                throw new Error(`Switch your wallet to ${chainName(reviewedChainId)} to continue.`)
              })
            },
            currentAccount: () => getAccount(wagmiConfig).address,
            reverify: options.reverify,
            beforeWrite: gate || options.beforeWrite
              ? async () => {
                  await gate?.beforeSend()
                  reachedWallet = !!gate
                  try {
                    await options.beforeWrite?.()
                  } catch (error) {
                    gate?.onRejected()
                    throw error
                  }
                }
              : undefined,
            onBeforeWriteAborted: async () => {
              gate?.onRejected()
              if (options.beforeWrite) await options.onBeforeWriteAborted?.()
            },
            onWriteRejected: async () => {
              gate?.onRejected()
              await options.onWriteRejected?.()
            },
            onWriteSubmitted: gate ? (submittedHash: Hex) => gate.afterSubmit(submittedHash) : undefined,
            // Simulation is the safety gate: the exact reviewed call, args, and
            // value must succeed before a signature is requested. Only the
            // simulation result reaches the wallet writer.
            simulate: async reviewed => {
              sentCall = callOf(reviewed)
              const simulationRequest = {
                address: reviewed.address,
                abi: reviewed.abi,
                functionName: reviewed.functionName,
                args: reviewed.args as unknown[],
                value: reviewed.value,
                account,
                ...(options.simulationBlockNumber !== undefined
                  ? { blockNumber: options.simulationBlockNumber }
                  : {}),
              }
              const [{ request: simulated }, estimate] = await Promise.all([
                publicClient.simulateContract(simulationRequest),
                publicClient.estimateContractGas(simulationRequest),
              ])
              return {
                ...simulated,
                chainId: reviewed.chainId,
                gas: viaSafe ? 0n : gasWithHeadroom(estimate),
              }
            },
            beforeSend: () => {
              assertOriginalWallet()
              if (isSafeConnection(wagmiConfig) !== viaSafe) {
                throw new Error('Wallet connection changed. Review the transaction again.')
              }
              options.assertWriteState?.()
            },
            write: simulated => writeContractAsync(simulated),
            onPhase: setPhase,
          })
          const txHash = hold ? await hold.send(publicClient as never, submit) : await submit()
          if (hold) showHeld({ hold, request, options, state: null })
          if (viaSafe) {
            // A reply that is not a 32-byte hash names no proposal and no execution.
            if (!isHash(txHash)) throw new Error(SAFE_REPLY_UNREADABLE)
            // The registry holds the call from here; this flow only shows it.
            inFlightRef.current = false
            registerExternalHold(key, options.heldBy, publicClient)
            setShownKey(
              recordProposal(
                { chainId: request.chainId, safe: account, call: sentCall, proposalHash: txHash },
                publicClient,
                true,
              ),
            )
          } else {
            setHash(txHash)
          }
          setPhase('pending')
          return txHash
        }
      } catch (e) {
        inFlightRef.current = false
        if (!viaSafe && e instanceof SubmittedContractWriteError && typeof e.hash === 'string' && isHash(e.hash)) {
          // The wallet returned its hash and the write stays held: follow it.
          setHash(e.hash)
          setPhase('pending')
          return e.hash
        }
        if (hold && e instanceof WriteHeldError) {
          // Held already: what the hold says, its line and its exit.
          showHoldState({ hold, request, options, ...(safeKey ? { proposalKey: safeKey } : {}) }, e.state)
          return null
        }
        if (hold && reachedWallet && !(e instanceof WriteHoldBusyError || e instanceof WriteHoldNonceError)) {
          // The wallet may have sent it without saying so: its hold is shown, as the chain says.
          const now = await hold.state(publicClient as never).catch(() => hold!.peek())
          if (now.status !== 'clear') {
            showHoldState({ hold, request, options }, now)
            return null
          }
        }
        if (e instanceof TransactionReviewCancelledError) {
          setPhase('idle')
          return null
        }
        setError(friendlyTxError(e))
        setPhase('error')
        return null
      }
    },
    [isConnected, isCenterWallet, publicClient, showHeld, showHoldState, switchChainAsync, writeContractAsync],
  )
  sendRef.current = send

  /**
   * Clear this flow's state, as a new review opens. A Safe proposal stays in
   * the registry: still followed while pending, and still held when unproven,
   * since the user may not have seen its line.
   */
  const reset = useCallback(() => {
    // A held send whose hash is still followed stays shown, so its receipt
    // still settles it here. Its hold outlives the dialog either way.
    if (followingHeldRef.current) return
    inFlightRef.current = false
    setPhase('idle')
    setError(null)
    setHash(null)
    setShownKey(null)
    setSettledNotice(null)
    showHeld(null)
  }, [showHeld])

  /**
   * The user closed the confirm after its line. An unproven Safe result is
   * released: its call is the user's to send again. A pending proposal stays
   * followed and held.
   */
  const dismiss = useCallback(() => {
    if (followingHeldRef.current) return
    if (shownKey && proposals.get(shownKey)?.phase === 'unproven') {
      proposals.delete(shownKey)
      notifyProposals()
    }
    reset()
  }, [reset, shownKey])

  return {
    phase: effectivePhase,
    /** True while the transaction is in flight: simulating/signing/pending. Not once its confirmation could not be read. */
    busy:
      effectivePhase === 'simulating' ||
      effectivePhase === 'signing' ||
      effectivePhase === 'pending',
    /** The confirm can end on Done: the transaction succeeded, it is with a Safe, or its confirmation could not be read. */
    settled: effectivePhase === 'success' || effectivePhase === 'submitted' || effectivePhase === 'unconfirmed',
    /** The one line a `submitted` confirm shows. */
    notice,
    /** Whether the connected writer is a Safe connector. */
    isSafe,
    error: effectiveError,
    hash: shownKey ? (proposal?.executionHash ?? null) : (hash ?? held?.state?.record.hash ?? null),
    safeProposalHash: awaitingProposal,
    safeNonceGuidance: awaitingProposal ? SAFE_NONCE_GUIDANCE : null,
    receipt: shownKey ? (proposal?.receipt ?? null) : (receiptData ?? null),
    /** The transaction has a hash, but its result could not be confirmed here. */
    confirmationUncertain: shownKey
      ? proposal?.phase === 'unproven' || (proposal?.phase === 'awaiting' && !!proposal.message)
      : effectivePhase === 'unconfirmed',
    send,
    reset,
    dismiss,
  }
}
