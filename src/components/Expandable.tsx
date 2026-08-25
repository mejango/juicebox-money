'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'

/**
 * Clamps tall content to `maxHeight` px with a fade and a "Read more" toggle.
 * The toggle only appears once the content is measured to actually overflow,
 * so short content renders untouched.
 */
export function Expandable({
  children,
  maxHeight = 320,
  className = '',
}: {
  children: ReactNode
  maxHeight?: number
  className?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [overflows, setOverflows] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => setOverflows(el.scrollHeight > maxHeight + 8)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [maxHeight])

  const clamped = overflows && !open
  return (
    <div className={className}>
      <div
        ref={ref}
        className="relative overflow-hidden"
        style={clamped ? { maxHeight } : undefined}
      >
        {children}
        {clamped ? (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-white to-transparent"
          />
        ) : null}
      </div>
      {overflows ? (
        <button
          type="button"
          onClick={() => setOpen(v => !v)}
          className="mt-2 text-sm font-medium text-bluebs-600 underline underline-offset-2 hover:text-bluebs-700"
        >
          {open ? 'Show less' : 'Read more'}
        </button>
      ) : null}
    </div>
  )
}
