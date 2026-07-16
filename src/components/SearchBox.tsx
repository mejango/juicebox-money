'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { BsProject } from '@/lib/bendystraw'
import { parseUrn, toUrn, chainName } from '@/lib/urn'
import { ProjectLogo } from './ProjectLogo'

type Result = Pick<
  BsProject,
  'projectId' | 'chainId' | 'name' | 'logoUri' | 'projectTagline'
>

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

export function SearchBox() {
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
    if (urn || text.length < 2) {
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
  useEffect(() => {
    const close = (e: PointerEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) {
        setOpen(false)
        setMobileOpen(false)
      }
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [])

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
      <MagnifierIcon className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink/40" />
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
        placeholder="Search projects, or eth:1"
        aria-label="Search projects"
        className="min-h-[44px] w-full rounded-full border border-ink/15 bg-white pl-10 pr-4 text-sm outline-none transition-colors placeholder:text-ink/40 focus:border-juice-500 focus:ring-2 focus:ring-juice-400/30"
      />
      {(open && results.length > 0) || (open && urn) ? (
        <ul className="absolute left-0 right-0 top-full z-50 mt-2 max-h-96 overflow-auto rounded-2xl border border-ink/10 bg-white py-1.5 shadow-xl">
          {urn ? (
            <li>
              <button
                onClick={() => go(`/${toUrn(urn.chainId, urn.projectId)}`)}
                className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm hover:bg-juice-50"
              >
                Go to project {urn.projectId} on {chainName(urn.chainId)}
              </button>
            </li>
          ) : (
            results.map(r => (
              <li key={`${r.chainId}-${r.projectId}`}>
                <button
                  onClick={() => go(`/${toUrn(r.chainId, r.projectId)}`)}
                  className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-juice-50"
                >
                  <ProjectLogo name={r.name} logoUri={r.logoUri} size={32} />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold">
                      {r.name ?? `Project ${r.projectId}`}
                    </span>
                    <span className="block text-xs text-ink/50">
                      {chainName(r.chainId)}
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

  return (
    <div ref={boxRef} className="flex flex-1 justify-center sm:px-4">
      {/* Desktop / tablet: always-visible input. */}
      <div className="hidden w-full max-w-md sm:block">{input}</div>

      {/* Mobile: icon toggles a full-width row under the header. */}
      <div className="ml-auto sm:hidden">
        <button
          onClick={() => setMobileOpen(o => !o)}
          aria-label="Search"
          aria-expanded={mobileOpen}
          className="flex h-11 w-11 items-center justify-center rounded-full border border-ink/15 bg-white text-ink/70"
        >
          <MagnifierIcon className="h-5 w-5" />
        </button>
        {mobileOpen ? (
          <div className="absolute inset-x-0 top-full border-b border-ink/10 bg-cream px-4 py-3 shadow-sm">
            {input}
          </div>
        ) : null}
      </div>
    </div>
  )
}
