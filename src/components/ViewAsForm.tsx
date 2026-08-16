'use client'

import { useState, type FormEvent } from 'react'
import { isAddress, type Address } from 'viem'
import { looksLikeEns, lookupEnsAddress } from '@/lib/ens'
import { useViewAs } from '@/lib/viewAs'

/**
 * Browse the site as any address, without connecting anything.
 *
 * Lives at the foot of sign-in because that is the question it answers —
 * "I want to look, not to sign in" — and it should not compete with the ways
 * in that actually transact.
 */
export function ViewAsForm({ onDone }: { onDone: () => void }) {
  const { setViewAs } = useViewAs()
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const input = value.trim()
    setError(null)
    if (isAddress(input)) {
      setViewAs(input as Address)
      onDone()
      return
    }
    if (looksLikeEns(input)) {
      setBusy(true)
      try {
        const resolved = await lookupEnsAddress(input)
        if (resolved) {
          setViewAs(resolved)
          onDone()
          return
        }
        setError('Could not resolve that ENS name.')
      } finally {
        setBusy(false)
      }
      return
    }
    setError('Enter an address or ENS name.')
  }

  return (
    <form onSubmit={submit} className="mt-2 flex items-start gap-2">
      <div className="min-w-0 flex-1">
        <input
          value={value}
          onChange={event => setValue(event.target.value)}
          placeholder="Address or ENS"
          aria-label="Address or ENS name to view as"
          autoFocus
          className="input-well h-9 w-full px-3 text-sm"
        />
        {error ? <p className="mt-1.5 text-xs text-error-500">{error}</p> : null}
      </div>
      <button
        type="submit"
        disabled={busy}
        className="btn-secondary h-9 shrink-0 px-3 text-xs disabled:opacity-60"
      >
        {busy ? 'Resolving…' : 'View'}
      </button>
    </form>
  )
}
