'use client'

import { usePathname } from 'next/navigation'
import { useEffect, useRef } from 'react'

/**
 * Start a newly opened page at the top.
 *
 * The App Router's own scroll handling loses to this app's streamed pages:
 * clicking a project from halfway down the homepage lands you halfway down the
 * project. This puts it back deterministically.
 *
 * Two cases are deliberately left alone:
 * - back/forward, where the browser restores where you were and should win;
 * - the first render, so a reload keeps its restored position.
 */
export function ScrollToTop() {
  const pathname = usePathname()
  const isFirstRender = useRef(true)
  const cameFromHistory = useRef(false)

  useEffect(() => {
    const markHistoryNavigation = () => {
      cameFromHistory.current = true
    }
    window.addEventListener('popstate', markHistoryNavigation)
    return () => window.removeEventListener('popstate', markHistoryNavigation)
  }, [])

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false
      return
    }
    if (cameFromHistory.current) {
      cameFromHistory.current = false
      return
    }
    // Jump, never glide: an animated scroll on every navigation reads as lag.
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' })
  }, [pathname])

  return null
}
