import { useLayoutEffect, useState } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ProjectRouteBoundary, ProjectRouteProvider, useProjectReviewScope, type ProjectReviewScope,
} from '@/providers/ProjectRouteContext'
import { replaceProjectTabHash } from '@/components/project/Tabs'
import type { ProjectRouteSnapshot } from '@/lib/project-route'

const authority = `0x${'12'.repeat(20)}`
function snapshot(overrides: Partial<ProjectRouteSnapshot> = {}): ProjectRouteSnapshot {
  return { chainId: 8453, projectId: '7', handle: 'design.juicebox', authority, isRevnet: true, checkedAt: Date.now(), serverNow: Date.now(), ...overrides }
}
function browser(pathname = '/@design.juicebox') {
  const listeners = new Map<string, Set<(event: Event) => void>>()
  const location = { pathname, hash: '', reload: vi.fn() }
  const dispatchEvent = (event: Event) => {
    for (const listener of listeners.get(event.type) ?? []) listener(event)
    return true
  }
  return {
    location, dispatchEvent,
    history: { state: { __NA: true }, replaceState: vi.fn((_state: unknown, _title: string, hash: string) => { location.hash = hash }) },
    addEventListener: (type: string, listener: (event: Event) => void) => {
      const rows = listeners.get(type) ?? new Set(); rows.add(listener); listeners.set(type, rows)
    },
    removeEventListener: (type: string, listener: (event: Event) => void) => { listeners.get(type)?.delete(listener) },
  }
}
function LocalState() {
  const [count, setCount] = useState(0)
  return <button data-local onClick={() => setCount(count + 1)}>{count}</button>
}
const trees: TestRenderer.ReactTestRenderer[] = []
afterEach(async () => { for (const tree of trees.splice(0)) await act(async () => tree.unmount()) })
async function setup(initial = snapshot(), pathname?: string) {
  vi.mocked(fetch).mockResolvedValue(Response.json({ ...initial, checkedAt: Date.now(), serverNow: Date.now() }))
  const win = browser(pathname)
  vi.stubGlobal('window', win)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  let scope: ProjectReviewScope | null = null
  function ScopeProbe() {
    const current = useProjectReviewScope()
    useLayoutEffect(() => { scope = current }, [current])
    return null
  }
  const view = (route: ProjectRouteSnapshot) => <QueryClientProvider client={client}>
    <ProjectRouteProvider><ProjectRouteBoundary snapshot={route}><ScopeProbe /><LocalState /></ProjectRouteBoundary></ProjectRouteProvider>
  </QueryClientProvider>
  let tree!: TestRenderer.ReactTestRenderer
  await act(async () => { tree = TestRenderer.create(view(initial)) })
  trees.push(tree)
  vi.mocked(fetch).mockClear()
  const count = () => tree.root.findByProps({ 'data-local': true }).children.join('')
  const blocked = () => tree.root.findAll(node => node.type === 'div' && node.props.inert === true).length > 0
  return { win, client, tree, count, blocked, scope: () => scope, update: async (route: ProjectRouteSnapshot) => { await act(async () => tree.update(view(route))) } }
}
const response = (route: ProjectRouteSnapshot) => Response.json(route)

describe('verified client-local alias navigation', () => {
  it('reuses a fresh verification without network, reload or state loss, and does not poll while idle', async () => {
    vi.useFakeTimers()
    const { win, tree, count } = await setup()
    await act(async () => tree.root.findByProps({ 'data-local': true }).props.onClick())
    await act(async () => { replaceProjectTabHash('#owners'); replaceProjectTabHash('#shop/customers') })
    expect(win.location.hash).toBe('#shop/customers')
    expect(count()).toBe('1')
    await act(async () => { vi.advanceTimersByTime(60_000) })
    expect(fetch).not.toHaveBeenCalled()
    expect(win.location.reload).not.toHaveBeenCalled()
  })

  it('deduplicates concurrent expired navigation, gates pending actions, and commits only the last requested tab', async () => {
    vi.useFakeTimers()
    const { win, blocked } = await setup()
    await act(async () => { vi.advanceTimersByTime(6_000) })
    let finish!: (value: Response) => void
    vi.mocked(fetch).mockImplementation(() => new Promise(resolve => { finish = resolve }))
    await act(async () => { replaceProjectTabHash('#owners'); replaceProjectTabHash('#shop') })
    expect(blocked()).toBe(true)
    const calls = vi.mocked(fetch).mock.calls.length
    await act(async () => finish(response(snapshot())))
    expect(vi.mocked(fetch).mock.calls.length).toBe(calls)
    expect(win.location.hash).toBe('#shop')
    expect(blocked()).toBe(false)
    expect(win.location.reload).not.toHaveBeenCalled()
  })

  it('keeps expired verification failures gated and retries without reviving stale cache data', async () => {
    vi.useFakeTimers()
    const { win, tree, blocked } = await setup()
    vi.mocked(fetch).mockResolvedValue(new Response('', { status: 503 }))
    await act(async () => { vi.advanceTimersByTime(5_001) })
    await act(async () => replaceProjectTabHash('#owners'))
    expect(blocked()).toBe(true)
    expect(win.location.hash).toBe('')
    expect(tree.root.findAllByType('p').map(node => node.children.join('')).join('')).toContain('could not be verified')
    vi.mocked(fetch).mockResolvedValue(response(snapshot()))
    await act(async () => tree.root.findAllByType('button').find(node => node.children.join('') === 'Try again')!.props.onClick())
    expect(blocked()).toBe(false)
    expect(win.location.hash).toBe('') // Failed interactions never replay on Retry.
    expect(win.location.reload).not.toHaveBeenCalled()
  })

  it.each([
    { projectId: '8' },
    { authority: `0x${'34'.repeat(20)}` },
  ])('replaces the document once only after a proven changed binding %j', async changed => {
    vi.useFakeTimers()
    const { tree, win, count, blocked, scope } = await setup()
    const originalScope = scope()!
    await act(async () => tree.root.findByProps({ 'data-local': true }).props.onClick())
    await act(async () => { vi.advanceTimersByTime(5_001) })
    vi.mocked(fetch).mockResolvedValue(response(snapshot(changed)))
    await act(async () => replaceProjectTabHash('#owners'))
    expect(blocked()).toBe(true)
    expect(count()).toBe('1') // The old UI stays blocked until its document is discarded.
    expect(win.location.hash).toBe('#owners')
    expect(win.location.reload).toHaveBeenCalledOnce()
    await act(async () => {
      replaceProjectTabHash('#shop')
      win.dispatchEvent(new Event('focus'))
    })
    expect(await originalScope.verify()).toBe(false)
    expect(win.location.reload).toHaveBeenCalledOnce()
    expect(win.location.hash).toBe('#owners')
  })

  it('ignores an old alias response after navigation to another project', async () => {
    vi.useFakeTimers()
    const { win, blocked, update } = await setup()
    await act(async () => { vi.advanceTimersByTime(5_001) })
    let finish!: (response: Response) => void
    vi.mocked(fetch).mockImplementation(() => new Promise(resolve => { finish = resolve }))
    await act(async () => replaceProjectTabHash('#owners'))
    expect(blocked()).toBe(true)
    win.location.pathname = '/base:9'
    await update(snapshot({ projectId: '9', handle: null, authority: null, isRevnet: null }))
    await act(async () => finish(response(snapshot({ projectId: '8' }))))
    expect(blocked()).toBe(false)
    expect(win.location.hash).toBe('')
    expect(win.location.reload).not.toHaveBeenCalled()
  })

  it('verifies expired Back/BFCache and direct hash changes without reloading', async () => {
    vi.useFakeTimers()
    const { win, blocked } = await setup(snapshot(), '/%40design.juicebox')
    vi.mocked(fetch).mockImplementation(async () => response(snapshot()))
    await act(async () => { vi.advanceTimersByTime(5_001) })
    await act(async () => { win.dispatchEvent(new Event('popstate')) })
    expect(fetch).toHaveBeenCalledOnce()
    await act(async () => {
      win.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }))
      win.dispatchEvent(new Event('hashchange'))
    })
    expect(fetch).toHaveBeenCalledOnce()
    expect(blocked()).toBe(false)
    expect(win.location.reload).not.toHaveBeenCalled()
  })

  it('does not let a rejected old approval proof poison a newly registered project', async () => {
    vi.useFakeTimers()
    const { win, blocked, update, scope } = await setup()
    const original = scope()!
    await act(async () => { vi.advanceTimersByTime(5_001) })
    let fail!: (error: Error) => void
    vi.mocked(fetch).mockImplementation(() => new Promise((_resolve, reject) => { fail = reject }))
    let approved!: Promise<boolean>
    await act(async () => { approved = original.verify() })
    win.location.pathname = '/base:9'
    await update(snapshot({ projectId: '9', handle: null, authority: null, isRevnet: null }))
    await act(async () => fail(new Error('Old proof failed late')))
    expect(await approved).toBe(false)
    expect(blocked()).toBe(false)
  })

  it('declines approval and replaces the document when a slow review proves a changed binding', async () => {
    vi.useFakeTimers()
    const { win, scope, blocked } = await setup()
    const originalScope = scope()!
    await act(async () => { vi.advanceTimersByTime(20_000) })
    vi.mocked(fetch).mockResolvedValue(response(snapshot({ projectId: '8' })))
    let approved = true
    await act(async () => { approved = await originalScope.verify() })
    expect(approved).toBe(false)
    expect(blocked()).toBe(true)
    expect(win.location.reload).toHaveBeenCalledOnce()
  })

  it('leaves numeric routes on the native local path', async () => {
    const { win } = await setup(snapshot({ handle: null, authority: null, isRevnet: null }), '/base:7')
    await act(async () => replaceProjectTabHash('#owners'))
    expect(win.location.hash).toBe('#owners')
    expect(fetch).not.toHaveBeenCalled()
    expect(win.location.reload).not.toHaveBeenCalled()
  })
})
