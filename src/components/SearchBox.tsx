'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { isAddress, type Address } from 'viem'
import { useOutsideClose } from '@/hooks/useOutsideClose'
import { looksLikeEns, lookupEnsAddress } from '@/lib/ens'
import { truncateAddress } from '@/lib/format'
import { ChainIcon } from '@/components/ChainIcon'
import { identityGradient } from '@/lib/identityGradient'
import { parseUrn, toUrn, chainName } from '@/lib/urn'
import {
  rememberProjectNavigation,
  type ProjectNavigationHint,
} from '@/lib/project-navigation'
import { ProjectLogo } from './ProjectLogo'
import { AddressLabel } from './ui/AddressLabel'

type AccountResult = { address: Address; ensName: string | null }

type Result = {
  projectId: number
  chainId: number
  name: string | null
  logoUri: string | null
  projectTagline: string | null
  ticker: string | null
  chainIds: number[]
}

function MagnifierIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      className={className}
      aria-hidden
    >
      <circle cx="9" cy="9" r="5.5" />
      <path d="m13.5 13.5 3.5 3.5" />
    </svg>
  )
}

export function SearchBox({
  expanded = false,
  placeholder = 'Search projects',
  compactPlaceholder,
  onFocusChange,
}: {
  expanded?: boolean
  placeholder?: string
  compactPlaceholder?: string
  onFocusChange?: (focused: boolean) => void
}) {
  const router = useRouter()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Result[]>([])
  const [account, setAccount] = useState<AccountResult | null>(null)
  const [ensPending, setEnsPending] = useState(false)
  // Search backend unreachable — say so rather than letting it read as "no matches".
  const [searchUnavailable, setSearchUnavailable] = useState(false)
  const [open, setOpen] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [placeholderFits, setPlaceholderFits] = useState(true)
  const boxRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  const urn = parseUrn(query.trim())

  // The navigation lets this field absorb the available space between the
  // logo and wallet control. Keep the descriptive placeholder while it fits,
  // then fall back to its compact form instead of clipping it.
  useEffect(() => {
    const input = inputRef.current
    if (!input || !compactPlaceholder) return
    const context = input.ownerDocument.createElement('canvas').getContext('2d')
    if (!context) return

    let active = true
    const measure = () => {
      if (!active) return
      const styles = window.getComputedStyle(input)
      const availableWidth =
        input.clientWidth -
        (Number.parseFloat(styles.paddingLeft) || 0) -
        (Number.parseFloat(styles.paddingRight) || 0)
      context.font = styles.font
      setPlaceholderFits(context.measureText(placeholder).width <= availableWidth)
    }

    measure()
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(measure)
    observer?.observe(input)
    if (!observer) window.addEventListener('resize', measure)
    void input.ownerDocument.fonts?.ready.then(measure)

    return () => {
      active = false
      observer?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [compactPlaceholder, placeholder])

  // Debounced free-text search against bendystraw (via our API route).
  useEffect(() => {
    const text = query.trim()
    if (urn || (text.length < 2 && !/^\d+$/.test(text))) {
      setResults([])
      setSearchUnavailable(false)
      return
    }
    const t = setTimeout(async () => {
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(text)}`, {
          signal: controller.signal,
        })
        if (!res.ok) {
          setSearchUnavailable(true)
          setOpen(true)
          return
        }
        const json = (await res.json()) as { projects: Result[] }
        setSearchUnavailable(false)
        setResults(json.projects)
        setOpen(true)
      } catch (reason) {
        // An abort is the next keystroke, not an outage — keep previous results.
        if ((reason as Error)?.name === 'AbortError') return
        setSearchUnavailable(true)
        setOpen(true)
      }
    }, 300)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query])

  // Account queries: a literal address matches immediately; a plausible ENS
  // name debounce-resolves, showing a pending row while it's in flight.
  useEffect(() => {
    const text = query.trim()
    if (isAddress(text)) {
      setAccount({ address: text, ensName: null })
      setEnsPending(false)
      setOpen(true)
      return
    }
    setAccount(null)
    if (!looksLikeEns(text)) {
      setEnsPending(false)
      return
    }
    setEnsPending(true)
    setOpen(true)
    let stale = false
    const t = setTimeout(async () => {
      const address = await lookupEnsAddress(text)
      if (stale) return
      setEnsPending(false)
      if (address) {
        setAccount({ address, ensName: text.toLowerCase() })
        setOpen(true)
      }
    }, 300)
    return () => {
      stale = true
      clearTimeout(t)
    }
  }, [query])

  // Close on outside pointer.
  useOutsideClose(boxRef, () => {
    setOpen(false)
    setMobileOpen(false)
  })

  const go = (path: string, projectHint?: ProjectNavigationHint) => {
    if (projectHint) rememberProjectNavigation(path, projectHint)
    setOpen(false)
    setMobileOpen(false)
    setQuery('')
    setResults([])
    setAccount(null)
    setEnsPending(false)
    router.push(path)
  }

  // The route takes an ENS name as-is and resolves it server-side.
  const accountPath = account
    ? `/account/${account.ensName ?? account.address}`
    : null

  const submit = () => {
    if (urn) go(`/${toUrn(urn.chainId, urn.projectId)}`)
    else if (accountPath) go(accountPath)
    else if (results.length > 0)
      go(`/${toUrn(results[0].chainId, results[0].projectId)}`, {
        name: results[0].name ?? `Project ${results[0].projectId}`,
        logoUri: results[0].logoUri,
        tagline: results[0].projectTagline,
      })
  }

  const input = (
    <div className="relative w-full">
      <MagnifierIcon className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-smoke-500" />
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={e => setQuery(e.target.value)}
        onFocus={() =>
          (results.length > 0 || account || ensPending || searchUnavailable) &&
          setOpen(true)
        }
        onKeyDown={e => {
          if (e.key === 'Enter') submit()
          if (e.key === 'Escape') {
            setOpen(false)
            setMobileOpen(false)
          }
        }}
        placeholder={
          placeholderFits ? placeholder : (compactPlaceholder ?? placeholder)
        }
        aria-label="Search projects"
        className="input-well min-h-[44px] pl-10 pr-4 text-sm"
      />
      {open &&
      (results.length > 0 || urn || account || ensPending || searchUnavailable) ? (
        <ul className="card absolute left-0 right-0 top-full z-50 mt-2 max-h-96 overflow-auto py-1.5 shadow-[0_12px_32px_rgba(32,30,26,0.12)]">
          {ensPending && !account ? (
            <li className="px-4 py-2.5 text-xs text-smoke-500">
              Resolving {query.trim()}…
            </li>
          ) : null}
          {searchUnavailable && results.length === 0 ? (
            <li className="px-4 py-2.5 text-xs text-smoke-500">
              Project search is unavailable right now. Paste an address or
              project URL to keep going.
            </li>
          ) : null}
          {account && accountPath ? (
            <li>
              <button
                onClick={() => go(accountPath)}
                className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-smoke-25"
              >
                <span
                  aria-hidden="true"
                  className="h-8 w-8 shrink-0 rounded-full"
                  style={{
                    background: identityGradient(account.address.toLowerCase()),
                  }}
                />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-ink">
                    {account.ensName ?? (
                      <AddressLabel address={account.address} />
                    )}
                  </span>
                  <span className="flex items-center gap-1 text-xs text-smoke-700">
                    {account.ensName ? (
                      <>
                        <span>{truncateAddress(account.address)}</span>
                        <span aria-hidden>·</span>
                      </>
                    ) : null}
                    <span>View account →</span>
                  </span>
                </span>
              </button>
            </li>
          ) : null}
          {urn ? (
            <li>
              <button
                onClick={() => go(`/${toUrn(urn.chainId, urn.projectId)}`)}
                className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm text-ink hover:bg-smoke-25"
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <span>Go to project {urn.projectId} on</span>
                  <ChainIcon chainId={urn.chainId} size={16} />
                  {chainName(urn.chainId)}
                </span>
              </button>
            </li>
          ) : (
            results.map(r => (
              <li key={`${r.chainId}-${r.projectId}`}>
                <button
                  onClick={() =>
                    go(`/${toUrn(r.chainId, r.projectId)}`, {
                      name: r.name ?? `Project ${r.projectId}`,
                      logoUri: r.logoUri,
                      tagline: r.projectTagline,
                    })
                  }
                  className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-smoke-25"
                >
                  <ProjectLogo name={r.name} logoUri={r.logoUri} size={32} />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-ink">
                      {r.name ?? `Project ${r.projectId}`}
                    </span>
                    <span className="flex items-center gap-1 text-xs text-smoke-700">
                      {r.ticker ? <span>${r.ticker}</span> : null}
                      {r.ticker && r.chainIds.length > 0 ? (
                        <span aria-hidden>·</span>
                      ) : null}
                      {r.chainIds.map((id, i) => (
                        <span key={id} className="flex items-center gap-1">
                          <ChainIcon chainId={id} size={14} />
                          {i < r.chainIds.length - 1
                            ? `${chainName(id)},`
                            : chainName(id)}
                        </span>
                      ))}
                    </span>
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  )

  if (expanded) {
    return (
      <div
        ref={boxRef}
        className="relative w-full"
        onFocusCapture={() => onFocusChange?.(true)}
        onBlurCapture={event => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            onFocusChange?.(false)
          }
        }}
      >
        {input}
      </div>
    )
  }

  return (
    <div ref={boxRef} className="relative">
      <button
        onClick={() => setMobileOpen(o => !o)}
        aria-label="Search projects"
        aria-expanded={mobileOpen}
        className="icon-button"
      >
        <MagnifierIcon className="h-6 w-6" />
      </button>
      {mobileOpen ? (
        <div className="card absolute right-0 top-full z-50 mt-2 w-[min(24rem,calc(100vw-2rem))] p-3 shadow-lg">
          {input}
        </div>
      ) : null}
    </div>
  )
}
