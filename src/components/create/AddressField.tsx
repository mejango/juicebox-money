'use client'

import { useEffect, useId, useState } from 'react'
import { isAddress } from 'viem'
import { looksLikeEns, lookupEnsAddress, lookupEnsName } from '@/lib/ens'
import { chainName } from '@/lib/urn'

type Note = {
  kind: 'ok' | 'warn' | 'bad'
  text: string
  copy?: string
  full?: boolean
}

function ResolutionNote({ note, id }: { note: Note; id: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1200)
    return () => clearTimeout(t)
  }, [copied])

  if (note.kind === 'bad') {
    return (
      <p
        id={id}
        className={`field-error mt-0.5 pl-1 text-[11px] ${
          note.full
            ? 'w-72 max-w-[80vw] leading-relaxed'
            : 'truncate'
        }`}
      >
        {note.text}
      </p>
    )
  }
  if (note.kind === 'warn') {
    return (
      <p
        id={id}
        className="mt-0.5 w-72 max-w-[80vw] pl-1 text-[11px] leading-relaxed text-amber-700"
      >
        {note.text}
      </p>
    )
  }
  if (!note.copy) {
    return (
      <p id={id} className="field-hint mt-0.5 truncate pl-1 text-[11px]">
        {note.text}
      </p>
    )
  }
  return (
    <button
      id={id}
      onClick={() => {
        void navigator.clipboard.writeText(note.copy!)
        setCopied(true)
      }}
      title={`Copy ${note.copy}`}
      className="mt-0.5 block max-w-full truncate pl-1 text-left text-[11px] text-smoke-500 hover:text-ink hover:underline"
    >
      {copied ? 'Copied!' : note.text}
    </button>
  )
}

/**
 * Address input that resolves ENS both ways: type a name and the address
 * appears beneath (click it to copy the full address); paste an address and
 * its primary name appears beneath. Validation elsewhere reads the sync
 * cache (resolvedAddress), which the lookups here fill.
 */
export function AddressField({
  value,
  onChange,
  disabled,
  placeholder = '0x… or name.eth',
  ariaLabel = 'Address',
  className = '',
  compact = false,
}: {
  value: string
  onChange: (value: string) => void
  disabled: boolean
  placeholder?: string
  ariaLabel?: string
  className?: string
  compact?: boolean
}) {
  const [note, setNote] = useState<Note | null>(null)
  const noteId = useId()

  useEffect(() => {
    const v = value.trim()
    setNote(null)
    if (!v) return
    let stale = false
    const t = setTimeout(async () => {
      if (isAddress(v)) {
        const name = await lookupEnsName(v)
        if (!stale && name) setNote({ kind: 'ok', text: `→ ${name}` })
      } else if (looksLikeEns(v)) {
        const address = await lookupEnsAddress(v)
        if (stale) return
        setNote(
          address
            ? { kind: 'ok', text: `→ ${address}`, copy: address }
            : { kind: 'bad', text: 'Name not found' },
        )
      } else {
        if (!stale) setNote({ kind: 'bad', text: 'Not a valid address' })
      }
    }, 400)
    return () => {
      stale = true
      clearTimeout(t)
    }
  }, [value])

  return (
    <div className={`min-w-0 ${className}`}>
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value.trim().slice(0, 64))}
        disabled={disabled}
        placeholder={placeholder}
        aria-label={ariaLabel}
        aria-invalid={note?.kind === 'bad'}
        aria-describedby={note ? noteId : undefined}
        className={`input-well w-full font-mono text-xs disabled:opacity-60 ${
          compact ? 'min-h-[40px] px-3' : 'min-h-[44px] px-3'
        } ${note?.kind === 'bad' ? '!border-red-400' : ''}`}
      />
      {note ? <ResolutionNote note={note} id={noteId} /> : null}
    </div>
  )
}

export type ProjectChainLookup = {
  chainId: number
  found: boolean
  name: string | null
  suckerGroupId: string | null
}

const projectLookupCache = new Map<string, ProjectChainLookup>()

/** Turn exact-chain project reads into one actionable field message. */
export function projectLookupNote(
  projectId: number,
  chainIds: readonly number[],
  lookups: readonly ProjectChainLookup[],
): Note {
  const selected = [...new Set(chainIds)]
  const found = selected
    .map(chainId => lookups.find(result => result.chainId === chainId))
    .filter((result): result is ProjectChainLookup => Boolean(result?.found))

  if (found.length === 0) {
    return {
      kind: 'bad',
      text: `No project #${projectId} found on the selected ${selected.length === 1 ? 'chain' : 'chains'}`,
      full: true,
    }
  }

  const label = found.find(result => result.name)?.name ?? `Project #${projectId}`
  if (selected.length === 1) return { kind: 'ok', text: `→ ${label}` }

  if (found.length < selected.length) {
    return {
      kind: 'warn',
      text: `→ ${label} found on ${found.map(result => chainName(result.chainId)).join(', ')} only — set per-chain project IDs for the other selected chains`,
    }
  }

  const groups = new Set(
    found.map(result => result.suckerGroupId).filter(Boolean),
  )
  if (
    groups.size !== 1 ||
    found.some(result => result.suckerGroupId === null)
  ) {
    return {
      kind: 'warn',
      text: `→ Project #${projectId} exists on every selected chain, but the deployments aren't linked — confirm each per-chain project ID`,
    }
  }

  return { kind: 'ok', text: `→ ${label} on all selected chains` }
}

/** Project-id input that resolves the project's name beneath it. */
export function ProjectIdField({
  value,
  onChange,
  disabled,
  chainIds,
  className = '',
}: {
  value: string
  onChange: (value: string) => void
  disabled: boolean
  /** Selected chains to resolve on (project ids can differ per chain). */
  chainIds: readonly number[]
  className?: string
}) {
  const [note, setNote] = useState<Note | null>(null)
  const noteId = useId()
  const chainKey = [...new Set(chainIds)].sort((a, b) => a - b).join(',')

  useEffect(() => {
    const id = Number(value.trim().replace('#', ''))
    setNote(null)
    if (!value.trim()) return
    if (!Number.isInteger(id) || id < 1) {
      setNote({ kind: 'bad', text: 'Not a valid project id' })
      return
    }
    let stale = false
    const t = setTimeout(async () => {
      const selectedChains = chainKey
        .split(',')
        .map(Number)
        .filter(chainId => Number.isSafeInteger(chainId) && chainId > 0)
      const lookups = await Promise.all(
        selectedChains.map(async chainId => {
          const key = `${chainId}:${id}`
          const cached = projectLookupCache.get(key)
          if (cached) return cached
          let result: ProjectChainLookup
          try {
            const res = await fetch(
              `/api/project-name?chainId=${chainId}&projectId=${id}`,
            )
            const json = (await res.json()) as {
              found?: boolean
              name?: string | null
              suckerGroupId?: string | null
            }
            result = {
              chainId,
              found: res.ok && json.found === true,
              name: json.name ?? null,
              suckerGroupId: json.suckerGroupId ?? null,
            }
          } catch {
            result = { chainId, found: false, name: null, suckerGroupId: null }
          }
          // Positive identity reads are stable. Retry misses next time so a
          // just-launched project or brief indexer/RPC outage can recover.
          if (result.found) projectLookupCache.set(key, result)
          return result
        }),
      )
      if (stale) return
      setNote(projectLookupNote(id, selectedChains, lookups))
    }, 400)
    return () => {
      stale = true
      clearTimeout(t)
    }
  }, [value, chainKey])

  return (
    <div className={`min-w-0 ${className}`}>
      <input
        type="text"
        inputMode="numeric"
        value={value}
        onChange={e => onChange(e.target.value.trim().slice(0, 11))}
        disabled={disabled}
        placeholder="#12"
        aria-label="Project id"
        aria-invalid={note?.kind === 'bad'}
        aria-describedby={note ? noteId : undefined}
        className={`input-well min-h-[44px] w-full px-3 text-sm tabular-nums disabled:opacity-60 ${
          note?.kind === 'bad' ? '!border-red-400' : ''
        }`}
      />
      {note ? <ResolutionNote note={note} id={noteId} /> : null}
    </div>
  )
}
