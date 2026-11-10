'use client'

import { createElement, useEffect, useRef, useState, type ReactElement } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { Address, TransactionReceipt } from 'viem'
import { openStepHold, ReviewLineError, type ReviewedAction, type ReviewedResult, type ReviewedRunStatus, type WriteHoldClient } from '@bananapus/nana-sdk-core/review'
import { useReviewedRun } from '@bananapus/nana-sdk-core/review/react'
import { WriteHeldNotice } from '@/components/ui/WriteHeldNotice'
import { useUnmountSignal } from '@/hooks/useUnmountSignal'
import { useWallet } from '@/hooks/useWallet'
import { invalidateProjectDisplayQueries } from '@/lib/project-display-cache'
import { isSafeConnection, SAFE_NONCE_GUIDANCE, useSafeConnection } from '@/lib/safe-connector'
import { getViewAs, VIEW_AS_WRITE_BLOCKED } from '@/lib/viewAs'
import { reviewedSendDeps } from '@/lib/reviewed-send'
import { loadReviewEngine, preloadReviewDialog } from '@/lib/preload-review'

import { revertedReceipt } from '@/lib/reviewed-call'
export { hashOf, liveStep, reviewedCall, revertedReceipt, type TxRequest } from '@/lib/reviewed-call'
import { followDetached, reviewDescription, writeHolds } from '@/lib/write-holds'
import { wagmiConfig } from '@/providers/Providers'

/** A run the user closed at its review or wallet prompt: what happened, and the way on. */
export const REVIEW_CLOSED_LINE = 'Nothing was sent. Review it again when you are ready.'
/** A run the user closed after an earlier step was sent: that step stands, and running again sends the rest. */
export const REVIEW_STOPPED_LINE = 'The rest was not sent. Review it again when you are ready.'

const CENTER_WALLET_REFUSED =
  'This action needs an external wallet. Juicebox wallet payments use their own payment review.'

/**
 * The shared in-flight button copy: the fixed simulating/signing strings every
 * flow uses, the caller's `pending` progress text, and its `idle` label
 * (any non-in-flight phase falls through to `idle`). `confirm` overrides the
 * signing string for flows with more specific wallet copy.
 */
export function txPhaseLabel(
  phase: ReviewedRunStatus,
  labels: { idle: string; pending: string; confirm?: string },
): string {
  if (phase === 'simulating') return 'Double-checking the transaction…'
  if (phase === 'signing') return labels.confirm ?? 'Confirm in your wallet…'
  if (phase === 'receipt') return labels.pending
  return labels.idle
}

export type ReviewedRun = Omit<ReviewedAction, 'account' | 'guard'> & {
  /** The account the calls were built for: the run is refused unless it is connected. */
  account: Address
}

/**
 * jbm's one reviewed send, over core's useReviewedRun: jbm's wallet, chains,
 * write hold and guard, with each run's progress as the phases the flows show.
 * Core reviews, simulates, holds, journals and sends; this hook only maps its
 * state for display.
 */
export function useReviewedAction(chainId?: number) {
  const queryClient = useQueryClient()
  const { address, isCenterWallet } = useWallet()
  const isSafe = useSafeConnection(wagmiConfig)
  const runner = useReviewedRun({
    account: address,
    ...reviewedSendDeps,
    // The send engine loads once a page mounts a write, not with the page.
    engine: loadReviewEngine,
    guard: () => {
      if (isCenterWallet) throw new ReviewLineError(CENTER_WALLET_REFUSED)
      if (getViewAs()) throw new ReviewLineError(VIEW_AS_WRITE_BLOCKED)
    },
  })
  useEffect(preloadReviewDialog, [])
  const unmounted = useUnmountSignal()
  const [result, setResult] = useState<ReviewedResult | null>(null)
  const [sentOn, setSentOn] = useState<number | undefined>(undefined)
  /** The latest run's call count, which core forgets once the run ends. */
  const [total, setTotal] = useState(0)
  const inFlight = useRef(false)
  /** The sent step the run only waits on its hold for: closing its confirm ends the run there. */
  const awaiting = useRef<{ stop: () => void } | null>(null)
  /** `awaiting` is set, for rendering. */
  const [following, setFollowing] = useState(false)

  const run = async (action: ReviewedRun): Promise<ReviewedResult | null> => {
    // A flow whose page closed opens no review.
    if (inFlight.current || unmounted().aborted) return null
    inFlight.current = true
    setResult(null)
    setSentOn(action.calls[0]?.chainId)
    setTotal(action.calls.length)
    const viaSafe = isSafeConnection(wagmiConfig)
    try {
      const ran = await runner.run({
        ...action,
        description: reviewDescription(action.description, viaSafe ? SAFE_NONCE_GUIDANCE : null),
        ...(viaSafe && !action.confirmLabel ? { confirmLabel: 'Agree & continue to Safe' } : {}),
      })
      // A sent step whose receipt is still being verified is pending (`phase`), never failed, until
      // its hold ends the run. A failed run shows its line through `error` and its value through `failure`.
      // Closing its confirm ends this wait with nothing, and the hold keeps the sent step. An earlier
      // step (an approval) resets core's run, so no later step is reviewed for it; the last step stays
      // core's held run, whose line and lock the flow keeps showing until it settles.
      const ended = ran?.status === 'receipt'
        ? await Promise.race([ran.ended(), new Promise<null>(resolve => {
          const call = action.calls[ran.step]!
          awaiting.current = {
            stop: ran.step === action.calls.length - 1 ? () => resolve(null) : () => {
              // Its reads refresh once the step settles, though nothing is left to show it.
              followDetached(openStepHold(writeHolds, action.account, viaSafe, call), reviewedSendDeps.clientFor(call.chainId) as WriteHoldClient,
                () => void invalidateProjectDisplayQueries(queryClient, call.chainId))
              runner.reset()
            },
          }
          setFollowing(true)
        })])
        : ran
      const done = ended?.status === 'failed' ? null : ended
      setResult(done)
      return done
    } finally {
      inFlight.current = false
      awaiting.current = null
      setFollowing(false)
    }
  }

  const { held } = runner
  // Core reads a run closed after an earlier step was sent as idle, with no line: it stopped before its last step.
  const stoppedPartway = runner.status === 'idle' && runner.lastSubmittedStep !== null && runner.lastSubmittedStep < total - 1
  // Core's one status: `held` shows the hold's line and exit, `proposed` awaits a Safe's signers.
  const phase: ReviewedRunStatus = stoppedPartway ? 'cancelled' : runner.status
  const shownChainId = sentOn ?? chainId ?? 0
  const action = runner.exitAction ?? runner.sendAgainAction
  const error: string | ReactElement | null = phase === 'held' && held
    ? createElement(WriteHeldNotice, { chainId: shownChainId, view: held, action })
    : runner.error ?? (stoppedPartway ? REVIEW_STOPPED_LINE : phase === 'cancelled' ? REVIEW_CLOSED_LINE : null)

  // A Safe proposal its hold settled ends on the execution's hash and receipt.
  const hash = result?.status === 'done' ? result.hashes.at(-1) ?? null : runner.receipt?.transactionHash ?? runner.hash
  const confirmed = phase === 'done' && hash ? `${shownChainId}:${hash}` : null
  const invalidated = useRef<string | null>(null)
  useEffect(() => {
    if (!confirmed || invalidated.current === confirmed) return
    invalidated.current = confirmed
    void invalidateProjectDisplayQueries(queryClient, shownChainId)
  }, [confirmed, queryClient, shownChainId])

  /** Whether it closed: never while a run's review or wallet is open; a followed send stays held, and its reads refresh once it settles. */
  const reset = () => {
    const held = awaiting.current
    if (inFlight.current && !held) return false
    if (held) {
      held.stop()
      return true
    }
    setResult(null)
    runner.reset()
    return true
  }
  // A finished run's, a settled proposal's, or a step that mined and reverted.
  const receipt: TransactionReceipt | null = result?.status === 'done'
    ? result.receipts.at(-1) ?? null
    : runner.receipt ?? revertedReceipt(runner.failure)
  const safeProposalHash = phase === 'proposed' ? runner.safeTxHash : null

  return {
    run,
    phase,
    /** True while the run is in flight: in review, simulating, signing or awaiting its receipt. */
    busy: runner.busy,
    /** The run only waits on a sent step's hold: closing the confirm (`dismiss`) ends the run there, and the hold keeps the step. */
    following,
    /** The confirm can end on Done: it succeeded, it is with a Safe, or the hold has it. */
    settled: phase === 'done' || phase === 'proposed' || phase === 'held',
    /** The run ended short of done: it failed, or was closed before its last step was sent. */
    stopped: phase === 'failed' || phase === 'cancelled',
    /** The one line a `proposed` confirm shows: the hold's. */
    notice: phase === 'proposed' ? held?.line ?? null : null,
    isSafe,
    error,
    /** The step of the run core is on (reviewing, simulating, signing or awaiting), counted in the run's calls. */
    step: runner.step,
    /** The wallet returned a hash for the run's last step, in this run or the saved sequence it resumed; `reset` clears it. */
    lastStepSent: runner.lastSubmittedStep !== null && runner.lastSubmittedStep === runner.total - 1,
    /** An ended run's earlier step that later mined successfully, by its index. */
    settledStep: runner.settled && !runner.settled.finished ? runner.settled.step : null,
    /** The value the failed run threw, for a flow's own decoder. */
    failure: runner.failure,
    hash,
    safeProposalHash,
    safeNonceGuidance: safeProposalHash ? SAFE_NONCE_GUIDANCE : null,
    receipt,
    /** The transaction has a hash, but its result could not be confirmed here. */
    confirmationUncertain: phase === 'held',
    reset,
    /** Close the current confirmation. The hold keeps the write; dismissing is never evidence that it can be sent again. */
    dismiss: reset,
  }
}

export type ReviewedActionState = ReturnType<typeof useReviewedAction>
