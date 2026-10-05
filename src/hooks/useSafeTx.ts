'use client'

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { getAccount } from '@wagmi/core'
import {
  BaseError,
  encodeFunctionData,
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
import { gasWithHeadroom, waitForTrackedReceipt } from '@bananapus/nana-sdk-core/review'
import { canonicalSafeTxHash, hasSafeService } from '@bananapus/nana-sdk-core/safe-service'
import { getViewAs, VIEW_AS_WRITE_BLOCKED } from '@/lib/viewAs'
import {
  requestContractTransactionReview,
  TransactionReviewCancelledError,
} from '@/lib/transaction-review'
import { chainName } from '@/lib/urn'
import { wagmiConfig } from '@/providers/Providers'
import {
  findPendingSafeAppProposal,
  isSafeConnection,
  readSafeAppExecution,
  SAFE_NONCE_GUIDANCE,
  SAFE_PROPOSAL_AWAITING,
  SAFE_PROPOSAL_UNCONFIRMED,
  useSafeConnection,
  waitForSafeExecutionHash,
  type SafeAppCall,
} from '@/lib/safe-connector'

/** How long the block-subscription watcher gets before its silence is reported. */
const RECEIPT_WATCH_TIMEOUT_MS = 120_000
const RECEIPT_POLL_INTERVAL_MS = 4_000
/** ~10 minutes of direct lookups, matching the watcher's own retry horizon. */
const RECEIPT_POLL_ATTEMPTS = 150

type PolledReceipt = NonNullable<
  Awaited<ReturnType<NonNullable<ReturnType<typeof usePublicClient>>['getTransactionReceipt']>>
>

export type TxPhase =
  | 'idle'
  | 'review'
  | 'simulating'
  | 'signing'
  | 'pending'
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
  /** Called if the final account gate aborts a persisted intent before the wallet write. */
  onBeforeWriteAborted?: () => unknown | Promise<unknown>
  /** Called only for a typed, explicit wallet rejection of the write itself. */
  onWriteRejected?: () => unknown | Promise<unknown>
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
  | 'success'
  | 'failed'
  /** Over, but this app can't prove it ran: held until the user dismisses it. */
  | 'unproven'

type SafeProposal = {
  chainId: number
  safe: Address
  call: SafeAppCall
  /** The safeTxHash, or the execution's own hash when Safe{Wallet} executed at once. */
  proposalHash: Hex
  phase: ProposalPhase
  executionHash: Hex | null
  receipt: TransactionReceipt | null
  /** The line for a failed or unproven result. */
  message: string | null
}

/**
 * Every Safe proposal made here this session, by chain, Safe and exact call.
 * Every useSafeTx shares it and the registry follows each proposal itself, so
 * a flow that closes, remounts or changes chain never drops one, and the same
 * call is never proposed twice while one is pending. Nothing is persisted: a
 * reload starts empty, and Safe's own queue answers for what it holds.
 */
const proposals = new Map<string, SafeProposal>()
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
  return `${chainId}:${safe.toLowerCase()}:${call.to.toLowerCase()}:${call.value ?? 0n}:${call.data.toLowerCase()}`
}

function updateProposal(key: string, next: Partial<SafeProposal>): void {
  const current = proposals.get(key)
  if (!current) return
  proposals.set(key, { ...current, ...next })
  notifyProposals()
}

/** A proposal holds its call until its result: while pending, and when unproven until dismissed. */
function holdsCall(proposal: SafeProposal | undefined): proposal is SafeProposal {
  return !!proposal && proposal.phase !== 'success' && proposal.phase !== 'failed'
}

/** Follow a proposal to its result, whatever becomes of the flow that made it. */
async function followProposal(key: string, client: FollowClient, reply: boolean): Promise<void> {
  const proposal = proposals.get(key)
  if (!proposal) return
  const { chainId, safe, call, proposalHash } = proposal
  // A reply the chain already knows as a transaction is the execution itself.
  let executionHash =
    reply &&
    (await Promise.resolve()
      .then(() => client.getTransaction({ hash: proposalHash }))
      .then(
        () => true,
        () => false,
      ))
      ? proposalHash
      : null
  if (!executionHash) {
    updateProposal(key, { phase: 'awaiting' })
    try {
      executionHash = await waitForSafeExecutionHash(chainId, proposalHash, { client })
    } catch (reason) {
      const message = friendlyTxError(reason)
      updateProposal(
        key,
        /executed the proposal.*failed/i.test(message)
          ? { phase: 'failed', message }
          : { phase: 'unproven', message: `${SAFE_PROPOSAL_UNCONFIRMED} ${message}` },
      )
      return
    }
  }
  updateProposal(key, { phase: 'executing', executionHash })
  const failed = `Safe executed the proposal, but the onchain transaction failed (${executionHash}).`
  let receipt: TransactionReceipt
  try {
    receipt = await waitForTrackedReceipt(client, executionHash)
  } catch {
    updateProposal(key, { phase: 'unproven', message: SAFE_PROPOSAL_UNCONFIRMED })
    return
  }
  // Only the Safe's own event for this proposal decides it, and an execution
  // returned at once must also have run the reviewed call.
  const { status } =
    receipt.status === 'success'
      ? await readSafeAppExecution({ client, receipt, safe, proposalHash, calls: [call] }).catch(
          () => ({ status: 'unproven' as const }),
        )
      : { status: 'reverted' as const }
  updateProposal(
    key,
    status === 'success'
      ? { phase: 'success', receipt }
      : status === 'unproven'
        ? { phase: 'unproven', receipt, message: SAFE_PROPOSAL_UNCONFIRMED }
        : { phase: 'failed', receipt, message: failed },
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
  // A follow that fails in any other way leaves the proposal unproven, never stuck.
  void followProposal(key, client, reply).catch(() =>
    updateProposal(key, { phase: 'unproven', message: SAFE_PROPOSAL_UNCONFIRMED }),
  )
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
    const timer = setInterval(() => {
      attempts += 1
      if (attempts > RECEIPT_POLL_ATTEMPTS) {
        clearInterval(timer)
        return
      }
      void publicClient
        .getTransactionReceipt({ hash })
        .then(found => {
          if (cancelled || !found) return
          clearInterval(timer)
          setPolledReceipt(found)
        })
        .catch(() => undefined)
    }, RECEIPT_POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
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
  // submission merely because confirmation could not be read.
  const receiptReverted = phase === 'pending' && receiptData?.status === 'reverted'
  // A Safe proposal's state is the registry's. Its confirm ends on Done while
  // the signers decide, and when its result can't be proven here; no send of
  // its call goes out until the Safe settles it, or the user dismisses an
  // unproven result after its line.
  const effectivePhase: TxPhase = proposal
    ? proposal.phase === 'checking' || proposal.phase === 'executing'
      ? 'pending'
      : proposal.phase === 'awaiting' || proposal.phase === 'unproven'
        ? 'submitted'
        : proposal.phase === 'success'
          ? 'success'
          : 'error'
    : phase === 'pending' && receiptData?.status === 'success'
      ? 'success'
      : receiptReverted
        ? 'error'
        : phase
  const notice =
    proposal?.phase === 'awaiting'
      ? SAFE_PROPOSAL_AWAITING
      : proposal?.phase === 'unproven'
        ? (proposal.message ?? SAFE_PROPOSAL_UNCONFIRMED)
        : null
  const effectiveError = proposal
    ? proposal.phase === 'failed'
      ? proposal.message
      : null
    : receiptReverted
      ? `Transaction reverted onchain${hash ? ` (${hash})` : ''}.`
      : phase === 'pending' && receipt.isError && !receiptData
        ? `Transaction${hash ? ` ${hash}` : ''} was submitted, but confirmation is temporarily unavailable. Check the explorer and do not submit it again yet.`
        : error
  const awaitingProposal =
    proposal?.phase === 'checking' || proposal?.phase === 'awaiting' ? proposal.proposalHash : null

  useEffect(() => {
    if (effectivePhase === 'success' || effectivePhase === 'error') {
      inFlightRef.current = false
    }
  }, [effectivePhase])

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
      // Read once: the review, the sent gas and the proposal tracking must all
      // agree on whether a Safe proposes this call.
      const viaSafe = isSafeConnection(wagmiConfig)
      const account = options.reviewedAccount
      try {
        /** The exact call simulated and sent, which a Safe execution must run. */
        let sentCall = callOf(request)
        if (viaSafe) {
          // A call the Safe already has, from this session or its own queue, is
          // shown as it is and never proposed again.
          const key = proposalKey(request.chainId, account, sentCall)
          const held = proposals.get(key)
          const queued =
            !holdsCall(held) && hasSafeService(request.chainId)
              ? await findPendingSafeAppProposal(publicClient, request.chainId, account, sentCall)
              : null
          if (holdsCall(held) || queued) {
            if (queued) {
              recordProposal(
                {
                  chainId: request.chainId,
                  safe: account,
                  call: sentCall,
                  proposalHash: canonicalSafeTxHash(request.chainId, account, queued),
                },
                publicClient,
                false,
              )
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
          beforeWrite: options.beforeWrite,
          onBeforeWriteAborted: options.onBeforeWriteAborted,
          onWriteRejected: options.onWriteRejected,
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
              gas: viaSafe ? 0n : gasWithHeadroom(estimate),
            }
          },
          write: async simulated => {
            // A WalletConnect peer read can land mid-flow and change the answer.
            if (isSafeConnection(wagmiConfig) !== viaSafe) {
              // Nothing reaches the wallet, so a marker written for this write is withdrawn.
              if (options.beforeWrite) await options.onBeforeWriteAborted?.()
              throw new Error('Wallet connection changed. Review the transaction again.')
            }
            return writeContractAsync(simulated)
          },
          onPhase: setPhase,
        })
        if (viaSafe) {
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
      } catch (e) {
        inFlightRef.current = false
        if (e instanceof TransactionReviewCancelledError) {
          setPhase('idle')
          return null
        }
        setError(friendlyTxError(e))
        setPhase('error')
        return null
      }
    },
    [isConnected, isCenterWallet, publicClient, switchChainAsync, writeContractAsync],
  )

  /**
   * Clear this flow's state, as a new review opens. A Safe proposal stays in
   * the registry: still followed while pending, and still held when unproven,
   * since the user may not have seen its line.
   */
  const reset = useCallback(() => {
    inFlightRef.current = false
    setPhase('idle')
    setError(null)
    setHash(null)
    setShownKey(null)
  }, [])

  /**
   * The user closed the confirm after its line. An unproven Safe result is
   * released: its call is the user's to send again. A pending proposal stays
   * followed and held.
   */
  const dismiss = useCallback(() => {
    if (shownKey && proposals.get(shownKey)?.phase === 'unproven') {
      proposals.delete(shownKey)
      notifyProposals()
    }
    reset()
  }, [reset, shownKey])

  return {
    phase: effectivePhase,
    /** True while the transaction is in flight: simulating/signing/pending. */
    busy:
      effectivePhase === 'simulating' ||
      effectivePhase === 'signing' ||
      effectivePhase === 'pending',
    /** The confirm can end on Done: the transaction succeeded, or it is with a Safe. */
    settled: effectivePhase === 'success' || effectivePhase === 'submitted',
    /** The one line a `submitted` confirm shows. */
    notice,
    /** Whether the connected writer is a Safe connector. */
    isSafe,
    error: effectiveError,
    hash: proposal ? proposal.executionHash : hash,
    safeProposalHash: awaitingProposal,
    safeNonceGuidance: awaitingProposal ? SAFE_NONCE_GUIDANCE : null,
    receipt: proposal ? proposal.receipt : (receiptData ?? null),
    /** The transaction has a hash, but its result could not be confirmed here. */
    confirmationUncertain: proposal
      ? proposal.phase === 'unproven'
      : phase === 'pending' && receipt.isError && !receiptData,
    send,
    reset,
    dismiss,
  }
}
