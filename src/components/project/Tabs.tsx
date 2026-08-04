'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'

import {
  ProjectOverflowIcon,
  ProjectTabIcon,
} from '@/components/project/ProjectTabIcon'

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
 * Next patches history.replaceState and treats calls without its current
 * history payload as app-router navigation. Preserve that payload for
 * hash-only tab state so the mounted project shell never enters route loading.
 */
export function replaceTabHash(hash: string): void {
  window.history.replaceState(window.history.state, '', hash)
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
  const [isSingleColumn, setIsSingleColumn] = useState(false)
  const [overflowExpanded, setOverflowExpanded] = useState(false)
  const subtabByParent = useRef<Record<string, string>>({})
  const mounted = useRef(new Set<string>())

  const normalActiveSlug = tabs.some(
    tab => tabSlug(tab.label) === activeSlug,
  )
    ? activeSlug
    : firstSlug
  const activityActive = isSingleColumn && activeSlug === activitySlug
  const visibleTabs = tabs.filter(
    tab => !PROJECT_OVERFLOW_TABS.has(tabSlug(tab.label)),
  )
  const overflowTabs = tabs.filter(tab =>
    PROJECT_OVERFLOW_TABS.has(tabSlug(tab.label)),
  )
  mounted.current.add(normalActiveSlug)

  // Resolve the initial tab from the URL hash, and follow hash changes
  // (back/forward navigation). Activity participates whenever the project
  // shell is single-column.
  useEffect(() => {
    const singleColumnQuery = window.matchMedia('(max-width: 1279px)')
    const apply = () => {
      const [slug, child] = window.location.hash.replace('#', '').split('/')
      const singleColumn = singleColumnQuery.matches
      setIsSingleColumn(singleColumn)

      if (slug) {
        const normalized = tabSlug(slug)
        if (child) subtabByParent.current[normalized] = tabSlug(child)
        else delete subtabByParent.current[normalized]

        if (singleColumn && normalized === activitySlug) {
          setActiveSlug(activitySlug)
          return
        }
        const tab = tabs.find(t => tabSlug(t.label) === normalized)
        if (tab) {
          setActiveSlug(tabSlug(tab.label))
          return
        }
      }

      setActiveSlug(singleColumn ? activitySlug : firstSlug)
    }
    apply()
    window.addEventListener('hashchange', apply)
    singleColumnQuery.addEventListener('change', apply)
    return () => {
      window.removeEventListener('hashchange', apply)
      singleColumnQuery.removeEventListener('change', apply)
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
    replaceTabHash(`#${nextSlug}${child ? `/${child}` : ''}`)
  }

  const buttonClasses = (selected: boolean) =>
    `inline-flex min-h-[44px] shrink-0 items-center gap-2 whitespace-nowrap border-b-2 px-3.5 font-agrandir text-sm font-medium transition-colors ${
      selected
        ? 'border-ink text-ink'
        : 'border-transparent text-smoke-500 hover:text-ink'
    }`

  return (
    <div className="mt-10 flex flex-col xl:flex-row xl:gap-10">
      <aside className="contents xl:order-1 xl:flex xl:w-[384px] xl:shrink-0 xl:flex-col">
        <div className="order-1 xl:order-none">{sidebar}</div>
        <div
          className={`order-3 ${
            activityActive ? 'block' : 'hidden'
          } pt-6 xl:order-none xl:block xl:pt-0`}
        >
          {activity}
        </div>
      </aside>

      <div className="contents xl:order-2 xl:block xl:min-w-0 xl:flex-1">
        <div className="order-2 -mx-1 mt-8 flex border-b border-smoke-200 px-1 xl:order-none xl:mt-0">
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
              className={`${buttonClasses(activityActive)} xl:hidden`}
            >
              <ProjectTabIcon label="Activity" />
              Activity
            </button>
            {[...visibleTabs, ...(overflowExpanded ? overflowTabs : [])].map(tab => {
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
                  <ProjectTabIcon label={tab.label} />
                  <span>{tab.label}</span>
                </button>
              )
            })}
          </div>
          <ProjectOverflowMenu
            tabs={overflowTabs}
            activeSlug={activityActive ? activitySlug : normalActiveSlug}
            expanded={overflowExpanded}
            onToggle={() => setOverflowExpanded(current => !current)}
          />
        </div>

        <div
          className={`order-4 pt-6 xl:order-none ${
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
  expanded,
  onToggle,
}: {
  tabs: TabDef[]
  activeSlug: string
  expanded: boolean
  onToggle: () => void
}) {
  const activeTab = tabs.find(tab => tabSlug(tab.label) === activeSlug)

  if (!tabs.length) return null

  return (
    <button
      type="button"
      aria-label={`More project sections${activeTab ? `, current: ${activeTab.label}` : ''}`}
      aria-expanded={expanded}
      onClick={onToggle}
      className={`ml-auto flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center border-b-2 px-3 text-xl leading-none transition-colors ${
        activeTab && !expanded
          ? 'border-ink text-ink'
          : 'border-transparent text-smoke-500 hover:text-ink'
      }`}
    >
      <span
        data-overflow-orientation={expanded ? 'horizontal' : 'vertical'}
        className={`transition-transform ${expanded ? 'rotate-90' : ''}`}
      >
        <ProjectOverflowIcon />
      </span>
    </button>
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
      replaceTabHash(
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
