'use client'

import { useRef, useState } from 'react'

/**
 * The panel behind `ConceptTerm` and `ChartNoteTip`.
 *
 * These were native `title` attributes, which the browser holds back for about a second and
 * offers no way to speed up — long enough that the hover reads as doing nothing at all.
 *
 * Positioned `fixed` from the trigger's measured rect rather than absolutely inside it: these
 * sit in tables that scroll horizontally, which would clip an in-flow panel. Fixed also keeps
 * the panel inside whatever `<dialog>` rendered it, so it stays visible above the modal's
 * backdrop — a portal to `document.body` would be inert behind it.
 */
export function HoverNote({
  note,
  children,
  className = '',
  ...rest
}: {
  note: string
  children: React.ReactNode
  className?: string
} & React.HTMLAttributes<HTMLSpanElement>) {
  const trigger = useRef<HTMLSpanElement>(null)
  const [at, setAt] = useState<{ left: number; top: number } | null>(null)

  const show = () => {
    const box = trigger.current?.getBoundingClientRect()
    if (!box) return
    const width = Math.min(288, window.innerWidth - 16)
    setAt({
      // Centred on the trigger, then pulled back inside the viewport so a term near
      // either edge still shows its whole note.
      left: Math.min(
        Math.max(8, box.left + box.width / 2 - width / 2),
        window.innerWidth - width - 8,
      ),
      top: box.bottom + 8,
    })
  }

  return (
    <span
      ref={trigger}
      tabIndex={0}
      onPointerEnter={show}
      onPointerLeave={() => setAt(null)}
      onFocus={show}
      onBlur={() => setAt(null)}
      className={`relative cursor-help ${className}`}
      {...rest}
    >
      {children}
      {at ? (
        <span
          role="tooltip"
          style={{ left: at.left, top: at.top, width: Math.min(288, window.innerWidth - 16) }}
          className="pointer-events-none fixed z-50 rounded-md border border-smoke-200 bg-white px-3 py-2 text-left text-xs font-normal leading-relaxed text-ink shadow-lg"
        >
          {note}
        </span>
      ) : null}
    </span>
  )
}
