'use client'

import { useState } from 'react'
import { discardRelayrSession, relayrDiscardLine, RelayrDiscardError, type RelayrDiscardReason } from '@/lib/relayr'

/**
 * The one line and the Discard of a saved Relayr session whose requests are
 * all dead (ruling R114). Discard removes only the session; `onDiscarded`
 * lets the action review it again.
 */
export function RelayrDiscard({ scope, reason, onDiscarded }: {
  scope: string
  reason: RelayrDiscardReason
  onDiscarded: () => void | Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="space-y-2">
      <p className="text-sm text-smoke-700">{relayrDiscardLine(reason)}</p>
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
 */
export function useRelayrDiscard(clearError: () => void) {
  const [failure, setFailure] = useState<RelayrDiscardError | null>(null)
  return {
    active: failure !== null,
    capture: (error: unknown) => setFailure(error instanceof RelayrDiscardError ? error : null),
    reset: () => {
      if (failure) clearError()
      setFailure(null)
    },
    element: failure ? (
      <RelayrDiscard scope={failure.scope} reason={failure.reason} onDiscarded={() => { setFailure(null); clearError() }} />
    ) : null,
  }
}
