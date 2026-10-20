import { useLayoutEffect } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import {
  ProjectRouteBoundary, ProjectRouteProvider, useProjectReviewScope, type ProjectReviewScope,
} from '@/providers/ProjectRouteContext'
import { replaceProjectTabHash } from '@/components/project/Tabs'
import { peekProjectHandleFromRoute, projectHandleFromRoute } from '@/lib/project-handle-route'

// Handle routes load ENSIP-15 normalization lazily. Until it loads, the alias
// owner must neither approve a review nor commit a tab change unverified.
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

const authority = `0x${'12'.repeat(20)}`
const snapshot = () => ({
  chainId: 8453 as const, projectId: '7', handle: 'design.juicebox', authority,
  isRevnet: true, checkedAt: Date.now(), serverNow: Date.now(),
})

let tree: TestRenderer.ReactTestRenderer | undefined
afterEach(async () => { if (tree) await act(async () => tree!.unmount()) })

it('fails closed while the handle normalizer loads, then verifies and commits', async () => {
  const location = { pathname: '/@design.juicebox', hash: '', reload: vi.fn() }
  const listeners = new Map<string, Set<(event: Event) => void>>()
  vi.stubGlobal('window', {
    location,
    history: { state: null, replaceState: vi.fn((_state: unknown, _title: string, hash: string) => { location.hash = hash }) },
    dispatchEvent: (event: Event) => { for (const listener of listeners.get(event.type) ?? []) listener(event); return true },
    addEventListener: (type: string, listener: (event: Event) => void) => {
      listeners.set(type, (listeners.get(type) ?? new Set()).add(listener))
    },
    removeEventListener: (type: string, listener: (event: Event) => void) => { listeners.get(type)?.delete(listener) },
  })
  vi.mocked(fetch).mockImplementation(async () => Response.json(snapshot()))
  expect(peekProjectHandleFromRoute('@design.juicebox')).toBeUndefined()

  let scope: ProjectReviewScope | null = null
  function ScopeProbe() {
    const current = useProjectReviewScope()
    useLayoutEffect(() => { scope = current }, [current])
    return null
  }
  await act(async () => {
    tree = TestRenderer.create(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ProjectRouteProvider><ProjectRouteBoundary snapshot={snapshot()}><ScopeProbe /></ProjectRouteBoundary></ProjectRouteProvider>
      </QueryClientProvider>,
    )
  })
  expect(peekProjectHandleFromRoute('@design.juicebox')).toBeUndefined()
  expect(await scope!.verify()).toBe(false)
  act(() => replaceProjectTabHash('#owners'))
  expect(location.hash).toBe('')

  await act(async () => { await projectHandleFromRoute('@design.juicebox') })
  await vi.waitFor(() => expect(location.hash).toBe('#owners'))
  expect(vi.mocked(fetch).mock.calls.map(([url]) => String(url))).toContain(
    '/api/project-route?segment=%40design.juicebox',
  )
  await act(async () => { expect(await scope!.verify()).toBe(true) })
})
