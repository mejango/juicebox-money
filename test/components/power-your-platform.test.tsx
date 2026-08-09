import { createElement } from 'react'
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { PowerYourPlatform } from '@/components/PowerYourPlatform'

vi.mock('next/link', () => ({ default: 'a' }))

function renderedText(instance: ReactTestInstance): string {
  return instance.children
    .map(child => (typeof child === 'string' ? child : renderedText(child)))
    .join('')
}

describe('PowerYourPlatform', () => {
  it('shows platform examples and keeps the full build prompt behind the copy action', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    let renderer!: TestRenderer.ReactTestRenderer

    await act(async () => {
      renderer = TestRenderer.create(createElement(PowerYourPlatform))
    })

    const text = renderedText(renderer.root)
    expect(text).toContain('Juicebox Money')
    expect(text).toContain('Revnet')
    expect(text).toContain('living list')
    expect(text).not.toContain('Deliver: (1)')

    const copyButton = renderer.root.findAllByType('button').find(button =>
      renderedText(button).includes('Copy the build prompt'),
    )
    expect(copyButton).toBeDefined()
    await act(async () => copyButton!.props.onClick())

    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('Deliver: (1)'))
    expect(renderedText(renderer.root)).toContain('Build prompt copied')
  })
})
