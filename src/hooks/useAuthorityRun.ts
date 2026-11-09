'use client'

import { useCallback, useState } from 'react'
import { useRelayrDiscard } from '@/components/RelayrDiscard'
import { useUnmountSignal } from '@/hooks/useUnmountSignal'
import {
  runAuthorityCalls,
  type AuthorityCall,
  type AuthorityResult,
} from '@/lib/authority'

/** One reviewed multichain authority action, from its review to its outcome. */
export type AuthorityRunState<P> =
  | { status: 'idle' }
  | { status: 'review'; plan: P }
  | { status: 'running'; plan: P; step: number; line: string | null }
  | { status: 'done'; plan: P; step: number; line: string }
  | { status: 'failed'; plan: P; step: number; line: string | null; error: string }

/**
 * The review dialog of an action sent through runAuthorityCalls: `review`
 * shows its exact calls, `run` sends them (again, after a failure), `close`
 * ends the review. `onReviewDropped` runs when Discard drops the reviewed
 * calls, so they go out only after a fresh review (ruling R114 (f)).
 */
export function useAuthorityRun<P extends { calls: AuthorityCall[] }>(
  { onReviewDropped }: { onReviewDropped?: () => void } = {},
) {
  const [state, setState] = useState<AuthorityRunState<P>>({ status: 'idle' })
  // Leaving ends a Safe app proposal's wait for its execution.
  const flowSignal = useUnmountSignal()
  const discard = useRelayrDiscard(
    () => setState(current => current.status === 'failed' ? { status: 'review', plan: current.plan } : current),
    () => { setState({ status: 'idle' }); onReviewDropped?.() },
  )
  const plan = state.status === 'idle' ? null : state.plan
  const dismiss = useCallback(
    () => setState(current => current.status === 'running' ? current : { status: 'idle' }),
    [],
  )

  /** Send the reviewed calls; `outcome` is the line on success. */
  const run = async ({ outcome, failure, onSuccess }: {
    outcome: (result: AuthorityResult, plan: P) => string
    /** The line when the error has none of its own. */
    failure: string
    onSuccess?: (result: AuthorityResult) => void
  }) => {
    if (state.status !== 'review' && state.status !== 'failed') return
    const current = state.plan
    setState({ status: 'running', plan: current, step: 0, line: null })
    discard.capture(null)
    let step = 0
    let line: string | null = null
    try {
      const result = await runAuthorityCalls({
        calls: current.calls,
        signal: flowSignal(),
        onProgress: progress => {
          line = progress.message
          if (progress.index !== undefined) step = progress.index
          setState({ status: 'running', plan: current, step, line })
        },
      })
      onSuccess?.(result)
      setState({ status: 'done', plan: current, step, line: outcome(result, current) })
    } catch (error) {
      setState({ status: 'failed', plan: current, step, line, error: error instanceof Error ? error.message : failure })
      discard.capture(error)
    }
  }

  return {
    state,
    plan,
    busy: state.status === 'running',
    done: state.status === 'done',
    run,
    review: (next: P) => setState({ status: 'review', plan: next }),
    /** Drop an unsent review (its inputs changed). A run under way keeps going. */
    dismiss,
    /** End the review; true when it ended a completed run. */
    close: () => {
      if (state.status === 'running') return false
      discard.reset()
      setState({ status: 'idle' })
      return state.status === 'done'
    },
    discard,
    /** TxProgress's run props; `retryable` false disables Retry. */
    progress: (start: () => void, { retryable = true }: { retryable?: boolean } = {}) => ({
      activeIndex: state.status === 'idle' || state.status === 'review' ? -1 : state.step,
      status: state.status === 'idle' || state.status === 'review' ? null : state.line,
      error: discard.active || state.status !== 'failed' ? null : state.error,
      busy: state.status === 'running',
      complete: state.status === 'done',
      next: state.status === 'failed'
        ? { label: 'Retry', onClick: start, disabled: !retryable || discard.active }
        : null,
    }),
  }
}
