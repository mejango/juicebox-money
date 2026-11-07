import { createElement } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuditPromptActions } from '@/components/AuditPromptActions'
import { AUDIT_PROMPT } from '@/lib/audit-prompt'

describe('AuditPromptActions', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('says the copy was blocked and shows the prompt to select', async () => {
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('blocked')) },
    })
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(AuditPromptActions))
    })
    expect(renderer.root.findAllByType('textarea')).toHaveLength(0)

    await act(async () => renderer.root.findAllByType('button')[0].props.onClick())

    expect(renderer.root.findByProps({ role: 'status' }).children.join('')).toContain(
      'Copy was blocked by your browser',
    )
    expect(renderer.root.findByType('textarea').props.value).toBe(AUDIT_PROMPT)
  })
})
