'use client'

import { useEffect, useState } from 'react'
import { type Address } from 'viem'
import { useAccount } from 'wagmi'
import { AddressLabel } from '@/components/ui/AddressLabel'
import { AddressLink } from '@/components/ui/AddressLink'
import { truncateAddress } from '@/lib/format'
import { identityGradient } from '@/lib/identityGradient'
import { useViewAs } from '@/lib/viewAs'

/** The jump box: any address or ENS name navigates to its account page. */
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
      className="shrink-0 text-xs text-smoke-600 underline underline-offset-2 hover:text-ink"
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
  // Whose account this is matters more than which address it is, but only the
  // signed-in wallet counts — impersonating an account does not make it yours.
  const { address: signedInAddress } = useAccount()
  const isSelf =
    !!signedInAddress &&
    signedInAddress.toLowerCase() === address.toLowerCase()

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
            {isSelf ? 'Your account' : (ensName ?? <AddressLabel address={address} />)}
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
      </div>
    </header>
  )
}
