/**
 * Run `work` holding every key's cross-tab lock, taken in sorted order so
 * overlapping key sets cannot deadlock. A key another tab holds refuses with
 * `busy`; without `busy`, it waits for that tab. The SDK's browserLocks() is
 * the one rule for browsers without Web Locks: an IndexedDB lease across tabs,
 * else a lock within this tab. Payment and recovery flows first call
 * requireWebLocks. It loads with the first lock,
 * so pages that only might lock (create, account) keep the review entry out
 * of their first load.
 */
export async function withTabLocks<T>(keys: readonly string[], busy: string | undefined, work: () => Promise<T> | T): Promise<T> {
  const { browserLocks } = await import('@bananapus/nana-sdk-core/review')
  const locks = browserLocks()
  const sorted = [...new Set(keys)].sort()
  const next = async (index: number): Promise<T> => index === sorted.length
    ? await work()
    : await locks.request(sorted[index], { ifAvailable: busy !== undefined }, async lock => {
      if (!lock) throw new Error(busy)
      return next(index + 1)
    }) as T
  return next(0)
}

/**
 * Payment and recovery flows refuse with `refusal` in a browser without Web
 * Locks. The SDK fallback's lease lapses while a backgrounded tab is mid-flow,
 * a second tab can then take it, and nothing stops the first from saving its
 * journal or paying after it lost the lease.
 */
export function requireWebLocks(refusal: string): void {
  if (typeof navigator === 'undefined' || !navigator.locks) throw new Error(refusal)
}
