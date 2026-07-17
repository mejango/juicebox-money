'use client'

import { useEffect, useState, type ReactNode } from 'react'

export type TabDef = {
  /** Exact label shown on the tab button. */
  label: string
  /** Renders the tab's content. Tabs are lazy: first activation mounts it,
   *  after which it stays mounted (hidden) so reads don't re-fire. */
  content: ReactNode
}

/** URL-hash slug for a tab label (website/ parity: tabSlug). */
export function tabSlug(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * The project page's tab row + content area (website/ parity). Deep links
 * via the URL hash (#tab or #tab/subtab); lazy-mounts each tab on first
 * view and keeps it mounted after, like website/'s built{} cache.
 */
export function ProjectTabs({ tabs }: { tabs: TabDef[] }) {
  const [active, setActive] = useState(0)
  const [mounted, setMounted] = useState<Set<number>>(new Set([0]))

  // Resolve the initial tab from the URL hash, and follow hash changes
  // (back/forward navigation).
  useEffect(() => {
    const apply = () => {
      const slug = window.location.hash.replace('#', '').split('/')[0]
      if (!slug) return
      const i = tabs.findIndex(t => tabSlug(t.label) === slug)
      if (i >= 0) {
        setActive(i)
        setMounted(prev => (prev.has(i) ? prev : new Set(prev).add(i)))
      }
    }
    apply()
    window.addEventListener('hashchange', apply)
    return () => window.removeEventListener('hashchange', apply)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const activate = (i: number) => {
    setActive(i)
    setMounted(prev => (prev.has(i) ? prev : new Set(prev).add(i)))
    // Keep the hash shareable without adding history entries per click.
    window.history.replaceState(null, '', `#${tabSlug(tabs[i].label)}`)
  }

  return (
    <div>
      <div
        role="tablist"
        aria-label="Project sections"
        className="scrollbar-none -mx-1 flex gap-1 overflow-x-auto border-b border-smoke-200 px-1"
      >
        {tabs.map((tab, i) => (
          <button
            key={tab.label}
            role="tab"
            aria-selected={active === i}
            onClick={() => activate(i)}
            className={`min-h-[44px] shrink-0 whitespace-nowrap border-b-2 px-3.5 font-agrandir text-sm font-medium transition-colors ${
              active === i
                ? 'border-ink text-ink'
                : 'border-transparent text-smoke-500 hover:text-ink'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="pt-6">
        {tabs.map((tab, i) =>
          mounted.has(i) ? (
            <div key={tab.label} hidden={active !== i}>
              {tab.content}
            </div>
          ) : null,
        )}
      </div>
    </div>
  )
}

/** A subtab row used inside tabs (website/'s Owners/Tokens subtabs). */
export function SubTabs({ tabs }: { tabs: TabDef[] }) {
  const [active, setActive] = useState(0)
  const [mounted, setMounted] = useState<Set<number>>(new Set([0]))

  const activate = (i: number) => {
    setActive(i)
    setMounted(prev => (prev.has(i) ? prev : new Set(prev).add(i)))
  }

  return (
    <div>
      <div
        role="tablist"
        className="scrollbar-none flex gap-1.5 overflow-x-auto"
      >
        {tabs.map((tab, i) => (
          <button
            key={tab.label}
            role="tab"
            aria-selected={active === i}
            onClick={() => activate(i)}
            className={`min-h-[36px] shrink-0 whitespace-nowrap rounded-full px-3.5 text-xs font-medium transition-colors ${
              active === i
                ? 'bg-split-100 text-ink ring-1 ring-ink'
                : 'border border-smoke-300 bg-white text-smoke-700 hover:border-smoke-400 hover:text-ink'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="pt-4">
        {tabs.map((tab, i) =>
          mounted.has(i) ? (
            <div key={tab.label} hidden={active !== i}>
              {tab.content}
            </div>
          ) : null,
        )}
      </div>
    </div>
  )
}
