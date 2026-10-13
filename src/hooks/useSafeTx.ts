'use client'

import { createElement, useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactElement } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { invalidateProjectDisplayQueries } from '@/lib/project-display-cache'
import { getAccount } from '@wagmi/core'
import { WriteHeldNotice } from '@/components/ui/WriteHeldNotice'
import { openWriteRecovery, writeNonceEvidence, type WriteRecovery } from '@/lib/write-recovery'
import {
  BaseError,
  encodeFunctionData,
  isHash,
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
import { submitReviewedContractWrite } from '@/lib/contract-write'
import { captureWalletContext } from '@/lib/wallet-context'
import {
  gasWithHeadroom,
  SubmittedContractWriteError,
  SubmittedWritePersistenceError,
  waitForTrackedReceipt,
  writeHeldMessage,
  type ReviewedWriteRecoveryRecord,
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
  /** The Safe's nonce moved past it without running it. */
  | 'replaced'

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
}

const SAFE_EXECUTION_CONFIRMING = 'Executed by your Safe. Confirming it onchain.'
/** What a Safe app replied in place of a proposal or execution hash. */
const SAFE_REPLY_UNREADABLE = 'Safe did not return a proposal hash. Check Safe before sending this again.'
const SAFE_PROPOSAL_EXPIRED = "This Safe proposal's deadline passed. Review it again."
const SAFE_PROPOSAL_REPLACED = 'Safe moved past this proposal without running it. Review it again.'
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

/** An ordinary write the SDK's write recovery holds, and the send its exit repeats. */
type HeldWrite = {
  journal: WriteRecovery
  record: ReviewedWriteRecoveryRecord
  request: TxRequest
  options: TxSendOptions
}

/** Save the wallet's hash; a failed save keeps it in memory, and the write stays held either way. */
function recordSubmission(journal: WriteRecovery, hash: Hex): ReviewedWriteRecoveryRecord {
  try {
    return journal.submitted(hash)
  } catch (error) {
    if (!(error instanceof SubmittedWritePersistenceError)) throw error
    return error.record
  }
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
    .finally(() => followingProposals.delete(key))
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
 * deadline passes before the Safe ran it, or when the Safe's nonce moves past
 * it ({@link watchSafeProposal}). Whichever answers first stops the other.
 */
async function awaitExecution(
  { chainId, safe, proposalHash }: SafeProposal,
  client: FollowClient,
): Promise<Outcome> {
  const stop = new AbortController()
  const executed = waitForSafeExecutionHash(chainId, proposalHash, { client, signal: stop.signal }).then(
    (executionHash): Outcome => ({ executionHash }),
    async (reason: unknown): Promise<Outcome> => {
      // Safe's service says it ran and failed: the execution its record names decides.
      const reported = await reportedSafeExecution(reason, chainId, safe, proposalHash)
      return reported
        ? { executionHash: reported }
        : { phase: 'unproven', message: `${SAFE_PROPOSAL_UNCONFIRMED} ${friendlyTxError(reason)}` }
    },
  )
  const ended = hasSafeService(chainId)
    ? watchSafeProposal(client, chainId, safe, proposalHash, stop.signal).then(
        (end): Outcome =>
          end === 'expired'
            ? { phase: 'expired', message: SAFE_PROPOSAL_EXPIRED }
            : { phase: 'replaced', message: SAFE_PROPOSAL_REPLACED },
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
    updateProposal(key, { phase: 'awaiting' })
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
  const receiptReverted = tracking && receiptData?.status === 'reverted'
  // The receipt watch gave up on a transaction that has a hash. It may still
  // land, so its write stays held until its receipt proves it, but nothing is
  // in flight to hold a dialog open for.
  const watchGaveUp = !shownKey && phase === 'pending' && receipt.isError && !receiptData
  const watchGaveUpRef = useRef(false)
  watchGaveUpRef.current = watchGaveUp

  /**
   * This flow's ordinary write as the SDK's write recovery holds it, from the
   * moment before the wallet opens until its receipt, the chain or the user's
   * exit ends it, and the send its exit repeats. The record outlives this
   * hook, the dialog and a reload; this is only what this flow shows.
   */
  const [held, setHeld] = useState<HeldWrite | null>(null)
  const heldRef = useRef(held)
  const showHeld = useCallback((next: HeldWrite | null) => {
    heldRef.current = next
    setHeld(next)
  }, [])
  // A receipt for the held write's own hash proves it was sent, whatever its
  // status: the hold ends and the receipt is the result.
  useEffect(() => {
    const current = heldRef.current
    if (!current || !receiptData || current.record.hash?.toLowerCase() !== receiptData.transactionHash.toLowerCase()) return
    showHeld(null)
    void current.journal.withLock(async () => {
      const saved = current.journal.read()
      if (saved?.id !== current.record.id) return
      // A hash kept only in memory after a failed save is committed before it is cleared.
      current.journal.clear(saved.hash ? current.journal.submitted(saved.hash, saved) : saved)
    }, true).catch(() => {
      // Storage refused: the next send of this call checks the chain again.
    })
  }, [receiptData, showHeld])

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
  const notice =
    proposal?.phase === 'awaiting'
      ? (proposal.message ?? SAFE_PROPOSAL_AWAITING)
      : proposal?.phase === 'confirming'
        ? SAFE_EXECUTION_CONFIRMING
        : proposal?.phase === 'unproven'
          ? (proposal.message ?? SAFE_PROPOSAL_UNCONFIRMED)
          : null
  const sendRef = useRef<(request: TxRequest, options: TxSendOptions) => Promise<Hex | null>>(async () => null)
  /** The user checked their wallet: the hold ends and the same send runs again. */
  const exitHeld = useCallback(() => {
    const current = heldRef.current
    if (!current) return
    try {
      const latest = current.journal.read()
      // Only this write's own record, possibly updated since it was shown.
      if (latest?.id === current.record.id) current.journal.abandon(latest, { checkedWallet: true })
    } catch (e) {
      setError(friendlyTxError(e))
      setPhase('error')
      return
    }
    showHeld(null)
    setHash(null)
    setPhase('idle')
    inFlightRef.current = false
    void sendRef.current(current.request, current.options)
  }, [showHeld])
  const effectiveError: string | ReactElement | null = shownKey
    ? proposal && SHOWN_AS[proposal.phase] === 'error'
      ? proposal.message
      : null
    : receiptReverted
      ? `Transaction reverted onchain${hash ? ` (${hash})` : ''}.`
      : effectivePhase === 'unconfirmed'
        ? held
          ? createElement(WriteHeldNotice, {
              chainId: held.record.chainId,
              hash: held.record.hash ?? hash,
              value: held.record.call.value,
              onExit: exitHeld,
            })
          : writeHeldMessage()
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
      setError(null)
      setHash(null)
      setShownKey(null)
      setPolledReceipt(null)
      showHeld(null)
      // Read once: the review, the sent gas and the proposal tracking must all
      // agree on whether a Safe proposes this call.
      const viaSafe = isSafeConnection(wagmiConfig)
      const account = options.reviewedAccount
      const assertOriginalWallet = captureWalletContext(wagmiConfig, { account, chainId: request.chainId })
      let journal: WriteRecovery | undefined
      /** This attempt's own record, from just before the wallet opened. */
      let reserved: ReviewedWriteRecoveryRecord | undefined
      /** Nothing reached the wallet, or it refused: this attempt's hold ends. */
      const release = () => {
        if (!journal || !reserved) return
        journal.rejected()
        reserved = undefined
        showHeld(null)
      }
      try {
        /** The exact call simulated and sent, which a Safe execution must run. */
        let sentCall = callOf(request)
        // An ordinary write is held by its exact call from just before the
        // wallet opens until it is proven, across closing and reloads. A Safe
        // proposal is held by the registry below and by Safe's own queue.
        if (!viaSafe && !options.journaled) {
          journal = openWriteRecovery({ chainId: request.chainId, account, safe: false, call: sentCall })
        }
        const execute = async (): Promise<Hex | null> => {
          if (journal?.read()) {
            // An earlier write of this exact call has no confirmed result. The
            // chain may prove it now: its receipt, or the exact call at its nonce.
            setPhase('simulating')
            const check = await journal.resolve(publicClient).catch(() => null)
            const saved = journal.read()
            if (saved) {
              inFlightRef.current = false
              showHeld({ journal, record: saved, request, options })
              setHash(check?.status === 'sent' ? check.hash : (saved.hash ?? null))
              setPhase(check?.status === 'sent' ? 'pending' : 'unconfirmed')
              return null
            }
          }
          if (viaSafe) {
            // An action the Safe already has, from this session or its own queue,
            // is shown as it is and never proposed again.
            const key = proposalKey(request.chainId, account, sentCall)
            const held = proposals.get(key)
            let queued: Awaited<ReturnType<typeof findPendingSafeAppProposal>> = null
            if (!holdsCall(held) && hasSafeService(request.chainId)) {
              // Reading Safe's queue takes a moment: the flow shows it checking.
              setPhase('simulating')
              queued = await findPendingSafeAppProposal(publicClient, request.chainId, account, sentCall)
            }
            if (holdsCall(held) || queued) {
              if (queued) {
                const { proposalHash, call } = queued
                recordProposal({ chainId: request.chainId, safe: account, call, proposalHash }, publicClient, false)
              } else if (held?.phase === 'awaiting') {
                startFollowingProposal(key, publicClient, false)
              }
              inFlightRef.current = false
              setShownKey(key)
              return proposals.get(key)!.proposalHash
            }
          }
          const txHash = await submitReviewedContractWrite({
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
            beforeWrite: journal || options.beforeWrite
              ? async () => {
                  if (journal) {
                    const evidence = await writeNonceEvidence(publicClient, account)
                    reserved = journal.reserve(undefined, evidence)
                    showHeld({ journal, record: reserved, request, options })
                  }
                  try {
                    await options.beforeWrite?.()
                  } catch (error) {
                    release()
                    throw error
                  }
                }
              : undefined,
            onBeforeWriteAborted: async () => {
              release()
              if (options.beforeWrite) await options.onBeforeWriteAborted?.()
            },
            onWriteRejected: async () => {
              release()
              await options.onWriteRejected?.()
            },
            onWriteSubmitted: journal
              ? (submittedHash: Hex) => {
                  const record = recordSubmission(journal!, submittedHash)
                  reserved = record
                  showHeld({ journal: journal!, record, request, options })
                }
              : undefined,
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
          if (viaSafe) {
            // A reply that is not a 32-byte hash names no proposal and no execution.
            if (!isHash(txHash)) throw new Error(SAFE_REPLY_UNREADABLE)
            // The registry holds the call from here; this flow only shows it.
            inFlightRef.current = false
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
        return journal ? await journal.withLock(execute) : await execute()
      } catch (e) {
        inFlightRef.current = false
        if (!viaSafe && e instanceof SubmittedContractWriteError && typeof e.hash === 'string' && isHash(e.hash)) {
          // The wallet returned its hash and the write stays held: follow it.
          setHash(e.hash)
          setPhase('pending')
          return e.hash
        }
        try {
          // The wallet may have sent it without saying so: its hold is shown, with the exit.
          const saved = reserved && journal?.read()
          if (journal && saved && saved.id === reserved!.id) {
            showHeld({ journal, record: saved, request, options })
            setHash(saved.hash ?? null)
            setPhase('unconfirmed')
            return null
          }
        } catch {
          // An unreadable record falls through to the error itself.
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
    [isConnected, isCenterWallet, publicClient, showHeld, switchChainAsync, writeContractAsync],
  )
  sendRef.current = send

  /**
   * Clear this flow's state, as a new review opens. A Safe proposal stays in
   * the registry: still followed while pending, and still held when unproven,
   * since the user may not have seen its line.
   */
  const reset = useCallback(() => {
    // A send whose receipt watch gave up stays shown and followed, so its
    // receipt still settles it here. Its hold outlives the dialog either way.
    if (watchGaveUpRef.current) return
    inFlightRef.current = false
    setPhase('idle')
    setError(null)
    setHash(null)
    setShownKey(null)
    showHeld(null)
  }, [showHeld])

  /**
   * The user closed the confirm after its line. An unproven Safe result is
   * released: its call is the user's to send again. A pending proposal stays
   * followed and held.
   */
  const dismiss = useCallback(() => {
    if (watchGaveUpRef.current) return
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
    hash: shownKey ? (proposal?.executionHash ?? null) : (hash ?? held?.record.hash ?? null),
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
