import type { BsActivityEvent } from '@/lib/bendystraw'

/** Events sharing this key are one feed row: the same transaction on the same project. */
export function sameTxKey(event: BsActivityEvent): string {
  // Account-history rows span protocol versions; a V4 row must never fold
  // into a V6 group even when the tx and project id line up.
  const version = (event as { version?: number }).version ?? ''
  return `${event.chainId}:${event.projectId}:${version}:${event.txHash}`
}

// ponytail: four reads of 2*rows+1 events; a page whose rows average over eight events each comes back short.
const MAX_READS = 4

/**
 * The events of the next `rows` feed rows from event `offset`, read newest first.
 * A row holds every event of one transaction, so the event count is not known up
 * front: read until the row after the last one opens, and cut there.
 */
export async function readActivityRows<T extends BsActivityEvent>(
  read: (limit: number, offset: number) => Promise<T[]>,
  rows: number,
  offset: number,
): Promise<{ events: T[]; hasMore: boolean }> {
  const chunk = rows * 2 + 1
  const events: T[] = []
  const keys = new Set<string>()
  for (let reads = 0; reads < MAX_READS; reads++) {
    const page = await read(chunk, offset + events.length)
    for (const event of page) {
      keys.add(sameTxKey(event))
      if (keys.size > rows) return { events, hasMore: true }
      events.push(event)
    }
    if (page.length < chunk) return { events, hasMore: false }
  }
  return { events, hasMore: true }
}
