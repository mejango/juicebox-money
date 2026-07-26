import { HoverBreakdownStat } from '@/components/project/ProjectStats'
import TestRenderer, { act } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('project stat breakdowns', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {
      matchMedia: vi.fn(() => ({
        matches: true,
        media: '(max-width: 639px)',
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    })
    vi.stubGlobal('document', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })
  })

  it('opens and closes on repeated mobile taps', async () => {
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        <HoverBreakdownStat
          label="Total raised"
          value="$867.60"
          tooltipId="raised-breakdown"
        >
          Raised by chain
        </HoverBreakdownStat>,
      )
    })

    const card = renderer.root.find(
      node => node.type === 'div' && node.props['aria-describedby'] === 'raised-breakdown',
    )
    const tooltip = () => renderer.root.findByProps({ role: 'tooltip' })
    expect(card.props['aria-expanded']).toBe(false)
    expect(tooltip().props['aria-hidden']).toBe(true)

    await act(async () => card.props.onClick())
    expect(card.props['aria-expanded']).toBe(true)
    expect(tooltip().props['aria-hidden']).toBe(false)

    await act(async () => card.props.onClick())
    expect(card.props['aria-expanded']).toBe(false)
    expect(tooltip().props['aria-hidden']).toBe(true)
  })
})
