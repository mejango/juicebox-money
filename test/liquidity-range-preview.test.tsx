// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LiquidityRangePreview } from '@/components/project/LiquidityRangePreview'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('LiquidityRangePreview', () => {
  it('shows the selected position against the economic and live-price markers', () => {
    act(() =>
      root.render(
        <LiquidityRangePreview
          floor={0.001}
          ceiling={0.004}
          current={0.002}
          minimum={0.0008}
          maximum={0.0045}
          pairSymbol="USDC"
          tokenSymbol="ART"
        />,
      ),
    )

    expect(container.querySelector('svg')?.getAttribute('aria-label')).toBe(
      'Liquidity range in USDC per ART',
    )
    expect(container.querySelector('rect')).not.toBeNull()
    expect(container.textContent).toContain('Floor')
    expect(container.textContent).toContain('Current pool price')
    expect(container.textContent).toContain('Ceiling')
  })
})
