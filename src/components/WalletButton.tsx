'use client'

import dynamic from 'next/dynamic'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import type { JBChainId } from '@bananapus/nana-sdk-core'
import { useAccount } from 'wagmi'
import { AddressLabel } from '@/components/ui/AddressLabel'
import { useOutsideClose } from '@/hooks/useOutsideClose'
import { useWallet } from '@/hooks/useWallet'
import { preloadParaHost } from '@/providers/preload-para'
import { parseUrn } from '@/lib/urn'
import { projectRouteSegmentFromPathname } from '@/lib/project-handle-route'
import { useProjectHandleFromRoute } from '@/hooks/useProjectHandleFromRoute'
import { useViewAs } from '@/lib/viewAs'
import { useResolvedProjectRoute } from '@/providers/ProjectRouteContext'
import { ParaLocalDisconnectError, ParaSessionLogoutError } from '@/providers/para-logout'

// The menu's contents load with the menu: balances (bendystraw and token
// reads), View as (ENS lookups) and Get funds. Pointing at the button
// preloads them so an open menu rarely waits.
const loadWalletBalances = () => import('@/components/WalletBalances')
const loadViewAsForm = () => import('@/components/ViewAsForm')
const loadGetFunds = () => import('@/components/GetFunds')
const preloadMenu = () => {
  void loadWalletBalances()
  void loadViewAsForm()
  void loadGetFunds()
}
const menuLoading = () => (
  <div className="px-4 py-3 text-xs text-smoke-600" role="status">Loading…</div>
)
const WalletBalances = dynamic(() => loadWalletBalances().then(module => module.WalletBalances), { ssr: false, loading: menuLoading })
const ViewAsForm = dynamic(() => loadViewAsForm().then(module => module.ViewAsForm), { ssr: false, loading: menuLoading })
const GetFunds = dynamic(() => loadGetFunds().then(module => module.GetFunds), { ssr: false, loading: menuLoading })

/** Inline "View as…" prompt: an address or ENS name turns on view-as mode. */
export function WalletButton() {
  const { isConnected, address, openSignIn, disconnect } = useWallet()
  const { viewAs, clearViewAs } = useViewAs()
  const [menuOpen, setMenuOpen] = useState(false)
  const [viewAsOpen, setViewAsOpen] = useState(false)
  const [mounted, setMounted] = useState(false)
  const [signingOut, setSigningOut] = useState(false)
  const [signOutError, setSignOutError] = useState<string>()
  const menuRef = useRef<HTMLDivElement>(null)
  const pathname = usePathname()
  const { chainId: connectedChainId } = useAccount()
  const routeSegment = projectRouteSegmentFromPathname(pathname) ?? ''
  const parsedRouteProject = parseUrn(routeSegment)
  const routeHandle = useProjectHandleFromRoute(routeSegment)?.handle ?? null
  const resolvedRouteProject = useResolvedProjectRoute()
  const routeProject =
    parsedRouteProject ??
    (routeHandle && resolvedRouteProject?.handle === routeHandle
      ? resolvedRouteProject
      : null)
  const balanceChainId =
    routeProject?.chainId ?? (connectedChainId as JBChainId | undefined)

  // Wallet state only exists client-side; render the signed-out shell on the
  // server so hydration always matches.
  useEffect(() => setMounted(true), [])

  const closeMenu = () => {
    setMenuOpen(false)
    setViewAsOpen(false)
  }

  useOutsideClose(menuRef, closeMenu, menuOpen)

  const connected = mounted && isConnected && !!address
  const activeViewAs = mounted ? viewAs : null
  // While view-as is active, "View account" follows the impersonated account.
  const accountAddress = activeViewAs ?? address

  const viewAsItem = (
    <button
      onClick={() => setViewAsOpen(open => !open)}
      aria-expanded={viewAsOpen}
      className="block w-full px-4 py-3 text-left text-sm font-medium text-ink hover:bg-smoke-25"
    >
      View as…
      <span className="block text-xs font-normal text-smoke-700">
        Browse the site as any address
      </span>
    </button>
  )

  return (
    <div className="relative" ref={menuRef}>
      {activeViewAs ? (
        <button
          onClick={() => setMenuOpen(o => !o)}
          onMouseEnter={preloadMenu}
          onFocus={preloadMenu}
          onTouchStart={preloadMenu}
          aria-expanded={menuOpen}
          className="flex min-h-[44px] items-center gap-2 whitespace-nowrap rounded-lg border border-amber-400 bg-amber-100 px-4 text-sm font-medium text-amber-900 hover:bg-amber-200"
        >
          <span className="h-2 w-2 rounded-full bg-amber-500" />
          <span className="hidden sm:inline">Viewing as</span>
          <AddressLabel address={activeViewAs} />
        </button>
      ) : connected ? (
        <button
          onClick={() => setMenuOpen(o => !o)}
          onMouseEnter={preloadMenu}
          onFocus={preloadMenu}
          onTouchStart={preloadMenu}
          aria-expanded={menuOpen}
          className="btn-secondary flex min-h-[44px] items-center gap-2 whitespace-nowrap px-4 py-1.5 text-sm"
        >
          {/* The state is the headline; which account is the detail. The dot belongs to the
              headline, so it sits on that line rather than centred against both. */}
          <span className="flex flex-col items-start leading-tight">
            <span className="flex items-center gap-2 font-medium">
              <span className="h-2 w-2 shrink-0 rounded-full bg-melon-500" />
              Signed in
            </span>
            <span className="pl-4 text-[11px] font-normal text-smoke-600">
              <AddressLabel address={address} />
            </span>
          </span>
        </button>
      ) : (
        // The sheet now carries every way in — email, phone, socials, wallets —
        // so a menu in front of it would only ask which door to use twice.
        <div className="flex items-center gap-3">
          <button
            onClick={openSignIn}
            // Fetch Para's runtime as the pointer arrives, so the click has
            // nothing left to wait for.
            onMouseEnter={preloadParaHost}
            onFocus={preloadParaHost}
            onTouchStart={preloadParaHost}
            className="btn-primary min-h-[44px] whitespace-nowrap px-5 text-sm"
          >
            Sign in
          </button>
        </div>
      )}

      {menuOpen ? (
        <div className="card absolute right-0 top-full z-50 mt-2 w-60 overflow-hidden py-1.5 shadow-[0_12px_32px_rgba(32,30,26,0.12)]">
          {viewAsOpen ? (
            <ViewAsForm onDone={closeMenu} />
          ) : activeViewAs ? (
            <>
              {accountAddress && balanceChainId ? (
                <WalletBalances
                  address={accountAddress}
                  chainId={balanceChainId}
                  projectId={routeProject?.projectId}
                />
              ) : null}
              <Link
                href={`/account/${activeViewAs}`}
                onClick={closeMenu}
                className="block w-full px-4 py-3 text-left text-sm font-medium text-ink hover:bg-smoke-25"
              >
                View account
              </Link>
              <div className="mx-4 my-1 border-t border-smoke-200" />
              <button
                onClick={() => {
                  closeMenu()
                  clearViewAs()
                }}
                className="block w-full px-4 py-3 text-left text-sm font-medium text-amber-800 hover:bg-amber-50"
              >
                {connected ? 'View as connected wallet' : 'Exit View as'}
              </button>
              <div className="mx-4 my-1 border-t border-smoke-200" />
              {viewAsItem}
            </>
          ) : connected ? (
            <>
              {accountAddress && balanceChainId ? (
                <WalletBalances
                  address={accountAddress}
                  chainId={balanceChainId}
                  projectId={routeProject?.projectId}
                />
              ) : null}
              <Link
                href={`/account/${accountAddress}`}
                onClick={closeMenu}
                className="block w-full px-4 py-3 text-left text-sm font-medium text-ink hover:bg-smoke-25"
              >
                View account
              </Link>
              {/* One entry, not one per asset: both ride the same networks, so two rows would
                  always appear and disappear together, and the provider asks which anyway. */}
              {balanceChainId ? (
                <GetFunds
                  symbol="ETH"
                  label="Get ETH and USDC"
                  chainId={balanceChainId}
                  onNavigate={closeMenu}
                  className="block w-full px-4 py-3 text-left text-sm font-medium text-ink no-underline hover:bg-smoke-25"
                />
              ) : null}
              <div className="mx-4 my-1 border-t border-smoke-200" />
              <button
                disabled={signingOut}
                onClick={() => {
                  setSignOutError(undefined)
                  setSigningOut(true)
                  void disconnect()
                    .then(closeMenu)
                    .catch((error: unknown) => setSignOutError(
                      error instanceof ParaSessionLogoutError || error instanceof ParaLocalDisconnectError
                        ? error.message : 'The wallet could not sign out. Try again.',
                    ))
                    .finally(() => setSigningOut(false))
                }}
                className="block w-full px-4 py-3 text-left text-sm font-medium text-ink hover:bg-smoke-25 disabled:opacity-50"
              >
                {signingOut ? 'Signing out…' : 'Sign out'}
              </button>
              {signOutError ? <p role="alert" className="px-4 py-2 text-xs text-red-700">{signOutError}</p> : null}
              <div className="mx-4 my-1 border-t border-smoke-200" />
              {viewAsItem}
            </>
          ) : (
            // Signing in is the button's own job now; the only thing left that
            // needs a surface here is impersonation.
            <ViewAsForm onDone={closeMenu} />
          )}
        </div>
      ) : null}
    </div>
  )
}
