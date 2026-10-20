import TestRenderer, { act } from 'react-test-renderer'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import { ProjectRouteBoundary, ProjectRouteProvider } from '@/providers/ProjectRouteContext'
import type { ProjectRouteSnapshot } from '@/lib/project-route'

// Hold the lazy ENSIP-15 normalizer so a later route can supersede the alias.
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

const location = { pathname: '/@design.juicebox', hash: '', reload: vi.fn() }
const snapshot = (handle: string | null, projectId: string): ProjectRouteSnapshot => ({
  chainId: 8453, projectId, handle, authority: `0x${'12'.repeat(20)}`,
  isRevnet: true, checkedAt: 0, serverNow: 0,
})

let tree: TestRenderer.ReactTestRenderer | undefined
afterEach(async () => { if (tree) await act(async () => tree!.unmount()) })

it('a numeric route that replaces an alias stays visible once the alias normalizer loads', async () => {
  vi.stubGlobal('window', {
    location,
    history: { state: null, replaceState: vi.fn() },
    dispatchEvent: () => true, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  })
  vi.mocked(fetch).mockImplementation(async () => Response.json(snapshot('design.juicebox', '7')))
  const page = (route: ProjectRouteSnapshot) => (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ProjectRouteProvider><ProjectRouteBoundary snapshot={route}><p>Project content</p></ProjectRouteBoundary></ProjectRouteProvider>
    </QueryClientProvider>
  )
  await act(async () => { tree = TestRenderer.create(page(snapshot('design.juicebox', '7'))) })

  location.pathname = '/base:9'
  await act(async () => tree!.update(page(snapshot(null, '9'))))
  await act(async () => {
    gate.open()
    await new Promise(done => setTimeout(done, 20))
  })
  const statuses = tree!.root.findAll(node => node.props?.role === 'status')
  expect(statuses).toHaveLength(0)
  expect(tree!.root.findByType('p').children).toEqual(['Project content'])
})
