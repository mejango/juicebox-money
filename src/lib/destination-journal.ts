import { withTabLocks, type TabLocks } from '@/lib/tab-locks'

/** A saved review that names the destinations (chain and project) it changes. */
type Saved = { scope: string }

const encodeBigints = (_key: string, value: unknown) => typeof value === 'bigint' ? { bigint: value.toString() } : value
const decodeBigints = (_key: string, value: unknown) =>
  value && typeof value === 'object' && Object.keys(value).length === 1 && typeof (value as { bigint?: unknown }).bigint === 'string'
    ? BigInt((value as { bigint: string }).bigint)
    : value

/**
 * One multichain review saved once per destination, under that destination's
 * key, so whichever chain's page opens next finds it. Every destination's key
 * is also its cross-tab lock. The stored text is the journal's JSON (bigints as
 * `{ bigint: "…" }` when `bigints`), unchanged from the editors' own journals,
 * so reviews saved by earlier versions read back as they were.
 */
export function destinationJournal<J extends Saved, D>({
  keyOf,
  destinationsOf,
  valid,
  conflicts,
  bigints = true,
  storageLine,
}: {
  keyOf: (destination: D) => string
  destinationsOf: (journal: J) => readonly D[]
  /** A journal stored at `key` this code can act on (its scope matches its calls, say); anything else reads as none. */
  valid: (journal: J, key: string) => boolean
  /** The line refusing to save over `existing`, the journal saved at `destination`; null allows it. */
  conflicts: (existing: J, journal: J, destination: D) => string | null
  bigints?: boolean
  /** The line when the browser did not keep what was written. */
  storageLine: string
}) {
  const read = (key: string): J | null => {
    try {
      const raw = window.localStorage.getItem(key)
      if (!raw) return null
      const journal = JSON.parse(raw, bigints ? decodeBigints : undefined) as J
      return valid(journal, key) ? journal : null
    } catch { return null }
  }
  return {
    key: keyOf,
    read,
    save(journal: J): void {
      const text = JSON.stringify(journal, bigints ? encodeBigints : undefined)
      for (const destination of destinationsOf(journal)) {
        const key = keyOf(destination)
        const existing = read(key)
        const refusal = existing ? conflicts(existing, journal, destination) : null
        if (refusal) throw new Error(refusal)
        window.localStorage.setItem(key, text)
        if (window.localStorage.getItem(key) !== text) throw new Error(storageLine)
      }
    },
    /** Remove this journal from each destination that still holds it; another journal saved there stays. */
    clear(journal: J): void {
      for (const destination of destinationsOf(journal)) {
        const key = keyOf(destination)
        if (read(key)?.scope === journal.scope) window.localStorage.removeItem(key)
      }
    },
    /** Runs `work` under every destination's lock, handed them: its saves go through `fence(locks, save)`. */
    lock<T>(destinations: readonly D[], busy: string, work: (locks: TabLocks) => Promise<T>): Promise<T> {
      return withTabLocks(destinations.map(keyOf), busy, work)
    },
  }
}
