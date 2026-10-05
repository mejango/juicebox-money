import { useSyncExternalStore } from 'react'
import type { Hex } from 'viem'
import { vi } from 'vitest'

type Phase = 'idle' | 'review' | 'simulating' | 'signing' | 'pending' | 'submitted' | 'success' | 'error'
type EngineState = {
  phase: Phase
  hash: Hex | null
  receipt: { blockNumber: bigint; transactionHash: Hex } | null
  error: string | null
  notice: string | null
}

const IDLE: EngineState = { phase: 'idle', hash: null, receipt: null, error: null, notice: null }

/**
 * A stand-in for useSafeTx whose sends the test answers, keeping the engine's
 * rules: a send it takes shows its hash as pending before `send` resolves, a
 * send it does not take (a closed review) changes nothing and answers null,
 * and `reset` clears the last result.
 */
function fakeSafeTx() {
  let state = IDLE
  const listeners = new Set<() => void>()
  const waiting: ((hash: Hex | null) => void)[] = []
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
  const reset = vi.fn(() => set(IDLE))
  /** Closing a confirm: the engine forgets its state, as `reset` does here. */
  const dismiss = vi.fn(() => set(IDLE))
  return {
    send,
    reset,
    dismiss,
    useSafeTx() {
      const snapshot = useSyncExternalStore(subscribe, () => state)
      return {
        ...snapshot,
        busy:
          snapshot.phase === 'simulating' ||
          snapshot.phase === 'signing' ||
          snapshot.phase === 'pending',
        settled: snapshot.phase === 'success' || snapshot.phase === 'submitted',
        isSafe: false,
        safeProposalHash: null,
        safeNonceGuidance: null,
        confirmationUncertain: false,
        send,
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
    },
    /** The send went to a Safe, which has not settled it: its confirm can end, showing `notice`. */
    propose(notice: string) {
      set({ phase: 'submitted', notice })
    },
    fail(error: string) {
      set({ phase: 'error', error })
    },
    restart() {
      state = IDLE
      waiting.length = 0
      send.mockClear()
      reset.mockClear()
      dismiss.mockClear()
    },
  }
}

export const engine = fakeSafeTx()
