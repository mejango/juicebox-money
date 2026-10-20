import TestRenderer, { act } from 'react-test-renderer'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import { ProjectRouteBoundary, ProjectRouteProvider } from '@/providers/ProjectRouteContext'
import { replaceProjectTabHash } from '@/components/project/Tabs'

// Hold the lazy ENSIP-15 normalizer while the window regains focus.
const gate = vi.hoisted(() => {
  let open!: () => void
  const opened = new Promise<void>(done => { open = done })
  return { opened, open }
})
vi.mock('@/lib/project-handles', async importOriginal => {
  await gate.opened
  return importOriginal()
})
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

const snapshot = () => ({
  chainId: 8453 as const, projectId: '7', handle: 'design.juicebox', authority: `0x${'12'.repeat(20)}`,
  isRevnet: true, checkedAt: Date.now(), serverNow: Date.now(),
})

let tree: TestRenderer.ReactTestRenderer | undefined
afterEach(async () => { if (tree) await act(async () => tree!.unmount()) })

it('a tab chosen while the normalizer loads still opens after a focus revalidation', async () => {
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
  await act(async () => {
    tree = TestRenderer.create(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ProjectRouteProvider><ProjectRouteBoundary snapshot={snapshot()}><p>Project</p></ProjectRouteBoundary></ProjectRouteProvider>
      </QueryClientProvider>,
    )
  })
  act(() => replaceProjectTabHash('#terms'))
  act(() => { window.dispatchEvent(new Event('focus')) })
  expect(location.hash).toBe('')

  await act(async () => { gate.open() })
  await vi.waitFor(() => expect(location.hash).toBe('#terms'))
})
