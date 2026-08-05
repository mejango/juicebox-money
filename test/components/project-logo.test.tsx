import { createElement } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'

vi.mock('next/image', () => ({
  default: (props: Record<string, unknown>) => createElement('img', props),
}))

import { ProjectLogo } from '@/components/ProjectLogo'
import { ProjectLogoWithFallback } from '@/components/ProjectLogoWithFallback'

describe('ProjectLogo', () => {
  it('renders the inline SVG format used by updated project metadata', async () => {
    const src =
      'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E'
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(ProjectLogo, {
          name: "Kenny's Bounty Engine Network",
          logoUri: src,
          size: 112,
        }),
      )
    })

    const image = renderer.root.findByType('img')
    expect(image.props.src).toBe(src)
    expect(image.props.unoptimized).toBe(true)
  })

  it('replaces a failed image with the deterministic initial tile', async () => {
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(ProjectLogoWithFallback, {
          name: 'Broken logo',
          logoUri: 'ipfs://QmBroken',
          size: 56,
        }),
      )
    })

    await act(async () => {
      renderer.root.findByType('img').props.onError()
    })

    expect(renderer.root.findByType('span').children).toEqual(['B'])
  })
})
