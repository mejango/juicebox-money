import { assertLocksHeld, browserLocks, type LockHandle } from '@bananapus/nana-sdk-core/review/locks'

/** The cross-tab locks a piece of work runs under: each write checks them first (`assertLocksHeld`). */
export type TabLocks = readonly LockHandle[]

/**
 * A journal's `write` bound to the locks it runs under: it writes only once
 * every one still reads as held (`LockLostError` otherwise), so a tab whose
 * lease passed to another tab never overwrites that tab's journal.
 */
export const fence = <A extends unknown[], R>(locks: TabLocks, write: (...args: A) => R) =>
  async (...args: A): Promise<R> => {
    await assertLocksHeld(locks)
    return write(...args)
  }

/**
 * Run `work` holding every key's cross-tab lock, taken in sorted order so
 * overlapping key sets cannot deadlock, and hand it those locks: a lease can
 * lapse while the tab sleeps, so every journal write and send under them
 * checks them first. A key another tab holds refuses with `busy`; without
 * `busy`, it waits for that tab. The SDK's browserLocks() is the one rule for
 * browsers without Web Locks: an IndexedDB lease across tabs, else a lock
 * within this tab, never a refusal. */
export async function withTabLocks<T>(keys: readonly string[], busy: string | undefined, work: (locks: TabLocks) => Promise<T> | T): Promise<T> {
  const locks = browserLocks()
  const sorted = [...new Set(keys)].sort()
  const held: LockHandle[] = []
  const next = async (index: number): Promise<T> => index === sorted.length
    ? await work(held)
    : await locks.request(sorted[index], { ifAvailable: busy !== undefined }, async lock => {
      if (!lock) throw new Error(busy)
      held.push(lock)
      return next(index + 1)
    }) as T
  return next(0)
}
