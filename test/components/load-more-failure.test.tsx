import { createElement } from 'react'
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('next/image', () => ({
  default: (props: Record<string, unknown>) => createElement('img', { ...props, src: 'img' }),
}))
vi.mock('@/hooks/useShop721', () => ({ useShop721: vi.fn(), useShop721Media: vi.fn() }))
vi.mock('@/hooks/useProjectTokenUnit', () => ({ useProjectTokenUnit: () => 'tokens' }))
vi.mock('@/hooks/useEnsName', () => ({ useEnsName: () => ({ data: null }) }))
vi.mock('@/components/ProjectLink', () => ({
  ProjectLink: ({ children }: { children: unknown }) => createElement('a', null, children as never),
}))

import { FreshActivity } from '@/components/FreshActivity'
import { TopProjectRows } from '@/components/TopProjectRows'
import type { BsFreshActivityEvent } from '@/lib/bendystraw'
import type { TopBalanceProject } from '@/lib/top-projects'

let renderer: ReactTestRenderer | undefined
const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('document', { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} })
})

afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount())
  renderer = undefined
})

function text(root: ReactTestRenderer) {
  return root.root.findAll(node => typeof node.type === 'string').map(node =>
    node.children.filter(child => typeof child === 'string').join(''),
  ).join('\n')
}

function loadMoreButton(root: ReactTestRenderer, label: string) {
  return root.root.find(node => node.type === 'button' && node.children.includes(label))
}

const freshEvent = {
  id: 'one',
  chainId: 1,
  projectId: 2,
  timestamp: 1,
  txHash: '0x01',
  from: '0x1111111111111111111111111111111111111111',
  project: { name: 'One', logoUri: null },
  projectCreateEvent: { from: '0x1111111111111111111111111111111111111111' },
} as unknown as BsFreshActivityEvent

const topProject = {
  key: 'p1',
  href: '/p1',
  name: 'One',
  projectId: 1,
  logoUri: null,
  tagline: null,
  balanceUsd: 10,
} as unknown as TopBalanceProject

describe.each([
  {
    name: 'FreshActivity',
    label: 'More activity',
    error: 'Could not load more activity. Try again.',
    element: () => <FreshActivity initialEvents={[freshEvent]} initialHasMore />,
    page: { events: [{ ...freshEvent, id: 'two', txHash: '0x02', project: { name: 'Two', logoUri: null } }], hasMore: false },
  },
  {
    name: 'TopProjectRows',
    label: 'More projects',
    error: 'Could not load more projects. Try again.',
    element: () => <TopProjectRows initialProjects={[topProject]} initialHasMore />,
    page: { projects: [{ ...topProject, key: 'p2', name: 'Two' }], hasMore: false },
  },
])('$name load more', ({ label, error, element, page }) => {
  it('keeps the row with a retry line after a failed page, and the retry loads it', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'))
    await act(async () => { renderer = TestRenderer.create(element()) })

    await act(async () => { loadMoreButton(renderer!, label).props.onClick() })
    expect(loadMoreButton(renderer!, label)).toBeTruthy()
    expect(text(renderer!)).toContain(error)

    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => page })
    await act(async () => { loadMoreButton(renderer!, label).props.onClick() })
    expect(text(renderer!)).not.toContain(error)
    expect(text(renderer!)).toContain('Two')
    expect(renderer!.root.findAll(node => node.type === 'button' && node.children.includes(label))).toHaveLength(0)
  })
})
