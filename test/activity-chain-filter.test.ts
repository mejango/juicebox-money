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
  const tx = (id: string, txHash: string, timestamp: number) => ({ id, chainId: 1, projectId: 7, txHash, timestamp }) as BsActivityEvent
  // Newest first: the page ends on the bridge send, with the cash out inside it still unloaded.
  const page = [tx('pay', '0xa', 30), tx('mint', '0xa', 30), tx('send', '0xb', 20)]

  it('waits for the next page while older events are unloaded', () => {
    expect(withoutPartialOldest(page, true).map(event => event.id)).toEqual(['pay', 'mint'])
  })

  it('holds back every transaction at the oldest loaded moment: they interleave, so any of them may be cut', () => {
    // 0xb's cash out and 0xc's payment share a block; 0xb's bridge send is still on the next page.
    const interleaved = [tx('pay', '0xa', 30), tx('cash out', '0xb', 20), tx('pay 2', '0xc', 20)]
    expect(withoutPartialOldest(interleaved, true).map(event => event.id)).toEqual(['pay'])
  })

  it('shows as it is once everything is loaded', () => {
    expect(withoutPartialOldest(page, false)).toBe(page)
  })

  it('shows nothing while a whole page shares one moment and more remain: any of it may be cut', () => {
    const only = [tx('send', '0xb', 20), tx('cash out', '0xb', 20)]
    expect(withoutPartialOldest(only, true)).toEqual([])
  })
})
