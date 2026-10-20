import { createElement } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  assign: vi.fn(),
  reload: vi.fn(),
  replaceState: vi.fn(),
  lookupEnsAddress: vi.fn(),
  fetch: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push }),
}))
vi.mock('next/image', () => ({
  default: (props: Record<string, unknown>) =>
    createElement('img', { ...props, src: 'img', priority: undefined }),
}))
vi.mock('@/hooks/useOutsideClose', () => ({
  useOutsideClose: () => {},
}))
vi.mock('@/hooks/useEnsName', () => ({
  useEnsName: () => ({ data: null }),
}))
// Hold the lazy ENSIP-15 normalizer while a handle is submitted.
const gate = vi.hoisted(() => {
  let open!: () => void
  const opened = new Promise<void>(done => { open = done })
  return { opened, open }
})
vi.mock('@/lib/project-handles', async importOriginal => {
  await gate.opened
  return importOriginal()
})
vi.mock('@/lib/ens', async importOriginal => {
  const original = await importOriginal<typeof import('@/lib/ens')>()
  return { ...original, lookupEnsAddress: mocks.lookupEnsAddress }
})

import { SearchBox } from '@/components/SearchBox'
import { projectHandleFromRoute } from '@/lib/project-handle-route'

it('a handle submitted while its normalizer loads navigates at once, and only once', async () => {
  vi.stubGlobal('fetch', mocks.fetch)
  vi.stubGlobal('window', {
    location: { assign: mocks.assign, pathname: '/', search: '', reload: mocks.reload },
    history: { state: null, replaceState: mocks.replaceState },
  })
  let renderer!: TestRenderer.ReactTestRenderer
  await act(async () => {
    renderer = TestRenderer.create(createElement(SearchBox, { expanded: true }))
  })
  const input = () => renderer.root.findByType('input')
  await act(async () => input().props.onChange({ target: { value: '@old.juicebox' } }))
  await act(async () => input().props.onKeyDown({ key: 'Enter' }))
  // The server normalizes the handle; nothing waits to navigate later.
  expect(mocks.assign).toHaveBeenCalledExactlyOnceWith('/@old.juicebox')

  await act(async () => {
    gate.open()
    await projectHandleFromRoute('@settled')
    await new Promise(done => setTimeout(done, 0))
  })
  expect(mocks.assign).toHaveBeenCalledOnce()
  expect(mocks.push).not.toHaveBeenCalled()
  await act(async () => renderer.unmount())
})
