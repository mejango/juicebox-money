import { describe, expect, it } from 'vitest'
import { readActivityRows } from '@/lib/activity-rows'
import type { BsActivityEvent } from '@/lib/bendystraw'

const feed = (txs: number[]) =>
  txs.flatMap((count, tx) =>
    Array.from({ length: count }, (_, i) => ({ id: `${tx}-${i}`, chainId: 1, projectId: 1, txHash: `0x${tx}` }) as BsActivityEvent),
  )
const reader = (events: BsActivityEvent[]) => async (limit: number, offset: number) => events.slice(offset, offset + limit)

describe('readActivityRows', () => {
  it('fills the asked rows however many events each holds, and cuts where the next row opens', async () => {
    const events = feed([3, 2, 5, 1, 2, 2, 4, 2, 1, 1])
    const page = await readActivityRows(reader(events), 8, 0)
    expect(new Set(page.events.map(event => event.txHash)).size).toBe(8)
    expect(page.events).toEqual(events.slice(0, 21))
    expect(page.hasMore).toBe(true)
    // The next page starts at the event offset the first one ended on.
    await expect(readActivityRows(reader(events), 8, 21)).resolves.toEqual({ events: events.slice(21), hasMore: false })
  })

  it('reports no more when the feed ends inside the page', async () => {
    const events = feed([2, 2])
    await expect(readActivityRows(reader(events), 8, 0)).resolves.toEqual({ events, hasMore: false })
  })
})
