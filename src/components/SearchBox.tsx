'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { useOutsideClose } from '@/hooks/useOutsideClose'
import { parseUrn, toUrn, chainName } from '@/lib/urn'
import { ProjectLogo } from './ProjectLogo'

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

export function SearchBox({ expanded = false }: { expanded?: boolean }) {
  const router = useRouter()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Result[]>([])
  const [open, setOpen] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  const urn = parseUrn(query.trim())

  // Debounced free-text search against bendystraw (via our API route).
  useEffect(() => {
    const text = query.trim()
    if (urn || (text.length < 2 && !/^\d+$/.test(text))) {
      setResults([])
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
        if (!res.ok) return
        const json = (await res.json()) as { projects: Result[] }
        setResults(json.projects)
        setOpen(true)
      } catch {
        /* aborted or offline — keep previous results */
      }
    }, 300)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query])

  // Close on outside pointer.
  useOutsideClose(boxRef, () => {
    setOpen(false)
    setMobileOpen(false)
  })

  const go = (path: string) => {
    setOpen(false)
    setMobileOpen(false)
    setQuery('')
    setResults([])
    router.push(path)
  }

  const submit = () => {
    if (urn) go(`/${toUrn(urn.chainId, urn.projectId)}`)
    else if (results.length > 0)
      go(`/${toUrn(results[0].chainId, results[0].projectId)}`)
  }

  const input = (
    <div className="relative w-full">
      <MagnifierIcon className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-smoke-500" />
      <input
        type="text"
        value={query}
        onChange={e => setQuery(e.target.value)}
        onFocus={() => results.length > 0 && setOpen(true)}
        onKeyDown={e => {
          if (e.key === 'Enter') submit()
          if (e.key === 'Escape') {
            setOpen(false)
            setMobileOpen(false)
          }
        }}
        placeholder="Search projects"
        aria-label="Search projects"
        className="input-well min-h-[44px] pl-10 pr-4 text-sm"
      />
      {(open && results.length > 0) || (open && urn) ? (
        <ul className="card absolute left-0 right-0 top-full z-50 mt-2 max-h-96 overflow-auto py-1.5 shadow-[0_12px_32px_rgba(32,30,26,0.12)]">
          {urn ? (
            <li>
              <button
                onClick={() => go(`/${toUrn(urn.chainId, urn.projectId)}`)}
                className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm text-ink hover:bg-smoke-25"
              >
                Go to project {urn.projectId} on {chainName(urn.chainId)}
              </button>
            </li>
          ) : (
            results.map(r => (
              <li key={`${r.chainId}-${r.projectId}`}>
                <button
                  onClick={() => go(`/${toUrn(r.chainId, r.projectId)}`)}
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
                      <span>
                        {r.chainIds.map(chainName).join(', ')}
                      </span>
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
      <div ref={boxRef} className="relative w-full">
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
