'use client'

import { identityGradient } from '@/components/ActivityList'
import { AddressLabel } from '@/components/ui/AddressLabel'
import { useViewAs } from '@/lib/viewAs'

/**
 * The unmissable site-wide strip while "View as" is active: who the site is
 * being viewed as, and the way out. Writes are refused at the seams while
 * this is up — the banner is the constant reminder of why.
 */
export function ViewAsBanner() {
  const { viewAs, clearViewAs } = useViewAs()
  if (!viewAs) return null

  return (
    <div className="border-b border-amber-300 bg-amber-100 px-4 py-2 text-amber-900">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3">
        <p className="flex min-w-0 items-center gap-2 text-sm">
          <span
            aria-hidden="true"
            className="h-2.5 w-2.5 shrink-0 rounded-full"
            style={{ background: identityGradient(viewAs.toLowerCase()) }}
          />
          <span className="truncate">
            Viewing as <AddressLabel address={viewAs} className="font-medium" />{' '}
            — transactions are disabled.
          </span>
        </p>
        <button
          onClick={clearViewAs}
          className="shrink-0 rounded-lg border border-amber-400 px-3 py-1 text-sm font-medium hover:bg-amber-200"
        >
          Exit
        </button>
      </div>
    </div>
  )
}
