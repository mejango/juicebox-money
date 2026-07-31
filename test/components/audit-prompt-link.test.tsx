import { createElement } from 'react'
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { AuditPromptLink } from '@/components/AuditPromptLink'

function renderedText(instance: ReactTestInstance): string {
  return instance.children
    .map(child =>
      typeof child === 'string' ? child : renderedText(child),
    )
    .join('')
}

describe('AuditPromptLink', () => {
  it('loads and copies the audit prompt only after the user clicks', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(AuditPromptLink))
    })

    expect(writeText).not.toHaveBeenCalled()
    await act(async () => renderer.root.findByType('button').props.onClick())

    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining('Help me audit, create, or operate'),
    )
    expect(renderedText(renderer.root)).toContain(
      'AI prompt copied to clipboard',
    )
  })
})
