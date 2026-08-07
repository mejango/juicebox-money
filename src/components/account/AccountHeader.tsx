'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useState, type FormEvent } from 'react'
import { isAddress, type Address } from 'viem'
import { AddressLabel } from '@/components/ui/AddressLabel'
import { AddressLink } from '@/components/ui/AddressLink'
import { looksLikeEns, lookupEnsAddress } from '@/lib/ens'
import { truncateAddress } from '@/lib/format'
import { identityGradient } from '@/lib/identityGradient'
import { useViewAs } from '@/lib/viewAs'

/** The jump box: any address or ENS name navigates to its account page. */
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
          placeholder="Go to address or ENS"
          aria-label="Go to another account"
          className="h-10 w-full min-w-0 rounded-lg border border-smoke-200 bg-white px-3 text-sm text-ink placeholder:text-smoke-500 focus:border-bluebs-500 focus:outline-none sm:w-52"
        />
        <button
          type="submit"
          disabled={busy}
          className="btn-secondary h-10 shrink-0 px-4 text-sm"
        >
          {busy ? 'Resolving…' : 'Go'}
        </button>
      </div>
      {error ? <p className="mt-1.5 text-xs text-crush-600">{error}</p> : null}
    </form>
  )
}

/** Toggle site-wide "View as" mode for this account. */
function ViewSiteAsButton({ address }: { address: string }) {
  const { viewAs, setViewAs, clearViewAs } = useViewAs()
  // View-as state only exists client-side; render the inactive shell on the
  // server so hydration always matches.
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  const active =
    mounted && !!viewAs && viewAs.toLowerCase() === address.toLowerCase()

  return (
    <button
      onClick={() =>
        active ? clearViewAs() : setViewAs(address as Address)
      }
      className="btn-secondary h-10 shrink-0 px-4 text-sm"
    >
      {active ? 'Exit View as' : 'View site as this account'}
    </button>
  )
}

/**
 * The account view's masthead: identity bubble, ENS-aware label, explorer
 * link, the site-wide view-as toggle, and the account jump box.
 */
export function AccountHeader({
  address,
  ensName,
  chainId,
}: {
  address: string
  ensName: string | null
  /** A chain this account appears on, for the explorer link. Omitted ⇒ no link. */
  chainId?: number
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
              // An address is not chain-specific, so link the explorer for a chain this
              // account actually appears on. Hard-coding mainnet sent every testnet user to
              // the wrong explorer; with no known chain AddressLink renders a plain span.
              chainId={chainId}
              title={address}
              className="text-smoke-600"
            >
              {truncateAddress(address)}
            </AddressLink>
          </p>
        </div>
      </div>
      <div className="flex flex-col gap-3 sm:items-end">
        <ViewSiteAsButton address={address} />
        <AccountLookup />
      </div>
    </header>
  )
}
