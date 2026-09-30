import { createElement } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  link: vi.fn(),
}))

vi.mock('next/link', () => ({
  default: (props: Record<string, unknown>) => {
    mocks.link(props)
    return createElement('a', { href: props.href })
  },
}))

import { ProjectLink } from '@/components/ProjectLink'
import {
  clearProjectNavigationHints,
  getProjectNavigationHint,
} from '@/lib/project-navigation'

type LinkProps = Record<string, (() => void) | unknown>

function render(props: Record<string, unknown>) {
  act(() => {
    TestRenderer.create(
      createElement(ProjectLink, { href: '/eth:1', ...props } as never),
    )
  })
  return mocks.link.mock.lastCall![0] as LinkProps
}

describe('ProjectLink', () => {
  beforeEach(clearProjectNavigationHints)

  it('never prefetches its project route', () => {
    expect(render({}).prefetch).toBe(false)
  })

  it('keeps a caller from turning prefetching back on', () => {
    expect(render({ prefetch: true }).prefetch).toBe(false)
  })

  it('remembers its hint before each way a visitor reaches the project', () => {
    const projectHint = { name: 'Marquee', logoUri: null }
    const link = render({ href: '/base:7', projectHint })

    for (const handler of [
      'onPointerEnter',
      'onPointerDown',
      'onFocus',
      'onClick',
    ]) {
      clearProjectNavigationHints()
      ;(link[handler] as () => void)()
      expect(getProjectNavigationHint('/base:7'), handler).toEqual({
        name: 'Marquee',
        logoUri: null,
        tagline: null,
      })
    }
  })

  it('links without a hint and still calls the caller handlers', () => {
    const onClick = vi.fn()
    const link = render({ onClick })

    ;(link.onClick as () => void)()

    expect(onClick).toHaveBeenCalledOnce()
    expect(getProjectNavigationHint('/eth:1')).toBeNull()
  })
})
