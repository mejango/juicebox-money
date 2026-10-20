import { createElement, Suspense, type ComponentType } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'

const deferred = vi.hoisted(() => {
  let resolve!: (value: { default: ComponentType<unknown> }) => void
  const promise = new Promise<{ default: ComponentType<unknown> }>(done => { resolve = done })
  return { promise, resolve }
})

// Next's real boundary and the production options; only the chunk is held.
vi.mock('next/dynamic', async importOriginal => {
  const { default: dynamic } = await importOriginal<typeof import('next/dynamic')>()
  return {
    default: (_loader: unknown, options: Parameters<typeof dynamic>[1]) =>
      dynamic(() => deferred.promise, options),
  }
})

import { ProjectHandleCard } from '@/components/project/ProjectHandleCardLazy'

it('loads the handle card under its own boundary, keeping the project in view', async () => {
  let renderer!: TestRenderer.ReactTestRenderer
  await act(async () => {
    renderer = TestRenderer.create(
      <Suspense fallback={<p>Route skeleton</p>}>
        <h1>Project identity</h1>
        {createElement(ProjectHandleCard as ComponentType)}
      </Suspense>,
    )
  })
  expect(JSON.stringify(renderer.toJSON())).not.toContain('Route skeleton')
  expect(renderer.root.findByProps({ role: 'status' }).children).toEqual(['Loading handle…'])

  await act(async () => {
    deferred.resolve({ default: () => <p>Handle card</p> })
    await deferred.promise
  })
  expect(renderer.root.findAllByProps({ role: 'status' })).toHaveLength(0)
  expect(renderer.root.findByType('h1').children).toEqual(['Project identity'])
  await act(async () => renderer.unmount())
})
