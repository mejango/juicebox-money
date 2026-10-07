import { createElement } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  groupActivity: vi.fn(),
  projectActivity: vi.fn(),
}))

vi.mock('@/lib/bendystraw', () => ({
  getProjectActivity: mocks.groupActivity,
  getProjectActivityByProject: mocks.projectActivity,
}))
vi.mock('next/image', () => ({
  default: (props: Record<string, unknown>) => createElement('img', { ...props, src: 'img' }),
}))
vi.mock('@/hooks/useShop721', () => ({ useShop721: vi.fn(), useShop721Media: vi.fn() }))
vi.mock('@/hooks/useProjectTokenUnit', () => ({ useProjectTokenUnit: () => 'tokens' }))
vi.mock('@/hooks/useEnsName', () => ({ useEnsName: () => ({ data: null }) }))

import { ActivityList } from '@/components/ActivityList'
import type { BsActivityEvent } from '@/lib/bendystraw'

const NOW = 1_700_000_000_000
type Props = Parameters<typeof ActivityList>[0]
type Page = { items: BsActivityEvent[]; totalCount: number }
let renderer: TestRenderer.ReactTestRenderer | undefined
let visibility: 'visible' | 'hidden'
let visibilityListeners: Set<() => void>

function event(id: string, timestamp: number): BsActivityEvent {
  return {
    id,
    chainId: 1,
    projectId: 2,
    timestamp,
    txHash: `0x${id}`,
    from: '0x1111111111111111111111111111111111111111',
    projectCreateEvent: { from: '0x1111111111111111111111111111111111111111' },
  } as BsActivityEvent
}

async function render(props: Partial<Props> = {}) {
  await act(async () => {
    renderer = TestRenderer.create(
      <ActivityList chainId={1} projectId={2} events={[]} {...props} />,
    )
  })
  return renderer!
}

async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

async function show(state: 'visible' | 'hidden') {
  await act(async () => {
    visibility = state
    visibilityListeners.forEach(listener => listener())
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  mocks.groupActivity.mockReset().mockResolvedValue({ items: [], totalCount: 0 })
  mocks.projectActivity.mockReset().mockResolvedValue({ items: [], totalCount: 0 })
  visibility = 'visible'
  visibilityListeners = new Set()
  vi.stubGlobal('window', { setTimeout, clearTimeout })
  vi.stubGlobal('document', {
    get visibilityState() { return visibility },
    addEventListener: (_name: string, listener: () => void) => visibilityListeners.add(listener),
    removeEventListener: (_name: string, listener: () => void) => visibilityListeners.delete(listener),
  })
})

afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount())
  renderer = undefined
})

describe('activity freshness', () => {
  it.each([{ events: [] }, { events: [event('first', 3)] }])('uses the remaining server freshness before polling, including empty success (%j)', async ({ events }) => {
    await render({ events, initialEventsUpdatedAt: NOW - 5_000 })
    expect(mocks.projectActivity).not.toHaveBeenCalled()
    await advance(9_999)
    await show('visible')
    expect(mocks.projectActivity).not.toHaveBeenCalled()
    await advance(1)
    expect(mocks.projectActivity).toHaveBeenCalledOnce()
    await advance(14_999)
    await show('visible')
    expect(mocks.projectActivity).toHaveBeenCalledOnce()
    await advance(1)
    expect(mocks.projectActivity).toHaveBeenCalledTimes(2)
  })

  it.each([
    { initialEventsUpdatedAt: undefined },
    { initialEventsUpdatedAt: NOW - 15_000 },
    { initialEventsUpdatedAt: NOW + 1_000 },
    { initialEventsUpdatedAt: Number.NaN },
    { initialEventsUpdatedAt: NOW, error: true },
  ])('refreshes immediately when server freshness is unknown, expired or failed (%j)', async props => {
    await render(props)
    expect(mocks.projectActivity).toHaveBeenCalledWith(1, 2, 250, 0, {
      signal: expect.any(AbortSignal),
    })
    expect(JSON.stringify(renderer!.toJSON())).not.toContain('temporarily unavailable')
  })

  it('keeps a server failure visible until a successful retry, then gives an empty success its TTL', async () => {
    mocks.projectActivity.mockRejectedValueOnce(new Error('offline'))
    await render({ error: true, initialEventsUpdatedAt: NOW })
    expect(JSON.stringify(renderer!.toJSON())).toContain('temporarily unavailable')
    await advance(14_999)
    expect(mocks.projectActivity).toHaveBeenCalledOnce()
    await advance(1)
    expect(mocks.projectActivity).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(renderer!.toJSON())).not.toContain('temporarily unavailable')
    await show('visible')
    expect(mocks.projectActivity).toHaveBeenCalledTimes(2)
  })

  it('coalesces timer and visibility triggers while a read is in flight and aborts on unmount', async () => {
    let resolve!: (page: Page) => void
    mocks.projectActivity.mockReturnValueOnce(new Promise<Page>(done => { resolve = done }))
    await render()
    const signal = mocks.projectActivity.mock.calls[0][4].signal as AbortSignal
    await advance(45_000)
    await show('hidden')
    await show('visible')
    await show('visible')
    expect(mocks.projectActivity).toHaveBeenCalledOnce()
    await act(async () => resolve({ items: [], totalCount: 0 }))
    await advance(14_999)
    expect(mocks.projectActivity).toHaveBeenCalledOnce()
    await advance(1)
    expect(mocks.projectActivity).toHaveBeenCalledTimes(2)
    await act(async () => renderer!.unmount())
    renderer = undefined
    expect(signal.aborted).toBe(true)
    expect(visibilityListeners.size).toBe(0)
    await advance(30_000)
    expect(mocks.projectActivity).toHaveBeenCalledTimes(2)
  })

  it('waits while hidden and refreshes an expired feed when visible again', async () => {
    visibility = 'hidden'
    await render({ initialEventsUpdatedAt: NOW })
    await advance(30_000)
    expect(mocks.projectActivity).not.toHaveBeenCalled()
    await show('visible')
    expect(mocks.projectActivity).toHaveBeenCalledOnce()
  })

  it('preserves older pages through failed and successful newest-page refreshes', async () => {
    const first = event('first', 3)
    const older = event('older', 1)
    const newest = event('newest', 5)
    mocks.groupActivity
      .mockResolvedValueOnce({ items: [older], totalCount: 3 })
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ items: [newest, first], totalCount: 3 })
    const view = await render({
      events: [first], total: 3, suckerGroupId: 'group', initialEventsUpdatedAt: NOW,
    })
    await act(async () => view.root.findByType('button').props.onClick())
    expect(mocks.groupActivity).toHaveBeenNthCalledWith(1, 'group', 250, 1, 1, {
      signal: expect.any(AbortSignal),
    })
    await advance(15_000)
    expect(JSON.stringify(view.toJSON())).toContain('/tx/0xolder')
    await advance(15_000)
    expect(mocks.groupActivity).toHaveBeenNthCalledWith(3, 'group', 250, 1, 0, {
      signal: expect.any(AbortSignal),
    })
    const rowLinks = view.root.findAll(node => node.type === 'a' && node.props.title)
    expect(rowLinks.map(node => node.props.href)).toEqual([
      'https://etherscan.io/tx/0xnewest',
      'https://etherscan.io/tx/0xfirst',
      'https://etherscan.io/tx/0xolder',
    ])
    expect(view.root.findAllByType('button')).toHaveLength(0)
    expect(mocks.projectActivity).not.toHaveBeenCalled()
  })

  it('aborts a prior scope and ignores its late response after the project changes', async () => {
    let resolve!: (page: Page) => void
    mocks.projectActivity.mockReturnValueOnce(new Promise<Page>(done => { resolve = done }))
    const view = await render()
    const signal = mocks.projectActivity.mock.calls[0][4].signal as AbortSignal
    await act(async () => {
      view.update(<ActivityList chainId={8453} projectId={7} events={[]} />)
    })
    expect(signal.aborted).toBe(true)
    expect(mocks.projectActivity).toHaveBeenNthCalledWith(2, 8453, 7, 250, 0, {
      signal: expect.any(AbortSignal),
    })
    await act(async () => resolve({ items: [event('stale', 5)], totalCount: 1 }))
    expect(JSON.stringify(view.toJSON())).not.toContain('/tx/0xstale')
  })
})
