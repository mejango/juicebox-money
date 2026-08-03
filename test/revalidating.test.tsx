// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Revalidating } from '@/components/ui/Revalidating'

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

describe('unconfirmed values', () => {
  it('keeps the restored value readable while it is being confirmed', () => {
    act(() => root.render(<Revalidating pending>0.0016 USDC</Revalidating>))
    const node = container.firstElementChild!
    // The point of this affordance over a skeleton: the number is still there.
    expect(node.textContent).toBe('0.0016 USDC')
    expect(node.className).toContain('revalidating')
    expect(node.getAttribute('aria-busy')).toBe('true')
  })

  it('drops the affordance once confirmed', () => {
    act(() => root.render(<Revalidating pending={false}>0.0016 USDC</Revalidating>))
    const node = container.firstElementChild!
    expect(node.textContent).toBe('0.0016 USDC')
    expect(node.className).not.toContain('revalidating')
    expect(node.getAttribute('aria-busy')).toBeNull()
  })
})
