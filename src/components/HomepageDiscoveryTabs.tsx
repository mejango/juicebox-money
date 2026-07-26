import type { ReactNode } from 'react'
import styles from './HomepageDiscoveryTabs.module.css'

/** Mobile and tablet tabs that become the side-by-side discovery layout from
 * `lg` upward. Native radio controls keep the switch functional before
 * hydration, while each content panel remains mounted exactly once. */
export function HomepageDiscoveryTabs({
  trending,
  activity,
  name = 'homepage-discovery',
}: {
  trending: ReactNode
  activity: ReactNode
  name?: string
}) {
  return (
    <fieldset className={styles.root}>
      <legend className="sr-only">Discover Juicebox</legend>
      <div
        className={`${styles.tablist} mb-5 border-b border-smoke-200 lg:hidden`}
      >
        <label
          className={`${styles.tab} min-h-14 px-2 font-agrandir text-xl font-medium`}
        >
          <input
            type="radio"
            name={name}
            defaultChecked
            className={`${styles.input} ${styles.trendingInput}`}
          />
          Trending projects
        </label>
        <label
          className={`${styles.tab} min-h-14 px-2 font-agrandir text-xl font-medium`}
        >
          <input
            type="radio"
            name={name}
            className={`${styles.input} ${styles.activityInput}`}
          />
          Fresh activity
        </label>
      </div>

      <div className={`${styles.panels} grid grid-cols-1 gap-4 lg:grid-cols-3`}>
        <div
          className={`${styles.trendingPanel} min-w-0 lg:col-span-2 lg:block`}
        >
          {trending}
        </div>
        <aside
          className={`${styles.activityPanel} min-w-0 lg:col-span-1 lg:block`}
        >
          {activity}
        </aside>
      </div>
    </fieldset>
  )
}
