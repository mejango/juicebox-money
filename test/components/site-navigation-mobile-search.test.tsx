// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('next/navigation', () => ({
  usePathname: () => '/eth:3',
  useRouter: () => ({ push: vi.fn() }),
}))
vi.mock('next/image', () => ({ default: () => null }))
vi.mock('next/link', () => ({ default: () => null }))
vi.mock('@/hooks/useOutsideClose', () => ({ useOutsideClose: () => {} }))
vi.mock('@/components/WalletButton', () => ({ WalletButton: () => null }))
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)

import { SiteNavigation } from '@/components/SiteNavigation'

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

describe('phone search', () => {
  it('keeps focus on the field when focusing it expands the row', () => {
    act(() => root.render(<SiteNavigation />))
    const phoneNav = () => container.querySelectorAll('nav')[1]
    const field = () => phoneNav().querySelector('input')!
    const before = field()

    act(() => before.focus())

    expect(field()).toBe(before)
    expect(document.activeElement).toBe(before)
  })

  it('focuses the field when the search icon opens it', () => {
    act(() => root.render(<SiteNavigation />))
    const phoneNav = container.querySelectorAll('nav')[1]

    act(() => phoneNav.querySelector<HTMLButtonElement>('button[aria-label="Search"]')!.click())

    expect(document.activeElement).toBe(phoneNav.querySelector('input'))
  })
})
