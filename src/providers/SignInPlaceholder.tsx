'use client'

import { useEffect, useLayoutEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { SignInShell } from './SignInShell'

/** Before paint, so the click is acknowledged in the frame it happened in. */
const useBeforePaint =
  typeof window === 'undefined' ? useEffect : useLayoutEffect

/**
 * Painted the instant sign-in is asked for, while Para's runtime downloads.
 *
 * That runtime is ~725 KiB gzipped and is deliberately not shipped to
 * anonymous visitors, so the first click has to fetch it — several seconds on
 * a slow connection. Rendering nothing until it lands makes the button feel
 * broken, so this stands in: the real sheet's opening, inert, in the same
 * frame, so the swap reads as filling in rather than as a jump.
 *
 * It owns a `showModal()` dialog for the same reason ParaModalHost does —
 * sign-in is reachable from inside other modals, and everything outside the
 * topmost one is inert.
 */
export function SignInPlaceholder({
  entry,
  onEntryChange,
}: {
  entry: string
  onEntryChange: (value: string) => void
}) {
  const [host] = useState<HTMLDialogElement | null>(() =>
    typeof document === 'undefined' ? null : document.createElement('dialog'),
  )

  useBeforePaint(() => {
    if (!host) return
    host.className = 'ui-modal-host'
    document.body.append(host)
    return () => host.remove()
  }, [host])

  // Opening is passive so this lands above any modal it was launched from,
  // which enters the top layer in its own passive effect.
  useEffect(() => {
    if (host && !host.open) host.showModal()
  }, [host])

  if (!host) return null

  return createPortal(
    <div className="flex h-full w-full items-center justify-center overflow-y-auto bg-slate-900/55 p-6">
      <div className="card w-full max-w-sm p-6">
        <SignInShell entry={entry} onEntryChange={onEntryChange} />
      </div>
    </div>,
    host,
  )
}
