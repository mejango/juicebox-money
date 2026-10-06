'use client'

import { useState } from 'react'
import type { RelayrDiscardReason } from '@bananapus/nana-sdk-core/review/relayr'
import { discardRelayrSession, relayrDiscardLine, RelayrDiscardError } from '@/lib/relayr'

/**
 * The one line and the Discard of a saved Relayr session whose requests are
 * all dead (ruling R114). Discard removes only the session; `onDiscarded`
 * lets the action review it again. `paymentUnmatched`: its saved payment
 * proved to be another transaction, which the line says.
 */
export function RelayrDiscard({ scope, reason, paymentUnmatched, onDiscarded }: {
  scope: string
  reason: RelayrDiscardReason
  paymentUnmatched?: boolean
  onDiscarded: () => void | Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="space-y-2">
      <p className="text-sm text-smoke-700">{relayrDiscardLine(reason, paymentUnmatched)}</p>
      <button
        type="button"
        className="btn-secondary min-h-[36px] px-4 text-sm"
        disabled={busy}
        onClick={async () => {
          setBusy(true)
          setError(null)
          try {
            await discardRelayrSession(scope)
            await onDiscarded()
          } catch (discardError) {
            setError(discardError instanceof Error ? discardError.message : 'Could not discard this action.')
          } finally {
            setBusy(false)
          }
        }}
      >
        {busy ? 'Discarding…' : 'Discard'}
      </button>
      {error ? <p className="text-xs text-red-700">{error}</p> : null}
    </div>
  )
}

/**
 * For an action that shows its own error: the session its last attempt said
 * to discard (ruling R114). `capture` takes each attempt's error, `element` is
 * the line and Discard to show in place of that error, and `reset` drops both
 * when the review closes. `clearError` clears the action's copy of the line.
 * `closeReview`, after Discard, drops the reviewed calls of an action with no
 * recheck of its own or of a batch, so they go out again only after a fresh
 * review (ruling R114 (f)).
 */
export function useRelayrDiscard(clearError: () => void, closeReview?: () => void) {
  const [failure, setFailure] = useState<RelayrDiscardError | null>(null)
  return {
    active: failure !== null,
    capture: (error: unknown) => setFailure(error instanceof RelayrDiscardError ? error : null),
    reset: () => {
      if (failure) clearError()
      setFailure(null)
    },
    element: failure ? (
      <RelayrDiscard scope={failure.scope} reason={failure.reason} paymentUnmatched={failure.paymentUnmatched} onDiscarded={() => { setFailure(null); clearError(); closeReview?.() }} />
    ) : null,
  }
}
