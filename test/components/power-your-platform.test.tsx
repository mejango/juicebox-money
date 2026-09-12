import { createElement } from 'react'
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { PowerYourPlatform } from '@/components/PowerYourPlatform'
import { PLATFORM_BUILD_PROMPT } from '@/lib/build-prompt'

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
    const links = renderer.root.findAllByType('a').map(link => ({
      text: renderedText(link),
      href: link.props.href,
    }))
    expect(links).toEqual(expect.arrayContaining([
      { text: 'Juicebox Money', href: '/' },
      { text: 'Revnet', href: 'https://revnet.money' },
      { text: 'Read the build guide', href: '/build' },
    ]))
    expect(text).not.toContain(PLATFORM_BUILD_PROMPT)
    expect(writeText).not.toHaveBeenCalled()

    const copyButton = renderer.root.findAllByType('button').find(button =>
      renderedText(button).includes('Copy the build prompt'),
    )
    expect(copyButton).toBeDefined()
    await act(async () => copyButton!.props.onClick())

    expect(writeText).toHaveBeenCalledExactlyOnceWith(PLATFORM_BUILD_PROMPT)
    expect(renderedText(renderer.root)).toContain('Build prompt copied')
  })
})
