'use client'

import { useState } from 'react'
import { discardRelayrSession, RELAYR_DISCARDABLE } from '@/lib/relayr'

/**
 * The one line and the Discard of a saved Relayr session whose requests can
 * never run again, though one may have run. `onDiscarded` clears what the
 * action itself saved, so it can be reviewed afresh.
 */
export function RelayrDiscard({ scope, onDiscarded }: { scope: string; onDiscarded: () => void | Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="space-y-2">
      <p className="text-sm text-smoke-700">{RELAYR_DISCARDABLE}</p>
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
