import { createElement } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import {
  ProjectTabs,
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
  const patchedReplaceState = vi.fn()
  const history = Object.assign(
    Object.create({ replaceState: nativeReplaceState }),
    {
      state: { __NA: true },
      replaceState: patchedReplaceState,
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
    return { label, hash: win.nativeReplaceState.mock.lastCall?.[2] }
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
