import { createElement } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import {
  ProjectTabs,
  SubTabs,
} from '@/components/project/Tabs'

function fakeProjectWindow(pathname: string) {
  const listeners = new Map<string, Set<(event?: unknown) => void>>()
  const location = {
    hash: '',
    pathname,
    reload: vi.fn(),
  }
  const nativeReplaceState = vi.fn(
    (_state: unknown, _title: string, url: string) => {
      location.hash = url
    },
  )
  const nativePushState = vi.fn(
    (_state: unknown, _title: string, url: string) => {
      location.hash = url
    },
  )
  const patchedReplaceState = vi.fn()
  const patchedPushState = vi.fn()
  const history = Object.assign(
    Object.create({ replaceState: nativeReplaceState, pushState: nativePushState }),
    {
      state: { __NA: true },
      replaceState: patchedReplaceState,
      pushState: patchedPushState,
    },
  )

  return {
    history,
    location,
    matchMedia: () => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
    addEventListener: (type: string, listener: (event?: unknown) => void) => {
      const current = listeners.get(type) ?? new Set<(event?: unknown) => void>()
      current.add(listener)
      listeners.set(type, current)
    },
    removeEventListener: (type: string, listener: (event?: unknown) => void) => {
      listeners.get(type)?.delete(listener)
    },
    dispatchEvent: (event: Event) => {
      for (const listener of listeners.get(event.type) ?? []) listener(event)
      return true
    },
    emit: (type: string, event?: unknown) => {
      for (const listener of listeners.get(type) ?? []) listener(event)
    },
    nativeReplaceState,
    patchedReplaceState,
    nativePushState,
    patchedPushState,
  }
}

describe('the single-column activity tab', () => {
  async function clickActivityTab(activityLabel?: string) {
    const win = fakeProjectWindow('/base:7')
    win.matchMedia = () => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })
    vi.stubGlobal('window', win)

    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(ProjectTabs, {
          tabs: [{ label: 'Overview', content: 'overview' }],
          sidebar: 'sidebar',
          activity: 'activity',
          ...(activityLabel ? { activityLabel } : {}),
        }),
      )
    })
    const [tab] = renderer.root.findAll(
      node => node.type === 'button' && node.props['aria-selected'] === true,
    )
    const label = tab.children.filter(child => typeof child === 'string')
    await act(async () => tab.props.onClick())
    await act(async () => renderer.unmount())
    return { label, hash: win.nativePushState.mock.lastCall?.[2] }
  }

  it('reads Activity and keeps #activity by default', async () => {
    expect(await clickActivityTab()).toEqual({
      label: ['Activity'],
      hash: '#activity',
    })
  })

  it('takes its label, and the hash it keeps, from activityLabel', async () => {
    expect(await clickActivityTab('Latest')).toEqual({
      label: ['Latest'],
      hash: '#latest',
    })
  })
})

describe('project tab hashes', () => {
  const owners = {
    label: 'Owners',
    content: createElement(SubTabs, {
      hashParent: 'owners',
      tabs: [
        { label: 'Accounts', content: 'accounts' },
        { label: 'Market', content: 'market' },
      ],
    }),
  }
  const tabs = [{ label: 'Overview', content: 'overview' }, owners]
  const textOf = (node: TestRenderer.ReactTestInstance): string =>
    node.children.map(child => (typeof child === 'string' ? child : textOf(child))).join('')
  const button = (renderer: TestRenderer.ReactTestRenderer, label: string) =>
    renderer.root.findAll(node => node.type === 'button' && textOf(node) === label)[0]
  const selected = (renderer: TestRenderer.ReactTestRenderer) =>
    renderer.root
      .findAll(node => node.type === 'button' && node.props['aria-selected'] === true)
      .map(textOf)

  async function open(hash: string, singleColumn = false) {
    const win = fakeProjectWindow('/eth:3')
    win.location.hash = hash
    win.matchMedia = () => ({ matches: singleColumn, addEventListener: vi.fn(), removeEventListener: vi.fn() })
    vi.stubGlobal('window', win)
    const scrollIntoView = vi.fn()
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(ProjectTabs, { tabs, sidebar: 'sidebar', activity: 'activity' }),
        {
          createNodeMock: element =>
            (element.props as Record<string, unknown>)['data-project-tab-scroll']
              ? {
                  scrollIntoView,
                  querySelector: () => null,
                  getBoundingClientRect: () => ({ left: 0, right: 0 }),
                }
              : null,
        },
      )
    })
    return { win, renderer, scrollIntoView }
  }

  it('opens a linked subtab on a fresh load', async () => {
    const { renderer } = await open('#owners/market')
    expect(selected(renderer)).toContain('Owners')
    expect(selected(renderer)).toContain('Market')
    await act(async () => renderer.unmount())
  })

  it('a subtab click keeps its parent tab and adds a history entry', async () => {
    const { win, renderer } = await open('#owners')
    const market = button(renderer, 'Market')
    await act(async () => market.props.onClick())
    expect(win.nativePushState.mock.lastCall?.[2]).toBe('#owners/market')
    expect(win.nativeReplaceState).not.toHaveBeenCalled()
    expect(selected(renderer)).toContain('Owners')
    expect(selected(renderer)).toContain('Market')
    await act(async () => renderer.unmount())
  })

  it('follows Back to the previous tab', async () => {
    const { win, renderer } = await open('#owners/market')
    win.location.hash = '#overview'
    await act(async () => win.emit('hashchange'))
    expect(selected(renderer)).not.toContain('Owners')
    await act(async () => renderer.unmount())
  })

  it('does not add an entry for the tab already open', async () => {
    const { win, renderer } = await open('#owners/market')
    const market = button(renderer, 'Market')
    await act(async () => market.props.onClick())
    expect(win.nativePushState).not.toHaveBeenCalled()
    await act(async () => renderer.unmount())
  })

  it('scrolls to the content on a phone tap, not on load or on desktop', async () => {
    const phone = await open('#overview', true)
    expect(phone.scrollIntoView).not.toHaveBeenCalled()
    const tab = button(phone.renderer, 'Owners')
    await act(async () => tab.props.onClick())
    expect(phone.scrollIntoView).toHaveBeenCalledTimes(1)
    await act(async () => phone.renderer.unmount())

    const desktop = await open('#overview')
    const desktopTab = button(desktop.renderer, 'Owners')
    await act(async () => desktopTab.props.onClick())
    expect(desktop.scrollIntoView).not.toHaveBeenCalled()
    await act(async () => desktop.renderer.unmount())
  })
})
