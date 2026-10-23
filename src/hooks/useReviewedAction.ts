'use client'

import { createElement, useEffect, useRef, useState, type ReactElement } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { Address, TransactionReceipt } from 'viem'
import { ReviewLineError, type ReviewedAction, type ReviewedResult } from '@bananapus/nana-sdk-core/review'
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
export { hashOf, reviewedCall, revertedReceipt, type TxRequest } from '@/lib/reviewed-call'
import { reviewDescription } from '@/lib/write-holds'
import { wagmiConfig } from '@/providers/Providers'

const CENTER_WALLET_REFUSED =
  'This action needs an external wallet. Juicebox wallet payments use their own payment review.'

export type TxPhase =
  | 'idle'
  | 'review'
  | 'simulating'
  | 'signing'
  | 'pending'
  /** Held with the hold's own line: its exit, a wallet still pending, or a success that went through while away. */
  | 'unconfirmed'
  /** With a Safe, awaiting its signers: the hold's line says where it is. */
  | 'submitted'
  | 'success'
  | 'error'

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
  const inFlight = useRef(false)

  const run = async (action: ReviewedRun): Promise<ReviewedResult | null> => {
    // A flow whose page closed opens no review.
    if (inFlight.current || unmounted().aborted) return null
    inFlight.current = true
    setResult(null)
    setSentOn(action.calls[0]?.chainId)
    const viaSafe = isSafeConnection(wagmiConfig)
    try {
      const ended = await runner.run({
        ...action,
        description: reviewDescription(action.description, viaSafe ? SAFE_NONCE_GUIDANCE : null),
        ...(viaSafe && !action.confirmLabel ? { confirmLabel: 'Agree & continue to Safe' } : {}),
      })
      // A failed run shows its line through `error` and its value through `failure`.
      const done = ended?.status === 'failed' ? null : ended
      setResult(done)
      return done
    } finally {
      inFlight.current = false
    }
  }

  const { held } = runner
  const phase: TxPhase =
    runner.phase === 'done' ? 'success'
      // A proposal the hold could no longer prove is held with its exit.
      : runner.phase === 'proposed' ? (held?.phase === 'held' ? 'unconfirmed' : 'submitted')
        : runner.phase === 'receipt' ? 'pending'
          : runner.phase !== 'idle' ? runner.phase
            : held ? 'unconfirmed'
              : runner.error ? 'error'
                : 'idle'
  const shownChainId = sentOn ?? chainId ?? 0
  const action = runner.exitAction ?? runner.sendAgainAction
  const error: string | ReactElement | null = phase === 'unconfirmed' && held
    ? createElement(WriteHeldNotice, { chainId: shownChainId, view: held, action })
    : runner.error

  // A Safe proposal its hold settled ends on the execution's hash and receipt.
  const hash = result?.status === 'done' ? result.hashes.at(-1) ?? null : runner.receipt?.transactionHash ?? runner.hash
  const confirmed = phase === 'success' && hash ? `${shownChainId}:${hash}` : null
  const invalidated = useRef<string | null>(null)
  useEffect(() => {
    if (!confirmed || invalidated.current === confirmed) return
    invalidated.current = confirmed
    void invalidateProjectDisplayQueries(queryClient, shownChainId)
  }, [confirmed, queryClient, shownChainId])

  const reset = () => {
    if (inFlight.current) return
    setResult(null)
    runner.reset()
  }
  // A finished run's, a settled proposal's, or a step that mined and reverted.
  const receipt: TransactionReceipt | null = result?.status === 'done'
    ? result.receipts.at(-1) ?? null
    : runner.receipt ?? revertedReceipt(runner.failure)
  const safeProposalHash = phase === 'submitted' ? runner.safeTxHash : null

  return {
    run,
    phase,
    /** True while the run is in flight: in review, simulating, signing or awaiting its receipt. */
    busy: phase === 'review' || phase === 'simulating' || phase === 'signing' || phase === 'pending',
    /** The confirm can end on Done: it succeeded, it is with a Safe, or the hold has it. */
    settled: phase === 'success' || phase === 'submitted' || phase === 'unconfirmed',
    /** The one line a `submitted` confirm shows: the hold's. */
    notice: phase === 'submitted' ? held?.line ?? null : null,
    isSafe,
    error,
    /** The value the failed run threw, for a flow's own decoder. */
    failure: runner.failure,
    hash,
    safeProposalHash,
    safeNonceGuidance: safeProposalHash ? SAFE_NONCE_GUIDANCE : null,
    receipt,
    /** The transaction has a hash, but its result could not be confirmed here. */
    confirmationUncertain: phase === 'unconfirmed',
    reset,
    /** Close the current confirmation. The hold keeps the write; dismissing is never evidence that it can be sent again. */
    dismiss: reset,
  }
}

export type ReviewedActionState = ReturnType<typeof useReviewedAction>
