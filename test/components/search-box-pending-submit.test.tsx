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
// Hold the lazy ENSIP-15 normalizer so a newer submit can land first.
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
import { toUrn } from '@/lib/urn'

it('a submit waiting on the handle normalizer never overrides a newer one', async () => {
  vi.stubGlobal('fetch', mocks.fetch)
  vi.stubGlobal('window', {
    location: { assign: mocks.assign, pathname: '/', reload: mocks.reload },
    history: { state: null, replaceState: mocks.replaceState },
  })
  let renderer!: TestRenderer.ReactTestRenderer
  await act(async () => {
    renderer = TestRenderer.create(createElement(SearchBox, { expanded: true }))
  })
  const input = () => renderer.root.findByType('input')
  await act(async () => input().props.onChange({ target: { value: '@old.juicebox' } }))
  await act(async () => input().props.onKeyDown({ key: 'Enter' }))
  await act(async () => input().props.onChange({ target: { value: 'base:9' } }))
  await act(async () => input().props.onKeyDown({ key: 'Enter' }))
  expect(mocks.push).toHaveBeenCalledWith(`/${toUrn(8453, 9)}`)

  await act(async () => {
    gate.open()
    await new Promise(done => setTimeout(done, 20))
  })
  expect(mocks.assign).not.toHaveBeenCalled()
  expect(mocks.reload).not.toHaveBeenCalled()
})
