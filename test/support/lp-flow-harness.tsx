import { useSyncExternalStore } from 'react'
import type { Hex } from 'viem'
import type { ReviewedResult } from '@bananapus/nana-sdk-core/review'
import type { ReviewedRun } from '@/hooks/useReviewedAction'
import { vi } from 'vitest'

type Phase = 'idle' | 'review' | 'simulating' | 'signing' | 'pending' | 'unconfirmed' | 'submitted' | 'success' | 'error'
type EngineState = {
  phase: Phase
  hash: Hex | null
  receipt: { blockNumber: bigint; transactionHash: Hex } | null
  error: string | null
  notice: string | null
}

const IDLE: EngineState = { phase: 'idle', hash: null, receipt: null, error: null, notice: null }

/**
 * A stand-in for useReviewedAction whose runs the test answers, keeping the
 * engine's rules: each step it takes shows its hash as pending, a step it
 * does not take (a closed review) changes nothing and ends the run with null,
 * the next step goes only once the one before it confirmed, and `reset`
 * clears the last result. `send` records each step as the call its flow built
 * and the run's options with the call's keys.
 */
function fakeReviewedAction() {
  let state = IDLE
  const listeners = new Set<() => void>()
  const waiting: ((hash: Hex | null) => void)[] = []
  /** How the step the wallet took ends: confirmed, proposed to a Safe, or stopped. */
  const saved = new Map<string, { calls: unknown; from: number }>()
  let settling: ((end: 'confirmed' | 'proposed' | 'stopped') => void) | null = null
  const settle = (end: 'confirmed' | 'proposed' | 'stopped') => {
    const next = settling
    settling = null
    next?.(end)
  }
  const set = (next: Partial<EngineState>) => {
    state = { ...state, ...next }
    for (const listener of listeners) listener()
  }
  const subscribe = (listener: () => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }
  const send = vi.fn(
    (_request: unknown, _options?: unknown) =>
      new Promise<Hex | null>(resolve => {
        waiting.push(hash => {
          if (hash) set({ phase: 'pending', hash, receipt: null, error: null })
          resolve(hash)
        })
      }),
  )
  const run = async (action: ReviewedRun): Promise<ReviewedResult | null> => {
    const hashes: Hex[] = []
    // As core: the same calls again under their scope continue after the steps that confirmed.
    const record = action.scope ? saved.get(action.scope) : undefined
    const from = record?.calls === action.calls ? record.from : 0
    if (action.scope) saved.set(action.scope, { calls: action.calls, from })
    for (const [step, call] of action.calls.entries()) {
      if (step < from) continue
      const { chainId, to, abi, functionName, args, value, label, intent, legacy, simulationBlockNumber, dependsOnPrior } = call
      const hash = await send({ chainId, address: to, abi, functionName, args, value, label }, { ...action, intent, legacy, simulationBlockNumber, dependsOnPrior })
      if (!hash) return null
      hashes.push(hash)
      await action.onSubmitted?.(call, step, hash, { safe: false, adopted: false })
      const end = await new Promise<'confirmed' | 'proposed' | 'stopped'>(resolve => (settling = resolve))
      if (end === 'proposed') return { status: 'proposed', step, safeTxHash: hash }
      if (end === 'stopped') return null
      if (action.scope) saved.set(action.scope, { calls: action.calls, from: step + 1 })
    }
    if (action.scope) saved.delete(action.scope)
    return { status: 'done', hashes, receipts: [] }
  }
  const reset = vi.fn(() => set(IDLE))
  /** Closing a confirm: the engine forgets its state, as `reset` does here. */
  const dismiss = vi.fn(() => set(IDLE))
  return {
    send,
    reset,
    dismiss,
    useReviewedAction() {
      const snapshot = useSyncExternalStore(subscribe, () => state)
      return {
        ...snapshot,
        busy:
          snapshot.phase === 'simulating' ||
          snapshot.phase === 'signing' ||
          snapshot.phase === 'pending',
        settled: snapshot.phase === 'success' || snapshot.phase === 'submitted' || snapshot.phase === 'unconfirmed',
        isSafe: false,
        safeProposalHash: null,
        safeNonceGuidance: null,
        confirmationUncertain: snapshot.phase === 'unconfirmed',
        failure: null,
        run,
        reset,
        dismiss,
      }
    },
    /** Answer the oldest send still waiting: the hash the engine took it with, or null. */
    answer(hash: Hex | null) {
      const next = waiting.shift()
      if (!next) throw new Error('No send is waiting for an answer.')
      next(hash)
    },
    confirm(hash: Hex, blockNumber: bigint) {
      set({ phase: 'success', hash, receipt: { blockNumber, transactionHash: hash }, notice: null })
      settle('confirmed')
    },
    /** The send went to a Safe, which has not settled it: its confirm can end, showing `notice`. */
    propose(notice: string) {
      set({ phase: 'submitted', notice })
      settle('proposed')
    },
    /** The receipt watch gave up on the sent step: it may still land, and the engine keeps it locked. */
    unconfirm(error: string) {
      set({ phase: 'unconfirmed', error })
      settle('stopped')
    },
    fail(error: string) {
      set({ phase: 'error', error })
      settle('stopped')
    },
    restart() {
      state = IDLE
      waiting.length = 0
      settling = null
      saved.clear()
      send.mockClear()
      reset.mockClear()
      dismiss.mockClear()
    },
  }
}

export const engine = fakeReviewedAction()
