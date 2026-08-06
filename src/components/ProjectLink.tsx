'use client'

import Link from 'next/link'
import type { ComponentProps } from 'react'
import {
  rememberProjectNavigation,
  type ProjectNavigationHint,
} from '@/lib/project-navigation'

type Props = ComponentProps<typeof Link> & {
  projectHint: ProjectNavigationHint
}

/** A normal Next link which makes already-visible project identity reusable. */
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
    if (typeof href === 'string') rememberProjectNavigation(href, projectHint)
  }

  return (
    <Link
      {...props}
      href={href}
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
