// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProjectTabIcon } from '@/components/project/ProjectTabIcon'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('ProjectTabIcon', () => {
  it('uses the banknotes artwork for a non-revnet Funds tab', () => {
    act(() => root.render(<ProjectTabIcon label="Funds" />))

    expect(
      container.querySelector('[data-project-tab-icon="funds"]'),
    ).not.toBeNull()
  })
})
