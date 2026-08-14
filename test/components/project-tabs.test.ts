import { createElement } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import {
  ProjectTabs,
  replaceProjectTabHash,
} from '@/components/project/Tabs'
import { ProjectRouteProvider } from '@/providers/ProjectRouteContext'

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
    emit: (type: string, event?: unknown) => {
      for (const listener of listeners.get(type) ?? []) listener(event)
    },
    nativeReplaceState,
    patchedReplaceState,
  }
}

describe('project tab alias revalidation', () => {
  it('updates the hash and reloads a mutable @handle route', () => {
    const win = fakeProjectWindow('/%40caf%C3%A9.juicebox')
    vi.stubGlobal('window', win)

    replaceProjectTabHash('#owner')

    expect(win.nativeReplaceState).toHaveBeenCalledWith(
      win.history.state,
      '',
      '#owner',
    )
    expect(win.patchedReplaceState).not.toHaveBeenCalled()
    expect(win.location.hash).toBe('#owner')
    expect(win.location.reload).toHaveBeenCalledOnce()
  })

  it('reloads an unchanged hash on a mutable alias', () => {
    const win = fakeProjectWindow('/@design.juicebox')
    win.location.hash = '#shop'
    vi.stubGlobal('window', win)

    replaceProjectTabHash('#shop')

    expect(win.location.reload).toHaveBeenCalledOnce()
  })

  it('keeps numeric routes on the native hash-only fast path', () => {
    const win = fakeProjectWindow('/base:7')
    vi.stubGlobal('window', win)

    replaceProjectTabHash('#shop/customers')

    expect(win.nativeReplaceState).toHaveBeenCalledWith(
      win.history.state,
      '',
      '#shop/customers',
    )
    expect(win.location.reload).not.toHaveBeenCalled()
  })

  it('does not reload a double-encoded handle-looking pathname', () => {
    const win = fakeProjectWindow('/%2540design.juicebox')
    vi.stubGlobal('window', win)

    replaceProjectTabHash('#operator')

    expect(win.location.reload).not.toHaveBeenCalled()
  })

  it('reloads when another project control assigns location.hash directly', async () => {
    const win = fakeProjectWindow('/@design.juicebox')
    vi.stubGlobal('window', win)

    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(ProjectTabs, {
          tabs: [
            { label: 'Overview', content: 'overview' },
            { label: 'Shop', content: 'shop' },
          ],
          sidebar: 'sidebar',
          activity: 'activity',
        }),
      )
    })

    win.location.hash = '#shop'
    await act(async () => win.emit('hashchange'))

    expect(win.location.reload).toHaveBeenCalledOnce()

    await act(async () => renderer.unmount())
  })

  it('revalidates aliases restored by history or BFCache without looping on load', async () => {
    const win = fakeProjectWindow('/%40caf%C3%A9.juicebox')
    vi.stubGlobal('window', win)

    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(ProjectRouteProvider, null, 'project'),
      )
    })

    await act(async () => win.emit('pageshow', { persisted: false }))
    expect(win.location.reload).not.toHaveBeenCalled()
    await act(async () => win.emit('popstate'))
    expect(win.location.reload).toHaveBeenCalledTimes(1)
    await act(async () => win.emit('pageshow', { persisted: true }))
    expect(win.location.reload).toHaveBeenCalledTimes(2)

    await act(async () => renderer.unmount())
  })

  it('does not reload a numeric route restored from history', async () => {
    const win = fakeProjectWindow('/eth:1')
    vi.stubGlobal('window', win)

    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(ProjectRouteProvider, null, 'project'),
      )
    })
    await act(async () => win.emit('popstate'))
    await act(async () => win.emit('pageshow', { persisted: true }))
    expect(win.location.reload).not.toHaveBeenCalled()

    await act(async () => renderer.unmount())
  })
})
