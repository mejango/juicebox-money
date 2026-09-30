'use client'

import Link from 'next/link'
import type { ComponentProps } from 'react'
import {
  rememberProjectNavigation,
  type ProjectNavigationHint,
} from '@/lib/project-navigation'

type Props = Omit<ComponentProps<typeof Link>, 'prefetch'> & {
  projectHint?: ProjectNavigationHint
}

/**
 * A Next link to a project route. Given a hint, it makes already-visible
 * project identity reusable.
 *
 * It never prefetches: once more than four links to a dynamic route whose
 * segment holds a `:` (every `chain:id` project URN) are in view, Next's
 * prefetcher requests those routes again without end.
 */
export function ProjectLink({
  href,
  projectHint,
  onClick,
  onFocus,
  onPointerEnter,
  onPointerDown,
  ...props
}: Props) {
  const remember = () => {
    if (projectHint && typeof href === 'string') {
      rememberProjectNavigation(href, projectHint)
    }
  }

  return (
    <Link
      {...props}
      href={href}
      prefetch={false}
      onPointerEnter={event => {
        remember()
        onPointerEnter?.(event)
      }}
      onPointerDown={event => {
        remember()
        onPointerDown?.(event)
      }}
      onFocus={event => {
        remember()
        onFocus?.(event)
      }}
      onClick={event => {
        remember()
        onClick?.(event)
      }}
    />
  )
}
