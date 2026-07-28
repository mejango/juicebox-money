'use client'

import { useEffect, useState } from 'react'
import { TabShell, tabSlug, type TabDef } from '@/components/project/Tabs'

/**
 * The account view's top-level tab row, in the project page's tab idiom:
 * deep links via the URL hash (#holdings), lazy-mounts each tab on first
 * view and keeps it mounted after so its content doesn't re-fetch.
 */
export function AccountTabs({ tabs }: { tabs: TabDef[] }) {
  const [active, setActive] = useState(0)

  // Resolve the initial tab from the URL hash and follow hash changes
  // (back/forward navigation), like the project page's ProjectTabs.
  useEffect(() => {
    const apply = () => {
      const slug = window.location.hash.replace('#', '').split('/')[0] ?? ''
      const index = tabs.findIndex(tab => tabSlug(tab.label) === tabSlug(slug))
      setActive(index >= 0 ? index : 0)
    }
    apply()
    window.addEventListener('hashchange', apply)
    return () => window.removeEventListener('hashchange', apply)
    // The tab set is static for the mounted page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const activate = (index: number) => {
    setActive(index)
    // Keep the hash shareable without adding history entries per click.
    window.history.replaceState(null, '', `#${tabSlug(tabs[index].label)}`)
  }

  return (
    <TabShell
      tabs={tabs}
      active={active}
      onSelect={activate}
      ariaLabel="Account sections"
      listClassName="scrollbar-none -mx-1 flex gap-1 overflow-x-auto border-b border-smoke-200 px-1"
      buttonClassName="min-h-[44px] shrink-0 whitespace-nowrap border-b-2 px-3.5 font-agrandir text-sm font-medium transition-colors"
      panelClassName="pt-6"
    />
  )
}
