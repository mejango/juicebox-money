import { browserLocks } from '@bananapus/nana-sdk-core/review/locks'

/**
 * Run `work` holding every key's cross-tab lock, taken in sorted order so
 * overlapping key sets cannot deadlock. A key another tab holds refuses with
 * `busy`; without `busy`, it waits for that tab. The SDK's browserLocks() is
 * the one rule for browsers without Web Locks: an IndexedDB lease across tabs,
 * else a lock within this tab, never a refusal. */
export async function withTabLocks<T>(keys: readonly string[], busy: string | undefined, work: () => Promise<T> | T): Promise<T> {
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
