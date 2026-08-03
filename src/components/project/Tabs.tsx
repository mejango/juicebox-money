'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'

export type TabDef = {
  /** Exact label shown on the tab button. */
  label: string
  /** Renders the tab's content. Tabs are lazy: first activation mounts it,
   *  after which it stays mounted (hidden) so reads don't re-fire. */
  content: ReactNode
}

const PROJECT_OVERFLOW_TABS = new Set(['extras', 'operator', 'owner'])

/** URL-hash slug for a tab label (website/ parity: tabSlug). */
export function tabSlug(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * The shared tab machinery every variant renders (SubTabs here, AccountTabs
 * on the account view): the tablist row and the lazily-mounted panels. A
 * tab's content mounts on first activation and then stays mounted (hidden)
 * so its reads don't re-fire; each variant passes its own spacing classes.
 */
export function TabShell({
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
export function ProjectTabs({
  tabs,
  sidebar,
  activity,
}: {
  tabs: TabDef[]
  sidebar: ReactNode
  activity: ReactNode
}) {
  const firstSlug = tabSlug(tabs[0]?.label ?? '')
  const activitySlug = tabSlug('Activity')
  const [activeSlug, setActiveSlug] = useState(firstSlug)
  const [isPhone, setIsPhone] = useState(false)
  const subtabByParent = useRef<Record<string, string>>({})
  const mounted = useRef(new Set<string>())

  const normalActiveSlug = tabs.some(
    tab => tabSlug(tab.label) === activeSlug,
  )
    ? activeSlug
    : firstSlug
  const activityActive = isPhone && activeSlug === activitySlug
  const visibleTabs = tabs.filter(
    tab => !PROJECT_OVERFLOW_TABS.has(tabSlug(tab.label)),
  )
  const overflowTabs = tabs.filter(tab =>
    PROJECT_OVERFLOW_TABS.has(tabSlug(tab.label)),
  )
  mounted.current.add(normalActiveSlug)

  // Resolve the initial tab from the URL hash, and follow hash changes
  // (back/forward navigation). Activity participates only at phone widths,
  // matching website/'s project-detail contract.
  useEffect(() => {
    const phoneQuery = window.matchMedia('(max-width: 600px)')
    const apply = () => {
      const [slug, child] = window.location.hash.replace('#', '').split('/')
      const phone = phoneQuery.matches
      setIsPhone(phone)

      if (slug) {
        const normalized = tabSlug(slug)
        if (child) subtabByParent.current[normalized] = tabSlug(child)
        else delete subtabByParent.current[normalized]

        if (phone && normalized === activitySlug) {
          setActiveSlug(activitySlug)
          return
        }
        const tab = tabs.find(t => tabSlug(t.label) === normalized)
        if (tab) {
          setActiveSlug(tabSlug(tab.label))
          return
        }
      }

      setActiveSlug(phone ? activitySlug : firstSlug)
    }
    apply()
    window.addEventListener('hashchange', apply)
    phoneQuery.addEventListener('change', apply)
    return () => {
      window.removeEventListener('hashchange', apply)
      phoneQuery.removeEventListener('change', apply)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const activate = (nextSlug: string) => {
    const [currentParent, currentChild] = window.location.hash
      .replace('#', '')
      .split('/')
    if (currentParent && currentChild) {
      subtabByParent.current[tabSlug(currentParent)] = tabSlug(currentChild)
    }

    setActiveSlug(nextSlug)
    // Keep the hash shareable without adding history entries per click.
    const child = subtabByParent.current[nextSlug]
    window.history.replaceState(
      null,
      '',
      `#${nextSlug}${child ? `/${child}` : ''}`,
    )
  }

  const buttonClasses = (selected: boolean) =>
    `min-h-[44px] shrink-0 whitespace-nowrap border-b-2 px-3.5 font-agrandir text-sm font-medium transition-colors ${
      selected
        ? 'border-ink text-ink'
        : 'border-transparent text-smoke-500 hover:text-ink'
    }`

  return (
    <div className="mt-10 flex flex-col min-[601px]:flex-row min-[601px]:gap-6 lg:gap-10">
      <aside className="contents min-[601px]:order-1 min-[601px]:flex min-[601px]:w-[280px] min-[601px]:shrink-0 min-[601px]:flex-col md:w-[320px] lg:w-[384px]">
        <div className="order-1 min-[601px]:order-none">{sidebar}</div>
        <div
          className={`order-3 ${
            activityActive ? 'block' : 'hidden'
          } pt-6 min-[601px]:order-none min-[601px]:block min-[601px]:pt-0`}
        >
          {activity}
        </div>
      </aside>

      <div className="contents min-[601px]:order-2 min-[601px]:block min-[601px]:min-w-0 min-[601px]:flex-1">
        <div className="order-2 -mx-1 mt-8 flex border-b border-smoke-200 px-1 min-[601px]:order-none min-[601px]:mt-0">
          <div
            role="tablist"
            aria-label="Project sections"
            className="scrollbar-none flex min-w-0 flex-1 gap-1 overflow-x-auto"
          >
            <button
              type="button"
              role="tab"
              aria-selected={activityActive}
              onClick={() => activate(activitySlug)}
              className={`${buttonClasses(activityActive)} min-[601px]:hidden`}
            >
              Activity
            </button>
            {visibleTabs.map(tab => {
              const slug = tabSlug(tab.label)
              const selected = !activityActive && normalActiveSlug === slug
              return (
                <button
                  key={tab.label}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  onClick={() => activate(slug)}
                  className={buttonClasses(selected)}
                >
                  {tab.label}
                </button>
              )
            })}
          </div>
          <ProjectOverflowMenu
            tabs={overflowTabs}
            activeSlug={activityActive ? activitySlug : normalActiveSlug}
            onSelect={activate}
          />
        </div>

        <div
          className={`order-4 pt-6 min-[601px]:order-none ${
            activityActive ? 'hidden' : 'block'
          }`}
        >
          {tabs.map(tab => {
            const slug = tabSlug(tab.label)
            return mounted.current.has(slug) ? (
              <div key={tab.label} hidden={normalActiveSlug !== slug}>
                {tab.content}
              </div>
            ) : null
          })}
        </div>
      </div>
    </div>
  )
}

function ProjectOverflowMenu({
  tabs,
  activeSlug,
  onSelect,
}: {
  tabs: TabDef[]
  activeSlug: string
  onSelect: (slug: string) => void
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const activeTab = tabs.find(tab => tabSlug(tab.label) === activeSlug)

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', closeOutside)
    return () => document.removeEventListener('mousedown', closeOutside)
  }, [open])

  if (!tabs.length) return null

  return (
    <div
      ref={root}
      className="relative ml-auto shrink-0"
      onKeyDown={event => {
        if (event.key !== 'Escape' || !open) return
        setOpen(false)
        root.current?.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')?.focus()
      }}
    >
      <button
        type="button"
        aria-label={`More project sections${activeTab ? `, current: ${activeTab.label}` : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(current => !current)}
        className={`flex min-h-[44px] min-w-[44px] items-center justify-center border-b-2 px-3 text-xl leading-none transition-colors ${
          activeTab
            ? 'border-ink text-ink'
            : 'border-transparent text-smoke-500 hover:text-ink'
        }`}
      >
        <span aria-hidden>⋮</span>
      </button>
      {open ? (
        <div
          role="menu"
          aria-label="More project sections"
          className="absolute right-0 top-full z-30 mt-1 min-w-36 overflow-hidden rounded-xl border border-smoke-200 bg-white py-1 shadow-lg"
        >
          {tabs.map(tab => {
            const slug = tabSlug(tab.label)
            const selected = slug === activeSlug
            return (
              <button
                key={tab.label}
                type="button"
                role="menuitem"
                aria-current={selected ? 'page' : undefined}
                onClick={() => {
                  onSelect(slug)
                  setOpen(false)
                  requestAnimationFrame(() =>
                    root.current
                      ?.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')
                      ?.focus(),
                  )
                }}
                className={`block min-h-[40px] w-full px-4 text-left text-sm transition-colors ${
                  selected
                    ? 'bg-split-50 font-medium text-ink'
                    : 'text-smoke-700 hover:bg-smoke-75 hover:text-ink'
                }`}
              >
                {tab.label}
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
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
