import { describe, expect, it } from 'vitest'
import { activityChains, activityOnChain, withoutPartialOldest } from '@/lib/activity-rows'
import type { BsActivityEvent } from '@/lib/bendystraw'

const on = (chainId: number, id: string) => ({ id, chainId }) as BsActivityEvent

describe('the activity chain filter', () => {
  const events = [on(10, 'a'), on(8453, 'b'), on(1, 'c'), on(8453, 'd'), on(42161, 'e')]

  it('offers the chains the events happened on, in display order', () => {
    expect(activityChains(events)).toEqual([1, 8453, 42161, 10])
    expect(activityChains([])).toEqual([])
  })

  it('keeps only the chosen chain, and everything when none is chosen', () => {
    expect(activityOnChain(events, 8453).map(event => event.id)).toEqual(['b', 'd'])
    expect(activityOnChain(events, null)).toBe(events)
  })

  it('shows everything when the chosen chain has no loaded events, so a refresh never empties the feed behind a hidden choice', () => {
    expect(activityOnChain([on(1, 'c')], 8453).map(event => event.id)).toEqual(['c'])
  })
})

describe('a transaction cut by the page boundary', () => {
  const tx = (id: string, txHash: string) => ({ id, chainId: 1, projectId: 7, txHash }) as BsActivityEvent
  // Newest first: the page ends on the bridge send, with the cash out inside it still unloaded.
  const page = [tx('pay', '0xa'), tx('mint', '0xa'), tx('send', '0xb')]

  it('waits for the next page while older events are unloaded', () => {
    expect(withoutPartialOldest(page, true).map(event => event.id)).toEqual(['pay', 'mint'])
  })

  it('shows as it is once everything is loaded, or when it is all there is', () => {
    expect(withoutPartialOldest(page, false)).toBe(page)
    const only = [tx('send', '0xb'), tx('cash out', '0xb')]
    expect(withoutPartialOldest(only, true)).toBe(only)
  })
})
