'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { Hex } from 'viem'
import type { ReviewedActionState, ReviewedRun } from '@/hooks/useReviewedAction'
import { revertedReceipt } from '@/lib/reviewed-call'
import { SAVED_SEQUENCE_LINE, sequenceCalls } from '@/lib/reviewed-send'

/** A plan's whole run: one reviewed call per step, in order, saved under `scope` so a stopped run resumes. */
export type StepRunAction = ReviewedRun & { scope: string }

/** The plan's step of the run's call `step`: a held sequence resumes as saved, so its calls are the plan's last ones. */
function shownOf(current: { steps: readonly unknown[]; action: ReviewedRun | null }, step: number) {
  return Math.max(0, current.steps.length - (current.action?.calls.length ?? current.steps.length) + step)
}

/**
 * Sends a plan's steps as one reviewed action: one review, then each step once
 * the one before it confirmed (core simulates it on that step's block).
 *
 * The run's calls are frozen when it starts: `resume` sends the same calls, so
 * core continues the saved sequence at the step it stopped on and never sends
 * a completed step again. A stopped run belongs to the steps it started with:
 * `stoppedOn` and `resume` answer only for those, so a plan reviewed since can
 * never continue an older one.
 *
 * A step proposed to a Safe, or one whose receipt could not be read, ends the
 * run on Done. When it settles while the engine still shows it, it counts as
 * that step's confirmation: the run finishes after the last step, and
 * otherwise stops at the next step, which `resume` sends for review.
 */
export function useStepRun<Step>({
  tx,
  send,
  action,
  onFinish,
}: {
  tx: ReviewedActionState
  /** The flow's own reviewed send (its hook's `run`), so the send stays in the flow's inventory. */
  send: ReviewedActionState['run']
  /** The run for these steps, or null when there is no plan to send. */
  action: (steps: readonly Step[]) => StepRunAction | null
  /** The last step confirmed, in the transaction `hash`. */
  onFinish: (hash: Hex) => void
}) {
  const [running, setRunning] = useState(false)
  const [index, setIndex] = useState(0)
  /** The steps the run started with, while it is remembered. */
  const [runSteps, setRunSteps] = useState<readonly Step[] | null>(null)
  /** The run ended on a step proposed to a Safe. */
  const [proposed, setProposed] = useState(false)
  // Event handlers and send callbacks read these at once; the state above is
  // what renders.
  const run = useRef({
    steps: [] as readonly Step[],
    action: null as ReviewedRun | null,
    running: false,
    /** Other work holds the run (see `hold`). */
    holding: false,
    /** The last step the wallet took. */
    submitted: null as number | null,
    /** The step the run ended on, proposed or unconfirmed, until it settles. */
    waiting: null as number | null,
  })

  const halt = useCallback(() => {
    run.current.running = false
    setRunning(false)
  }, [])

  const finish = useCallback(
    (current: typeof run.current, hash: Hex) => {
      setIndex(current.steps.length)
      setProposed(false)
      onFinish(hash)
    },
    [onFinish],
  )

  const go = useCallback(
    async (current: typeof run.current) => {
      const frozen = current.action!
      const shown = (step: number) => shownOf(current, step)
      current.running = true
      current.waiting = null
      setRunning(true)
      setProposed(false)
      tx.reset()
      const result = await send({
        ...frozen,
        onSubmitted: (call, step, hash, sent) => {
          current.submitted = shown(step)
          if (run.current === current) setIndex(current.submitted)
          return frozen.onSubmitted?.(call, step, hash, sent)
        },
      })
      if (run.current !== current) return
      halt()
      if (result?.status === 'done') {
        finish(current, result.hashes.at(-1)!)
      } else if (result?.status === 'proposed') {
        current.waiting = shown(result.step)
        setIndex(current.waiting)
        setProposed(true)
      } else if (current.submitted !== null) {
        // Stopped after the last step the wallet took: the effect below moves
        // back onto it when that step is the one that reverted or is held.
        setIndex(current.submitted + 1)
      }
    },
    [tx, send, halt, finish],
  )

  // The step core is on, while it is reviewed, simulated, signed or awaited.
  useEffect(() => {
    const current = run.current
    if (current.running && !current.holding && current.action && tx.busy) setIndex(shownOf(current, tx.step))
  }, [tx.busy, tx.step])

  useEffect(() => {
    const current = run.current
    if (running || current.running) return
    const failedOnSubmitted = tx.phase === 'unconfirmed' || (tx.phase === 'error' && !!revertedReceipt(tx.failure))
    if (current.waiting === null && current.submitted !== null && failedOnSubmitted) {
      setIndex(current.submitted)
      if (tx.phase === 'unconfirmed') current.waiting = current.submitted
      return
    }
    if (current.waiting === null) return
    if (tx.phase === 'error') {
      // The proposal ended without running: the run stays stopped on its step.
      current.waiting = null
      setProposed(false)
      return
    }
    if (tx.phase !== 'success' || !tx.hash) return
    const at = current.waiting
    current.waiting = null
    setProposed(false)
    if (at >= current.steps.length - 1) {
      finish(current, tx.hash)
      return
    }
    // The step after a settled proposal is reviewed again: the run stops at it.
    setIndex(at + 1)
  }, [running, tx.phase, tx.hash, tx.failure, finish])

  /** Start a new run at the first step, or continue a held one as it was saved. */
  const start = useCallback(
    async (steps: readonly Step[]) => {
      const fresh = run.current.running || !steps.length ? null : action(steps)
      if (!fresh) return
      const current: typeof run.current = { steps, action: fresh, running: true, holding: false, submitted: null, waiting: null }
      run.current = current
      setIndex(0)
      setRunSteps(steps)
      setRunning(true)
      const { calls, saved, scope, held } = await sequenceCalls(fresh.scope, fresh.account, fresh.calls.map((call, at) => (at ? { ...call, dependsOnPrior: true } : call)))
      if (run.current !== current) return
      // A saved run continues as it was reviewed: never under this plan's summary or checks.
      current.action = saved ? { account: fresh.account, scope, calls, description: SAVED_SEQUENCE_LINE } : { ...fresh, calls, scope }
      // The saved step in flight is the one its hold settles: the run waits on it as if sent here.
      if (held !== undefined) current.submitted = shownOf(current, held)
      await go(current)
    },
    [action, go],
  )

  /**
   * Send the run's frozen calls again, so core continues where it stopped. It
   * refuses (false) for any steps but the ones the run started with.
   */
  const resume = useCallback(
    (steps: readonly Step[]): boolean => {
      const current = run.current
      if (current.running || !current.action || steps !== current.steps || index >= steps.length) return false
      void go(current)
      return true
    },
    [go, index],
  )

  /** Run other work, such as one Safe batch proposal, as the run: the flow is busy until it ends. */
  const hold = useCallback(
    async (work: () => Promise<void>) => {
      const current = run.current
      if (current.running) return
      current.running = true
      current.holding = true
      setRunning(true)
      try {
        await work()
      } finally {
        current.holding = false
        if (run.current === current) halt()
      }
    },
    [halt],
  )

  /**
   * Forget the run and reset the engine, whenever the flow drops or replaces
   * its plan: a stopped step and its error go with it.
   */
  const clear = useCallback(() => {
    run.current = { steps: [], action: null, running: false, holding: false, submitted: null, waiting: null }
    setIndex(0)
    setRunSteps(null)
    setProposed(false)
    setRunning(false)
    tx.reset()
  }, [tx])

  return {
    running,
    /** The step the run is on, or stopped at. */
    index,
    /** The run ended on a step proposed to a Safe: the confirm ends on Done. */
    proposed,
    /** The run is suspended on a step whose receipt could not be read: the confirm ends on Done and nothing is resent. */
    unconfirmed: !running && tx.phase === 'unconfirmed',
    /** The run through these exact steps stopped before its last step confirmed, so `resume` continues it. */
    stoppedOn: (steps: readonly Step[] | undefined): boolean =>
      !running &&
      !!steps &&
      steps === runSteps &&
      index < steps.length &&
      (index > 0 || tx.phase === 'error'),
    /** `running`, read at once (for a click that lands before the next render). */
    isRunning: () => run.current.running,
    start,
    resume,
    hold,
    clear,
  }
}
