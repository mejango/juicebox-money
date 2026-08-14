import { createElement } from 'react'
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer'
import type { Address } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
vi.mock('@/lib/ens', async importOriginal => {
  const original = await importOriginal<typeof import('@/lib/ens')>()
  return { ...original, lookupEnsAddress: mocks.lookupEnsAddress }
})

import { SearchBox } from '@/components/SearchBox'
import { toUrn } from '@/lib/urn'

const BOB = '0x2222222222222222222222222222222222222222' as Address

function renderedText(instance: ReactTestInstance): string {
  return instance.children
    .map(child =>
      typeof child === 'string'
        ? child
        : typeof child === 'number'
          ? String(child)
          : renderedText(child),
    )
    .join('')
}

async function render() {
  let renderer!: TestRenderer.ReactTestRenderer
  await act(async () => {
    renderer = TestRenderer.create(createElement(SearchBox, { expanded: true }))
  })
  return renderer
}

async function type(renderer: TestRenderer.ReactTestRenderer, value: string) {
  await act(async () => {
    renderer.root.findByType('input').props.onChange({ target: { value } })
  })
}

async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(400)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('fetch', mocks.fetch)
  vi.stubGlobal('window', {
    location: { assign: mocks.assign, pathname: '/', reload: mocks.reload },
    history: { state: null, replaceState: mocks.replaceState },
  })
  mocks.fetch.mockResolvedValue({
    ok: true,
    json: async () => ({ projects: [] }),
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('SearchBox account results', () => {
  it('supports the compact mobile placeholder without changing its accessible label', async () => {
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(SearchBox, { expanded: true, placeholder: 'Search' }),
      )
    })
    const input = renderer.root.findByType('input')
    expect(input.props.placeholder).toBe('Search')
    expect(input.props['aria-label']).toBe('Search projects')
  })

  it('shows an account row for a pasted address and navigates on Enter', async () => {
    const renderer = await render()
    await type(renderer, ` ${BOB} `)

    const text = renderedText(renderer.root)
    expect(text).toContain('View account')
    expect(text).toContain('0x2222…2222')
    expect(mocks.lookupEnsAddress).not.toHaveBeenCalled()

    await act(async () => {
      renderer.root.findByType('input').props.onKeyDown({ key: 'Enter' })
    })
    expect(mocks.push).toHaveBeenCalledWith(`/account/${BOB}`)
  })

  it('debounce-resolves ENS names and navigates by name', async () => {
    mocks.lookupEnsAddress.mockResolvedValue(BOB)
    const renderer = await render()
    await type(renderer, 'Bob.eth')

    // While the lookup is pending, a subtle resolving row shows.
    expect(renderedText(renderer.root)).toContain('Resolving Bob.eth')
    expect(renderedText(renderer.root)).not.toContain('View account')

    await settle()
    expect(mocks.lookupEnsAddress).toHaveBeenCalledWith('Bob.eth')
    const text = renderedText(renderer.root)
    expect(text).toContain('bob.eth')
    expect(text).toContain('0x2222…2222')
    expect(text).toContain('View account')

    await act(async () => {
      renderer.root.findByType('input').props.onKeyDown({ key: 'Enter' })
    })
    expect(mocks.push).toHaveBeenCalledWith('/account/bob.eth')
  })

  it('shows nothing extra when an ENS name does not resolve', async () => {
    mocks.lookupEnsAddress.mockResolvedValue(null)
    const renderer = await render()
    await type(renderer, 'missing.eth')
    await settle()
    expect(renderedText(renderer.root)).not.toContain('View account')
    expect(renderedText(renderer.root)).not.toContain('Resolving')
  })

  it('keeps ordinary text on project search with no account row', async () => {
    mocks.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        projects: [
          {
            projectId: 3,
            chainId: 1,
            name: 'Juicebox',
            logoUri: null,
            projectTagline: null,
            ticker: 'JBX',
            chainIds: [1],
          },
        ],
      }),
    })
    const renderer = await render()
    await type(renderer, 'juice')
    await settle()

    const text = renderedText(renderer.root)
    expect(text).toContain('Juicebox')
    expect(text).not.toContain('View account')
    expect(mocks.lookupEnsAddress).not.toHaveBeenCalled()

    await act(async () => {
      renderer.root.findByType('input').props.onKeyDown({ key: 'Enter' })
    })
    expect(mocks.push).toHaveBeenCalledWith(`/${toUrn(1, 3)}`)
  })

  it('routes an explicit @handle without treating it as account ENS', async () => {
    const renderer = await render()
    await type(renderer, '@Design.Juicebox')

    expect(renderedText(renderer.root)).toContain(
      'Go to project @design.juicebox',
    )
    expect(mocks.lookupEnsAddress).not.toHaveBeenCalled()
    expect(mocks.fetch).not.toHaveBeenCalled()

    await act(async () => {
      renderer.root.findByType('input').props.onKeyDown({ key: 'Enter' })
    })
    expect(mocks.assign).toHaveBeenCalledWith('/@design.juicebox')
    expect(mocks.push).not.toHaveBeenCalled()
  })

  it('reloads when navigating to the same mutable alias pathname', async () => {
    ;(window.location as unknown as { pathname: string }).pathname =
      '/@design.juicebox'
    const renderer = await render()
    await type(renderer, '@design.juicebox')

    await act(async () => {
      renderer.root.findByType('input').props.onKeyDown({ key: 'Enter' })
    })

    expect(mocks.replaceState).toHaveBeenCalledWith(
      null,
      '',
      '/@design.juicebox',
    )
    expect(mocks.reload).toHaveBeenCalledOnce()
    expect(mocks.assign).not.toHaveBeenCalled()
  })

  it('ignores an older free-text response after @handle input wins', async () => {
    let resolveJson!: (value: { projects: ResultFixture[] }) => void
    const json = new Promise<{ projects: ResultFixture[] }>(resolve => {
      resolveJson = resolve
    })
    mocks.fetch.mockResolvedValue({ ok: true, json: () => json })
    const renderer = await render()
    await type(renderer, 'old project')
    await settle()
    expect(mocks.fetch).toHaveBeenCalledOnce()

    await type(renderer, '@design.juicebox')
    await act(async () => {
      resolveJson({
        projects: [
          {
            projectId: 99,
            chainId: 1,
            name: 'Stale result',
            logoUri: null,
            projectTagline: null,
            ticker: null,
            chainIds: [1],
          },
        ],
      })
      await Promise.resolve()
    })

    expect(renderedText(renderer.root)).toContain(
      'Go to project @design.juicebox',
    )
    expect(renderedText(renderer.root)).not.toContain('Stale result')
  })
})

type ResultFixture = {
  projectId: number
  chainId: number
  name: string | null
  logoUri: string | null
  projectTagline: string | null
  ticker: string | null
  chainIds: number[]
}

/**
 * Search is where a chain gets picked before any money moves, and the testnet
 * names differ by one word. Every named chain in a result row carries its mark.
 * The mark is decorative — the name beside it is what assistive tech reads — so
 * the marks are counted, not read.
 */
function chainMarkCount(renderer: TestRenderer.ReactTestRenderer): number {
  return renderer.root.findAll(
    node => node.type === 'img' && node.props['aria-hidden'] === 'true',
    { deep: true },
  ).length
}

describe('SearchBox chain marks', () => {
  it('marks every chain a project result lists', async () => {
    mocks.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        projects: [
          {
            projectId: 3,
            chainId: 1,
            name: 'Juicebox',
            logoUri: null,
            projectTagline: null,
            ticker: 'JBX',
            chainIds: [1, 8453],
          },
        ],
      }),
    })
    const renderer = await render()
    await type(renderer, 'juice')
    await settle()

    // The names stay visible; the marks are added beside them, never instead.
    const text = renderedText(renderer.root)
    expect(text).toContain('Ethereum')
    expect(text).toContain('Base')
    expect(chainMarkCount(renderer)).toBe(2)
  })

  it('marks the chain on a direct urn row', async () => {
    mocks.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        projects: [
          {
            projectId: 3,
            chainId: 1,
            name: 'Juicebox',
            logoUri: null,
            projectTagline: null,
            ticker: 'JBX',
            chainIds: [1],
          },
        ],
      }),
    })
    const renderer = await render()
    // A urn alone never opens the dropdown; it replaces an already-open list.
    await type(renderer, 'juice')
    await settle()
    await type(renderer, 'basesep:5')
    await settle()

    expect(renderedText(renderer.root)).toContain('Base Sepolia')
    expect(chainMarkCount(renderer)).toBe(1)
  })
})
