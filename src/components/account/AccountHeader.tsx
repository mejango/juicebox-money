'use client'

import { useRouter } from 'next/navigation'
import { useState, type FormEvent } from 'react'
import { isAddress } from 'viem'
import { identityGradient } from '@/components/ActivityList'
import { AddressLabel } from '@/components/ui/AddressLabel'
import { AddressLink } from '@/components/ui/AddressLink'
import { looksLikeEns, lookupEnsAddress } from '@/lib/ens'
import { truncateAddress } from '@/lib/format'

/** The "view as" jump box: any address or ENS name navigates to its account. */
function AccountLookup() {
  const router = useRouter()
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const input = value.trim()
    setError(null)
    if (isAddress(input)) {
      router.push(`/account/${input}`)
      return
    }
    if (looksLikeEns(input)) {
      setBusy(true)
      try {
        const resolved = await lookupEnsAddress(input)
        if (resolved) {
          router.push(`/account/${input.toLowerCase()}`)
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
    <form onSubmit={submit} className="w-full sm:w-auto">
      <div className="flex items-center gap-2">
        <input
          value={value}
          onChange={event => setValue(event.target.value)}
          placeholder="View as address or ENS"
          aria-label="View another account"
          className="h-10 w-full min-w-0 rounded-lg border border-smoke-200 bg-white px-3 text-sm text-ink placeholder:text-smoke-500 focus:border-bluebs-500 focus:outline-none sm:w-60"
        />
        <button
          type="submit"
          disabled={busy}
          className="btn-secondary h-10 shrink-0 px-4 text-sm"
        >
          {busy ? 'Resolving…' : 'View'}
        </button>
      </div>
      {error ? <p className="mt-1.5 text-xs text-crush-600">{error}</p> : null}
    </form>
  )
}

/**
 * The account view's masthead: identity bubble, ENS-aware label, explorer
 * link, and the view-as jump box.
 */
export function AccountHeader({
  address,
  ensName,
}: {
  address: string
  ensName: string | null
}) {
  return (
    <header className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-center gap-4">
        <span
          aria-hidden="true"
          className="h-16 w-16 shrink-0 rounded-full"
          style={{ background: identityGradient(address.toLowerCase()) }}
        />
        <div className="min-w-0">
          <h1 className="break-words font-agrandir text-2xl font-medium sm:text-3xl">
            {ensName ?? <AddressLabel address={address} />}
          </h1>
          <p className="mt-1 text-sm">
            <AddressLink
              address={address}
              host="etherscan.io"
              title={address}
              className="text-smoke-600"
            >
              {truncateAddress(address)}
            </AddressLink>
          </p>
        </div>
      </div>
      <AccountLookup />
    </header>
  )
}
