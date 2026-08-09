// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PriceChart } from '@/components/project/PriceChart'

const DAY = 86_400
const NOW = 1_786_000_000

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
})

describe('price history inspection', () => {
  it('shows every series in a hover tooltip instead of a caption below the chart', () => {
    act(() =>
      root.render(
        <PriceChart
          stages={[
            {
              start: NOW - DAY,
              duration: 0,
              weight: 625n * 10n ** 18n,
              weightCutPercent: 0,
            },
          ]}
          symbol="ART"
          baseSymbol="USD"
          floorPrice={{ value: 0.000119, label: 'Cash out price' }}
          ammPrice={{ value: 0.0002, label: 'AMM price' }}
          floorHistory={[
            {
              timestamp: NOW - DAY,
              value: 0.00009,
              reason: 'Funds were added to the project.',
            },
            { timestamp: NOW, value: 0.000119 },
          ]}
          ammHistory={[
            { timestamp: NOW - DAY, value: 0.0001 },
            { timestamp: NOW, value: 0.0002 },
          ]}
        />,
      ),
    )

    // `svg[role="img"]`, not the first svg on the page: the price summaries above the chart
    // carry their own icons, and a bare `querySelector('svg')` silently grabs one of those and
    // dispatches the hover at nothing.
    const chart = container.querySelector('svg[role="img"]')
    expect(chart).not.toBeNull()
    expect(container.textContent).toContain('1H')
    expect(container.textContent).toContain('6H')
    expect(container.textContent).toContain('Smooth')
    expect(container.textContent).toContain('Every trade')
    Object.defineProperty(chart, 'getBoundingClientRect', {
      value: () => ({
        left: 0,
        top: 0,
        width: 1_000,
        height: 500,
        right: 1_000,
        bottom: 500,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
    })

    act(() => {
      chart?.dispatchEvent(
        new MouseEvent('pointermove', {
          bubbles: true,
          clientX: 500,
          clientY: 100,
        }),
      )
    })

    const tooltip = container.querySelector('[role="tooltip"]')
    expect(tooltip?.textContent).toContain('Issuance')
    expect(tooltip?.textContent).toContain('0.0016 USD/ART')
    expect(tooltip?.textContent).toContain('AMM')
    expect(tooltip?.textContent).toContain('0.00015000 USD/ART')
    expect(tooltip?.textContent).toContain('Cash out')
    expect(tooltip?.textContent).toContain('0.000090000 USD/ART')
    expect(tooltip?.textContent).toContain('Funds were added to the project.')

    // The former changing date/issuance/cash-out caption is no longer rendered
    // beneath this chart; the details live in the tooltip alone.
    expect(container.querySelector('[data-chart-caption]')).toBeNull()
  })
})
