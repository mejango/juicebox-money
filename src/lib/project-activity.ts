/** Shared server seed/client polling contract for the project activity feed. */
export const ACTIVITY_PAGE_SIZE = 250
/** How often an activity feed reads its newest page again, on every surface. */
export const ACTIVITY_POLL_MS = 30_000
export const PROJECT_ACTIVITY_FRESHNESS_MS = ACTIVITY_POLL_MS
