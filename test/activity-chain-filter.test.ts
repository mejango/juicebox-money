import { describe, expect, it } from 'vitest'
import { activityChains, activityOnChain } from '@/lib/activity-rows'
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
