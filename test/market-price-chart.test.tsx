// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MarketPriceChart } from '@/components/project/MarketPriceChart'

const DAY = 86_400
const NOW = 1_786_000_000
const POOL_ID = '0xpool'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW * 1_000)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

function render(node: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
  act(() =>
    root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>),
  )
}

describe('standalone market price chart', () => {
  it('scales to the traded range instead of to zero, so a small move is visible', async () => {
    const swaps = [
      { chainId: 1, poolId: POOL_ID, direction: 'buy', timestamp: NOW - 3 * DAY, sqrtPriceX96: null, projectTokenIsCurrency0: null, terminalTokenAmount: '100', projectTokenAmount: '1000000000000000000' },
      { chainId: 1, poolId: POOL_ID, direction: 'buy', timestamp: NOW - DAY, sqrtPriceX96: null, projectTokenIsCurrency0: null, terminalTokenAmount: '110', projectTokenAmount: '1000000000000000000' },
    ]
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ moments: [], swaps, pools: [] }),
      })),
    )

    render(
      <MarketPriceChart
        chainId={1}
        suckerGroupId="group"
        poolId={POOL_ID}
        pairDecimals={2}
        pairSymbol="USDC"
        symbol="ART"
        livePrice={1.2}
      />,
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    const line = container.querySelector('polyline')
    expect(line).not.toBeNull()
    const ys = line!
      .getAttribute('points')!
      .split(' ')
      .map(pair => Number(pair.split(',')[1]))
    // 1.00 → 1.10 → 1.20 (live): a 20% move must use most of the plot height,
    // which a zero-anchored scale would flatten to a few pixels.
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(100)
    expect(container.textContent).toContain('+20.0%')
    expect(container.textContent).toContain('Smooth')
    expect(container.textContent).toContain('Every trade')

    // The scale is only readable if both ends are labelled — a min-max scale
    // with no labels can't be told apart from a zero-anchored one.
    const labels = [...container.querySelectorAll('svg text')].map(t => t.textContent)
    expect(labels).toContain('1.22')
    expect(labels).toContain('0.976')
  })

  it('says so when the selected range holds no trades', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ moments: [], swaps: [], pools: [] }),
      })),
    )

    render(
      <MarketPriceChart
        chainId={1}
        suckerGroupId="group"
        poolId={POOL_ID}
        pairDecimals={2}
        pairSymbol="USDC"
        symbol="ART"
        livePrice={1.2}
      />,
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(container.querySelector('polyline')).toBeNull()
    expect(container.textContent).toContain('No trades in this range yet')
  })
})
