import { createElement, Suspense, type ComponentType } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'

const deferred = vi.hoisted(() => {
  let resolve!: (value: { default: ComponentType<unknown> }) => void
  const promise = new Promise<{ default: ComponentType<unknown> }>(done => { resolve = done })
  return { promise, resolve }
})

// Keep Next's actual boundaries and the production loading options; control
// only the chunk loader to reproduce a slow first visit deterministically.
vi.mock('next/dynamic', async importOriginal => {
  const { default: dynamic } = await importOriginal<typeof import('next/dynamic')>()
  return {
    default: (_loader: unknown, options: Parameters<typeof dynamic>[1]) =>
      dynamic(() => deferred.promise, options),
  }
})

import * as tabs from '@/components/project/LazyProjectTabs'

it('shows accessible local loading feedback while a tab chunk is pending and retains the project', async () => {
  let renderer!: TestRenderer.ReactTestRenderer
  await act(async () => {
    renderer = TestRenderer.create(
      <Suspense fallback={<p>Route skeleton</p>}>
        <h1>Project identity</h1>
        {Object.entries(tabs).map(([name, Tab]) =>
          createElement(Tab as ComponentType, { key: name }),
        )}
      </Suspense>,
    )
  })
  expect(renderer.root.findByType('h1').children).toEqual(['Project identity'])
  expect(renderer.root.findAllByProps({ role: 'status' }).map(node => node.props['aria-label'])).toEqual([
    'Loading back office',
    'Loading extras',
    'Loading funds',
    'Loading token holders',
    'Loading rulesets',
    'Loading shop',
    'Loading terms',
  ])
  expect(JSON.stringify(renderer.toJSON())).not.toContain('Route skeleton')

  await act(async () => {
    deferred.resolve({ default: () => <p data-ready-tab>Tab content</p> })
    await deferred.promise
  })
  expect(renderer.root.findAllByProps({ role: 'status' })).toHaveLength(0)
  expect(renderer.root.findAll(node => node.props?.['data-ready-tab'])).toHaveLength(7)
  expect(renderer.root.findByType('h1').children).toEqual(['Project identity'])
  await act(async () => renderer.unmount())
})
