'use client'

import { createElement, useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { getAccount } from '@wagmi/core'
import {
  BaseError,
  encodeFunctionData,
  isHash,
  type Abi,
  type Address,
  type Hex,
  type TransactionReceipt,
} from 'viem'
import { usePublicClient, useSwitchChain, useWaitForTransactionReceipt, useWriteContract } from 'wagmi'
import { useHeldSend } from '@bananapus/nana-sdk-core/review/react'
import {
  gasWithHeadroom,
  settledLine,
  HELD_AWAY_SUCCESS_LINE,
  SubmittedContractWriteError,
  WRITE_HOLD_PENDING_LINE,
  WRITE_HOLD_UNCHECKED_LINE,
  WriteHeldError,
  WriteHoldBusyError,
  WriteHoldNonceError,
  WriteHoldStaleReviewError,
  type WriteHoldClient,
  type WriteHoldGate,
} from '@bananapus/nana-sdk-core/review'
import { hasSafeService } from '@bananapus/nana-sdk-core/safe-service'
import { WriteHeldNotice } from '@/components/ui/WriteHeldNotice'
import { invalidateProjectDisplayQueries } from '@/lib/project-display-cache'
import { useWallet } from '@/hooks/useWallet'
import { submitReviewedContractWrite } from '@/lib/contract-write'
import { captureWalletContext } from '@/lib/wallet-context'
import { reviewDescription, safeHoldNamespace, safeProposalKey, writeHolds } from '@/lib/write-holds'
import { getViewAs, VIEW_AS_WRITE_BLOCKED } from '@/lib/viewAs'
import { requestContractTransactionReview, TransactionReviewCancelledError } from '@/lib/transaction-review'
import { chainName } from '@/lib/urn'
import { wagmiConfig } from '@/providers/Providers'
import {
  findPendingSafeAppProposal,
  isSafeConnection,
  SAFE_NONCE_GUIDANCE,
  useSafeConnection,
  type SafeAppCall,
} from '@/lib/safe-connector'

export type TxPhase =
  | 'idle'
  | 'review'
  | 'simulating'
  | 'signing'
  | 'pending'
  /** Held with the hold's own line: its exit, a wallet still pending, or a success that went through while away. */
  | 'unconfirmed'
  /** With a Safe (awaiting its signers or confirming), or released elsewhere: the hold's line says where it is. */
  | 'submitted'
  | 'success'
  | 'error'

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
  /** The error behind a send that failed before reaching the chain (simulation, estimate, wallet), for a flow to decode. */
  onFailure?: (error: unknown) => void
  /**
   * For a write whose calldata regenerates on retry (a deadline, a Permit2
   * expiration or signature, a fresh quote): its intent key, from the SDK's
   * builders. Its hold is the intent's, so a retry is held until the user's exit.
   */
  intent?: string
  /**
   * The namespaces an earlier release keyed this action by (legacy-intents):
   * an attempt it left unresolved still holds this one until its exit.
   */
  legacy?: readonly string[]
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
function callOf(request: Pick<TxRequest, 'address' | 'abi' | 'functionName' | 'args' | 'value'>): SafeAppCall & { value: bigint } {
  return {
    to: request.address,
    data: encodeFunctionData({ abi: request.abi, functionName: request.functionName, args: request.args as unknown[] }),
    value: request.value ?? 0n,
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

/** What a Safe app replied in place of a proposal or execution hash. */
const SAFE_REPLY_UNREADABLE = 'Check this proposal in your Safe before sending it again.'

/**
 * The one transaction pipeline every project-page write flow uses: exact
 * review, simulation, then the send under the SDK's held write (useHeldSend).
 * The SDK view watches it, follows its transaction or Safe proposal, gives its
 * one line, its exit and "Send it again", and settles it; this hook only maps
 * that view onto the flow's phases. Nothing here decides whether a write may
 * be sent again.
 */
export function useSafeTx(chainId: number) {
  const queryClient = useQueryClient()
  const { isConnected, isCenterWallet } = useWallet()
  const publicClient = usePublicClient({ chainId })
  const { writeContractAsync } = useWriteContract()
  const { switchChainAsync } = useSwitchChain()
  const isSafe = useSafeConnection(wagmiConfig)

  const [phase, setPhase] = useState<Exclude<TxPhase, 'unconfirmed' | 'submitted'>>('idle')
  const [error, setError] = useState<string | null>(null)
  /** The wallet's reply for the write this flow sent: a transaction, or a Safe proposal. */
  const [sent, setSent] = useState<{ chainId: number; hash: Hex; safe: boolean } | null>(null)
  /** The hold's authenticated success, with its receipt. */
  const [result, setResult] = useState<{ hash: Hex; receipt: TransactionReceipt | null } | null>(null)
  // What the flow waits on as of its last render, for the hold's settlement callback.
  const waiting = useRef({ phase, sent })
  waiting.current = { phase, sent }
  /** The writes this flow sent and has since left (a reset, or a newer send): their settlements are stale here. */
  const left = useRef(new Set<string>())
  const followed = useRef<string | null>(null)
  const follow = useCallback((next: { chainId: number; hash: Hex; safe: boolean } | null) => {
    if (followed.current && followed.current !== next?.hash.toLowerCase()) left.current.add(followed.current)
    followed.current = next?.hash.toLowerCase() ?? null
    if (followed.current) left.current.delete(followed.current)
    setSent(next)
  }, [])
  const inFlight = useRef(false)
  /** Another window sent this write while its review was open, or the user took the exit: the next send reviews it again. */
  const reviewAgain = useRef(false)
  const lastSend = useRef<{ request: TxRequest; options: TxSendOptions } | null>(null)
  const sendRef = useRef<(request: TxRequest, options: TxSendOptions) => Promise<Hex | null>>(async () => null)

  /** This flow's own direct write, unconfirmed and still followed: closing keeps it shown, so its receipt settles it here. */
  const followingHeld = useRef(false)
  const reset = useCallback(() => {
    if (followingHeld.current) return
    inFlight.current = false
    setPhase('idle')
    setError(null)
    follow(null)
    setResult(null)
  }, [follow])

  const held = useHeldSend({
    hold: writeHolds,
    client: publicClient as WriteHoldClient | undefined,
    onSettled: (settled, receipt) => {
      if (!('hash' in settled)) return
      // Only while the flow waits, and never for a write it left: a held write it follows instead still settles here.
      if (waiting.current.phase !== 'pending' || left.current.has(settled.hash.toLowerCase())) return
      // A Safe proposal still with its signers has settled nothing: a settlement now is an earlier one's.
      if (waiting.current.sent?.safe && latest.current.phase === 'awaiting') return
      if (settled.result === 'success') {
        setResult({ hash: settled.hash, receipt })
        setPhase('success')
      } else {
        // A failure keeps its receipt too: a flow verifies what reverted before it lets the user go on.
        setResult({ hash: settled.hash, receipt })
        setError(settledLine(settled))
        setPhase('error')
      }
    },
    onReleased: by => {
      if (by !== 'user') return
      // The user checked their wallet: the same action runs again, through its review.
      const last = lastSend.current
      reset()
      if (!last) return
      reviewAgain.current = true
      void sendRef.current(last.request, last.options)
    },
  })
  const latest = useRef(held)
  latest.current = held

  // A direct write's receipt goes to its hold, which verifies it; the view then reads the settlement.
  const watched = sent && !sent.safe ? sent.hash : undefined
  const receipt = useWaitForTransactionReceipt({ hash: watched, chainId: sent?.chainId ?? chainId, timeout: 120_000, query: { enabled: !!watched } })
  const receiptData = watched && receipt.data?.transactionHash?.toLowerCase() === watched.toLowerCase() ? receipt.data : undefined
  useEffect(() => {
    if (!receiptData || !publicClient) return
    void latest.current.handle?.onReceipt(receiptData, publicClient as WriteHoldClient).then(() => latest.current.check(), () => undefined)
  }, [receiptData, publicClient])
  // The receipt watch gave up: nothing is in flight to hold the dialog open for, and the hold is asked again.
  const watchGaveUp = !!watched && receipt.isError && !receiptData
  useEffect(() => {
    if (watchGaveUp) void latest.current.check()
  }, [watchGaveUp])

  const send = useCallback(
    async (request: TxRequest, options: TxSendOptions) => {
      if (inFlight.current) return null
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
      inFlight.current = true
      lastSend.current = { request, options }
      setError(null)
      // An earlier send this flow still follows stays watched until this one is out: a refusal keeps following it.
      setResult(null)
      setPhase('simulating')
      // Read once: the review, the sent gas and the hold must all agree on whether a Safe proposes this call.
      const viaSafe = isSafeConnection(wagmiConfig)
      const account = options.reviewedAccount
      const assertOriginalWallet = captureWalletContext(wagmiConfig, { account, chainId: request.chainId })
      let call: ReturnType<typeof callOf>
      try {
        call = callOf(request)
      } catch (e) {
        inFlight.current = false
        setError(friendlyTxError(e))
        setPhase('error')
        return null
      }
      // The keys main held these writes by: a Safe proposal by its held call (fields stamped at send
      // time blanked), under its intent when it has one; a direct write by its intent or exact call.
      const safeKey = viaSafe ? safeHoldNamespace(safeProposalKey(request.chainId, account, call)) : undefined
      const namespace = options.intent ?? safeKey
      const legacy = [...(options.intent && safeKey ? [safeKey] : []), ...(options.legacy ?? [])]
      let walletInvoked = false
      /** The wallet refused it, or it stopped before the wallet: the SDK dropped its reservation, nothing was sent. */
      let unsent = false
      const execute = async (gate: WriteHoldGate): Promise<Hex> => {
        if (viaSafe && hasSafeService(request.chainId)) {
          // An action already in the Safe's queue is shown as it is and never proposed again.
          const queued = await findPendingSafeAppProposal(publicClient, request.chainId, account, call)
          if (queued) {
            await gate.beforeSend(queued.call)
            gate.afterSubmit(queued.proposalHash, queued.tx)
            return queued.proposalHash
          }
        }
        const hash = await submitReviewedContractWrite({
          request,
          expectedAccount: account,
          review: async reviewed => {
            // A review notice always opens the review, even where the caller
            // already rendered the payload — the notice exists precisely
            // because what was rendered is no longer what will be signed.
            if (options.reviewedInParent && !options.reviewNotice && !reviewAgain.current) return
            reviewAgain.current = false
            const description = reviewDescription(options.reviewNotice, viaSafe ? SAFE_NONCE_GUIDANCE : null)
            const approved = await requestContractTransactionReview(
              // A Safe app signs the sent gas as safeTxGas; 0 makes a failed call revert.
              { ...reviewed, account, ...(viaSafe ? { safeTxGas: 0n } : {}) },
              {
                label: reviewed.label,
                ...(description ? { description } : {}),
                ...(viaSafe ? { confirmLabel: 'Agree & continue to Safe' } : {}),
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
          // The SDK reserves the write first, so no flow ever records an attempt the hold does not hold.
          beforeWrite: async () => {
            await gate.beforeSend()
            try {
              await options.beforeWrite?.()
            } catch (failure) {
              gate.onRejected()
              throw failure
            }
          },
          onBeforeWriteAborted: async () => {
            unsent = true
            gate.onRejected()
            if (options.beforeWrite) await options.onBeforeWriteAborted?.()
          },
          onWriteRejected: async () => {
            unsent = true
            gate.onRejected()
            await options.onWriteRejected?.()
          },
          onWriteSubmitted: (submitted: Hex) => gate.afterSubmit(submitted),
          // Simulation is the safety gate: the exact reviewed call, args, and
          // value must succeed before a signature is requested. Only the
          // simulation result reaches the wallet writer.
          simulate: async reviewed => {
            const simulation = {
              address: reviewed.address, abi: reviewed.abi, functionName: reviewed.functionName,
              args: reviewed.args as unknown[], value: reviewed.value, account,
              ...(options.simulationBlockNumber !== undefined ? { blockNumber: options.simulationBlockNumber } : {}),
            }
            const [{ request: simulated }, estimate] = await Promise.all([
              publicClient.simulateContract(simulation),
              publicClient.estimateContractGas(simulation),
            ])
            return { ...simulated, chainId: reviewed.chainId, gas: viaSafe ? 0n : gasWithHeadroom(estimate) }
          },
          beforeSend: () => {
            assertOriginalWallet()
            if (isSafeConnection(wagmiConfig) !== viaSafe) throw new Error('Wallet connection changed. Review the transaction again.')
            options.assertWriteState?.()
          },
          write: simulated => {
            walletInvoked = true
            return writeContractAsync(simulated)
          },
          onPhase: setPhase,
        })
        // A Safe reply that is not a 32-byte hash names no proposal and no execution.
        if (viaSafe && !isHash(hash)) throw new Error(SAFE_REPLY_UNREADABLE)
        return hash
      }
      const input = { chainId: request.chainId, account, safe: viaSafe, ...(namespace ? { namespace } : {}), ...(legacy.length ? { legacy } : {}), call }
      try {
        const hash = await latest.current.send(input, execute)
        follow({ chainId: request.chainId, hash, safe: viaSafe })
        setPhase('pending')
        // A Safe proposal is with its signers: the flow may close. A direct write keeps the lock until it settles.
        if (viaSafe) inFlight.current = false
        return hash
      } catch (e) {
        if (!viaSafe && e instanceof SubmittedContractWriteError && typeof e.hash === 'string' && isHash(e.hash)) {
          // The wallet returned its hash and the write stays held: follow it.
          follow({ chainId: request.chainId, hash: e.hash, safe: false })
          setPhase('pending')
          return e.hash
        }
        inFlight.current = false
        // A proposal its Safe already has is shown as it is, never proposed again: the flow follows it.
        if (e instanceof WriteHeldError && viaSafe && !e.state.exit && e.state.record.safe && e.state.record.hash) {
          follow({ chainId: request.chainId, hash: e.state.record.hash, safe: true })
          setPhase('pending')
          return e.state.record.hash
        }
        // Held, or a success that went through while away: the SDK's view shows it, with its exit or "Send it again".
        if (e instanceof WriteHeldError || (e instanceof Error && e.message === HELD_AWAY_SUCCESS_LINE)) {
          setPhase('pending')
          void latest.current.check()
          return null
        }
        follow(null)
        if (e instanceof WriteHoldStaleReviewError) {
          // Never sent: its line, and what became of the other window's send when known.
          reviewAgain.current = true
          setError(e.settled ? `${e.message} ${settledLine(e.settled)}` : e.message)
          setPhase('error')
          return null
        }
        if (e instanceof WriteHoldBusyError || e instanceof WriteHoldNonceError) {
          setError(e.message)
          setPhase('error')
          return null
        }
        // A write that may have reached the wallet stays held, whatever was thrown: the hold says, and its view shows it.
        if (walletInvoked && !unsent) {
          try {
            const now = await writeHolds.open({ ...input, safe: viaSafe }, legacy.length ? { legacy } : undefined).state(publicClient as WriteHoldClient)
            if (now.status !== 'clear') {
              setPhase('pending')
              return null
            }
          } catch {
            setError(WRITE_HOLD_UNCHECKED_LINE)
            setPhase('error')
            return null
          }
        }
        if (e instanceof TransactionReviewCancelledError) {
          setPhase('idle')
          return null
        }
        options.onFailure?.(e)
        setError(friendlyTxError(e))
        setPhase('error')
        return null
      }
    },
    [follow, isConnected, isCenterWallet, publicClient, switchChainAsync, writeContractAsync],
  )
  sendRef.current = send

  // While the review or the wallet's own prompt is open the call is reserved, not lost: the flow shows the prompt.
  const shown = phase === 'pending' ? held : null
  const safe = !!sent?.safe
  // A reverted receipt ends the flow at once, as main does; the hold keeps the revert until it is final, so a retry waits.
  const reverted = !!shown && receiptData?.status === 'reverted' && shown.phase !== 'held'
  const effectivePhase: TxPhase = !shown
    ? phase
    : reverted
      ? 'error'
      : shown.phase === 'confirming'
      ? safe
        ? 'submitted'
        // A direct write the wallet has held a while, whose receipt watch gave up, or that this flow didn't send
        // (an earlier one it was refused over): the SDK's line, no exit, nothing in flight here.
        : !sent || watchGaveUp || shown.line === WRITE_HOLD_PENDING_LINE ? 'unconfirmed' : 'pending'
      : shown.phase === 'awaiting' || shown.phase === 'released'
        ? 'submitted'
        : shown.phase === 'held' || shown.phase === 'succeeded'
          ? 'unconfirmed'
          // A success shows once onSettled hands over its receipt; a failure shows its line now.
          : shown.phase === 'settled'
            ? shown.settled?.result === 'success' ? 'pending' : 'error'
            // Nothing held and nothing sent (another window's write settled meanwhile): the flow may review again.
            : shown.phase === 'clear' && !sent ? 'idle' : 'pending'
  followingHeld.current = effectivePhase === 'unconfirmed' && !!watched && shown?.phase === 'confirming'
  // The lock is let go once the flow shows anything but a write in flight: the hold refuses a second send.
  useEffect(() => {
    if (effectivePhase !== 'pending' && effectivePhase !== 'review' && effectivePhase !== 'simulating' && effectivePhase !== 'signing') inFlight.current = false
  }, [effectivePhase])

  const confirmedHash = result?.hash
  const invalidated = useRef<string | null>(null)
  const confirmedChainId = sent?.chainId ?? chainId
  useEffect(() => {
    if (effectivePhase !== 'success' || !confirmedHash) return
    const identity = `${confirmedChainId}:${confirmedHash}`
    if (invalidated.current === identity) return
    invalidated.current = identity
    void invalidateProjectDisplayQueries(queryClient, confirmedChainId)
  }, [confirmedChainId, confirmedHash, effectivePhase, queryClient])

  const action = shown?.exitAction
    ? { label: shown.exitAction.label, run: () => shown.exitAction!.run().catch(() => setError(WRITE_HOLD_UNCHECKED_LINE)) }
    : shown?.sendAgainAction
      ? { label: shown.sendAgainAction.label, run: () => shown.sendAgainAction!.run().then(reset) }
      : null
  const effectiveError: string | ReactElement | null = effectivePhase === 'unconfirmed' && shown
    ? createElement(WriteHeldNotice, { chainId: sent?.chainId ?? chainId, view: shown, action })
    : effectivePhase === 'error'
      ? (reverted ? `Transaction reverted onchain (${watched}).` : (error ?? shown?.line ?? null))
      : error
  const notice = effectivePhase === 'submitted' && shown ? shown.line : null
  const heldState = shown?.state && shown.state.status !== 'clear' && !shown.state.record.safe ? shown.state : null
  /** The direct write the hold shows, when this flow didn't send it. */
  const heldHash = heldState ? ('hash' in heldState && heldState.hash ? heldState.hash : heldState.record.hash) ?? null : null
  const awaitingProposal = shown?.phase === 'awaiting' && sent?.safe ? sent.hash : null

  return {
    phase: effectivePhase,
    /** True while the transaction is in flight: simulating/signing/pending. */
    busy: effectivePhase === 'simulating' || effectivePhase === 'signing' || effectivePhase === 'pending',
    /** The confirm can end on Done: the transaction succeeded, it is with a Safe, or the hold has it. */
    settled: effectivePhase === 'success' || effectivePhase === 'submitted' || effectivePhase === 'unconfirmed',
    /** The one line a `submitted` confirm shows: the hold's. */
    notice,
    /** Whether the connected writer is a Safe connector. */
    isSafe,
    error: effectiveError,
    hash: result?.hash ?? watched ?? heldHash ?? null,
    safeProposalHash: awaitingProposal,
    safeNonceGuidance: awaitingProposal ? SAFE_NONCE_GUIDANCE : null,
    receipt: result?.receipt ?? receiptData ?? null,
    /** The transaction has a hash, but its result could not be confirmed here. */
    confirmationUncertain: effectivePhase === 'unconfirmed',
    send,
    reset,
    /** Close the current confirmation. The hold keeps the write; dismissing is never evidence that it can be sent again. */
    dismiss: reset,
  }
}
