'use client'

import { useEffect, useId, useState } from 'react'
import { isAddress } from 'viem'
import { looksLikeEns, lookupEnsAddress, lookupEnsName } from '@/lib/ens'

type Note = { kind: 'ok' | 'bad'; text: string; copy?: string }

function ResolutionNote({ note, id }: { note: Note; id: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1200)
    return () => clearTimeout(t)
  }, [copied])

  if (note.kind === 'bad') {
    return (
      <p id={id} className="field-error mt-0.5 truncate pl-1 text-[11px]">
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

const projectNameCache = new Map<string, string | null>()

/** Project-id input that resolves the project's name beneath it. */
export function ProjectIdField({
  value,
  onChange,
  disabled,
  chainId,
  className = '',
}: {
  value: string
  onChange: (value: string) => void
  disabled: boolean
  /** Chain to resolve the name on (ids differ per chain). */
  chainId: number
  className?: string
}) {
  const [note, setNote] = useState<Note | null>(null)
  const noteId = useId()

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
      const key = `${chainId}:${id}`
      let name = projectNameCache.get(key)
      if (name === undefined) {
        try {
          const res = await fetch(
            `/api/project-name?chainId=${chainId}&projectId=${id}`,
          )
          const json = (await res.json()) as { name?: string | null }
          name = json.name ?? null
        } catch {
          name = null
        }
        projectNameCache.set(key, name)
      }
      if (stale) return
      setNote(
        name
          ? { kind: 'ok', text: `→ ${name}` }
          : { kind: 'bad', text: 'No project found' },
      )
    }, 400)
    return () => {
      stale = true
      clearTimeout(t)
    }
  }, [value, chainId])

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
