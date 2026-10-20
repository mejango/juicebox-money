/** Storage keys of saved project batches, readable without the batch machinery. */
export const PROJECT_BATCH_PREFIX = 'jb-project-batch:v1:'
export const PENDING_PAYMENT_ACTION = 'route-destination-payments'
/** Older source journals saved pending-payment retries under this action. */
export const LEGACY_PENDING_PAYMENT_ACTION = 'route-pending-payments'

/**
 * Whether this browser holds a saved batch alias for any of `actions`. A cheap
 * over-approximation: the batch itself may have finished; the panel that loads
 * it decides.
 */
export function hasSavedProjectBatch(actions: readonly string[]): boolean {
  try {
    const storage = window.localStorage
    const prefixes = actions.map(action => `${PROJECT_BATCH_PREFIX}alias:${action}:`)
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index)
      if (key && prefixes.some(prefix => key.startsWith(prefix))) return true
    }
  } catch {
    // Storage unavailable: nothing saved here to resume.
  }
  return false
}
