'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'

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
 * The shared tab machinery both variants render: the tablist row and the
 * lazily-mounted panels. A tab's content mounts on first activation and then
 * stays mounted (hidden) so its reads don't re-fire; each variant passes its
 * own spacing classes.
 */
function TabShell({
  tabs,
  active,
  onSelect,
  listClassName,
  buttonClassName,
  panelClassName,
  ariaLabel,
}: {
  tabs: TabDef[]
  active: number
  onSelect: (index: number) => void
  listClassName: string
  buttonClassName: string
  panelClassName: string
  ariaLabel?: string
}) {
  // Every index that has ever been active stays mounted. Adding during
  // render is safe: it's idempotent and only ever grows the set.
  const mounted = useRef(new Set<number>())
  mounted.current.add(active)

  return (
    <div>
      <div role="tablist" aria-label={ariaLabel} className={listClassName}>
        {tabs.map((tab, i) => (
          <button
            key={tab.label}
            type="button"
            role="tab"
            aria-selected={active === i}
            onClick={() => onSelect(i)}
            className={`${buttonClassName} ${
              active === i
                ? 'border-ink text-ink'
                : 'border-transparent text-smoke-500 hover:text-ink'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className={panelClassName}>
        {tabs.map((tab, i) =>
          mounted.current.has(i) ? (
            <div key={tab.label} hidden={active !== i}>
              {tab.content}
            </div>
          ) : null,
        )}
      </div>
    </div>
  )
}

/**
 * The project page's tab row + content area (website/ parity). Deep links
 * via the URL hash (#tab or #tab/subtab); lazy-mounts each tab on first
 * view and keeps it mounted after, like website/'s built{} cache.
 */
export function ProjectTabs({ tabs }: { tabs: TabDef[] }) {
  const [active, setActive] = useState(0)
  const subtabByParent = useRef<Record<string, string>>({})

  // Resolve the initial tab from the URL hash, and follow hash changes
  // (back/forward navigation).
  useEffect(() => {
    const apply = () => {
      const [slug, child] = window.location.hash.replace('#', '').split('/')
      if (!slug) return
      if (child) subtabByParent.current[tabSlug(slug)] = tabSlug(child)
      else delete subtabByParent.current[tabSlug(slug)]
      const i = tabs.findIndex(t => tabSlug(t.label) === slug)
      if (i >= 0) setActive(i)
    }
    apply()
    window.addEventListener('hashchange', apply)
    return () => window.removeEventListener('hashchange', apply)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const activate = (i: number) => {
    const [currentParent, currentChild] = window.location.hash
      .replace('#', '')
      .split('/')
    if (currentParent && currentChild) {
      subtabByParent.current[tabSlug(currentParent)] = tabSlug(currentChild)
    }

    setActive(i)
    // Keep the hash shareable without adding history entries per click.
    const slug = tabSlug(tabs[i].label)
    const child = subtabByParent.current[slug]
    window.history.replaceState(
      null,
      '',
      `#${slug}${child ? `/${child}` : ''}`,
    )
  }

  return (
    <TabShell
      tabs={tabs}
      active={active}
      onSelect={activate}
      ariaLabel="Project sections"
      listClassName="scrollbar-none -mx-1 flex gap-1 overflow-x-auto border-b border-smoke-200 px-1"
      buttonClassName="min-h-[44px] shrink-0 whitespace-nowrap border-b-2 px-3.5 font-agrandir text-sm font-medium transition-colors"
      panelClassName="pt-6"
    />
  )
}

/**
 * A subtab row used inside project tabs. When `hashParent` is provided, the
 * second URL-hash segment selects and deep-links the subtab (`#shop/customers`).
 */
export function SubTabs({
  tabs,
  hashParent,
}: {
  tabs: TabDef[]
  hashParent?: string
}) {
  const [active, setActive] = useState(0)

  useEffect(() => {
    if (!hashParent) return
    const apply = () => {
      const [parent, child] = window.location.hash.replace('#', '').split('/')
      if (tabSlug(parent ?? '') !== tabSlug(hashParent)) return
      const i = child
        ? tabs.findIndex(tab => tabSlug(tab.label) === tabSlug(child))
        : 0
      if (i < 0) return
      setActive(i)
    }
    apply()
    window.addEventListener('hashchange', apply)
    return () => window.removeEventListener('hashchange', apply)
    // The tab definitions are stable for the mounted section; only their
    // labels are used here, and remounting re-runs this resolver.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hashParent])

  const activate = (i: number) => {
    setActive(i)
    if (hashParent) {
      window.history.replaceState(
        null,
        '',
        `#${tabSlug(hashParent)}/${tabSlug(tabs[i].label)}`,
      )
    }
  }

  return (
    <TabShell
      tabs={tabs}
      active={active}
      onSelect={activate}
      listClassName="scrollbar-none flex gap-6 overflow-x-auto border-b border-smoke-200"
      buttonClassName="min-h-[40px] shrink-0 whitespace-nowrap border-b-2 px-1 font-agrandir text-sm font-medium transition-colors"
      panelClassName="pt-4"
    />
  )
}
