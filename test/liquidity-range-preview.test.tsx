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

describe('LiquidityRangePreview drag handles', () => {
  const pointer = (type: string, clientX = 0) =>
    new PointerEvent(type, { bubbles: true, pointerId: 1, clientX })

  const dragTo = (handle: Element, clientX: number) =>
    act(() => {
      handle.dispatchEvent(pointer('pointerdown'))
      handle.dispatchEvent(pointer('pointermove', clientX))
      handle.dispatchEvent(pointer('pointerup'))
    })

  it('maps a pointer position back to a price and keeps the edges ordered', () => {
    const changes: Array<[string, number]> = []
    act(() =>
      root.render(
        <LiquidityRangePreview
          floor={null}
          ceiling={null}
          current={0.002}
          minimum={0.001}
          maximum={0.004}
          pairSymbol="USDC"
          tokenSymbol="ART"
          onRangeChange={(edge, value) => changes.push([edge, value])}
        />,
      ),
    )
    const svg = container.querySelector('svg')!
    // 320-wide viewBox with 8px padding; the axis spans 0…maximum*1.12.
    svg.getBoundingClientRect = () => ({ left: 0, width: 320 }) as DOMRect
    const handles = container.querySelectorAll('rect.cursor-ew-resize')
    expect(handles).toHaveLength(2)

    // Halfway across the axis is half of the 0.00448 domain.
    dragTo(handles[0], 8 + (320 - 16) / 2)
    expect(changes.at(-1)![0]).toBe('min')
    expect(changes.at(-1)![1]).toBeCloseTo(0.00224, 6)

    // Dragging min past max clamps it below max instead of inverting.
    dragTo(handles[0], 320)
    expect(changes.at(-1)![1]).toBeLessThan(0.004)

    // Dragging max below min clamps it above min.
    dragTo(handles[1], 0)
    expect(changes.at(-1)![0]).toBe('max')
    expect(changes.at(-1)![1]).toBeGreaterThan(0.001)
  })

  it('renders no handles when the range is not editable', () => {
    act(() =>
      root.render(
        <LiquidityRangePreview
          floor={null}
          ceiling={null}
          current={0.002}
          minimum={0.001}
          maximum={0.004}
          pairSymbol="USDC"
          tokenSymbol="ART"
        />,
      ),
    )
    expect(container.querySelectorAll('rect.cursor-ew-resize')).toHaveLength(0)
  })
})
