// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MarketSectionSkeleton } from '@/components/LoadingSkeletons'

let container: HTMLDivElement
let root: Root
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove() })

describe('market loading state', () => {
  it('ghosts the price chart above the pool and liquidity cards', () => {
    act(() => root.render(<MarketSectionSkeleton />))
    // Three cards: price chart, pool, liquidity — the chart ghost must be first
    // so the tab does not reflow when the real chart lands on top.
    const cards = container.querySelectorAll('.card')
    expect(cards.length).toBe(3)
    expect(cards[0].querySelectorAll('.skeleton-shimmer').length).toBeGreaterThan(6)
  })
})
