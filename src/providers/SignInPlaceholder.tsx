'use client'

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

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
export function SignInPlaceholder() {
  const [host, setHost] = useState<HTMLDialogElement | null>(null)

  useEffect(() => {
    const node = document.createElement('dialog')
    node.className = 'ui-modal-host'
    document.body.append(node)
    node.showModal()
    setHost(node)
    return () => node.remove()
  }, [])

  if (!host) return null

  return createPortal(
    <div className="flex h-full w-full items-center justify-center overflow-y-auto bg-slate-900/55 p-6">
      <div className="card w-full max-w-sm p-6" aria-busy="true">
        <h2 className="font-agrandir text-2xl font-medium text-ink">Sign in</h2>
        <p className="mt-1 text-sm text-smoke-700">You will receive a code.</p>
        <div className="input-well mt-5 h-[46px] w-full animate-pulse bg-smoke-25" />
        <div className="mt-3 flex justify-end">
          <div className="h-10 w-24 animate-pulse rounded-lg bg-smoke-100" />
        </div>
        <div className="mt-5 h-3 w-16 animate-pulse rounded bg-smoke-100" />
        <div className="mt-2 flex flex-wrap gap-1.5">
          {Array.from({ length: 7 }, (_, i) => (
            <div
              key={i}
              className="h-10 w-10 animate-pulse rounded-lg bg-smoke-100"
            />
          ))}
        </div>
      </div>
    </div>,
    host,
  )
}
