// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BsFreshActivityEvent } from '@/lib/bendystraw'

const mocks = vi.hoisted(() => ({ loadMore: undefined as (() => Promise<void>) | undefined }))
vi.mock('@/hooks/useInfiniteScroll', () => ({ useInfiniteScroll: (options: { loadMore: () => Promise<void> }) => { mocks.loadMore = options.loadMore; return undefined } }))
vi.mock('@/hooks/useProjectTokenUnit', () => ({ useProjectTokenUnit: () => 'tokens' }))
vi.mock('@/components/ActivityList', () => ({
  groupSameTxEvents: (events: BsFreshActivityEvent[]) => events.map(event => [event]),
  combinedActivityParts: () => ({ action: 'paid', actor: '0x1', amountUsd: '0', amountRaw: '0', direction: 'in' }),
}))
vi.mock('@/components/ActorLink', () => ({ ActorLink: () => null }))
vi.mock('@/components/ActivityMeta', () => ({ ActivityMeta: () => null }))
vi.mock('@/components/ProjectLogo', () => ({ ProjectLogo: () => null }))
vi.mock('@/components/ProjectLink', () => ({ ProjectLink: ({ children }: { children: ReactNode }) => <span>{children}</span> }))

import { FreshActivity } from '@/components/FreshActivity'

let root: Root | undefined
let container: HTMLDivElement
let displayed: boolean
let visibility: DocumentVisibilityState
let resize: () => void
let disconnect: ReturnType<typeof vi.fn>
let fetchMock: ReturnType<typeof vi.fn>

function event(id: string): BsFreshActivityEvent {
  return { id, projectId: 1, chainId: 1, timestamp: 1_700_000_000, project: { name: id, decimals: 6, tokenSymbol: 'USDC' } } as BsFreshActivityEvent
}
function response(...ids: string[]) {
  return { ok: true, json: async () => ({ events: ids.map(event), hasMore: false }) } as Response
}
function deferred() {
  let resolve!: (value: Response) => void
  const promise = new Promise<Response>(done => { resolve = done })
  return { promise, resolve }
}
async function mount(initialEvents = [event('server row')], initialHasMore = false) {
  await act(async () => {
    root = createRoot(container)
    root.render(<FreshActivity initialEvents={initialEvents} initialHasMore={initialHasMore} />)
  })
}
async function advance(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }
async function show(next: boolean) { await act(async () => { displayed = next; resize() }) }
async function documentVisible(next: DocumentVisibilityState) {
  await act(async () => { visibility = next; document.dispatchEvent(new Event('visibilitychange')) })
}

beforeEach(() => {
  vi.useFakeTimers()
  displayed = true
  visibility = 'visible'
  disconnect = vi.fn()
  resize = () => undefined
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resize = callback }
    observe() { resize() }
    disconnect = disconnect
  })
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(() => ({ length: displayed ? 1 : 0 }) as DOMRectList)
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
  fetchMock = vi.fn().mockResolvedValue(response('fresh row'))
  vi.stubGlobal('fetch', fetchMock)
  container = document.createElement('div')
  document.body.append(container)
})
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined
  container.remove()
})

describe('homepage activity visibility', () => {
  it('preserves initial rows and starts the usual cadence without fetching on mount or ordinary resize', async () => {
    await mount()
    await show(true)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(container.textContent).toContain('server row')
    await advance(14_999)
    expect(fetchMock).not.toHaveBeenCalled()
    await advance(1)
    expect(fetchMock).toHaveBeenCalledOnce()
    await show(true)
    expect(fetchMock).toHaveBeenCalledOnce()
    await advance(15_000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it.each([false, true])('does no work while initially hidden and refreshes once on reveal (empty=%s)', async empty => {
    displayed = false
    await mount(empty ? [] : [event('server row')])
    expect(container.querySelector('ul')).not.toBeNull()
    await advance(45_000)
    expect(fetchMock).not.toHaveBeenCalled()
    await show(true)
    expect(fetchMock).toHaveBeenCalledOnce()
    await show(true)
    expect(fetchMock).toHaveBeenCalledOnce()
    await advance(15_000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await show(false)
    await advance(45_000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain('fresh row')
  })

  it('pauses for document hiding and resumes only when both the panel and document are visible', async () => {
    await mount()
    await documentVisible('hidden')
    await advance(45_000)
    expect(fetchMock).not.toHaveBeenCalled()
    await documentVisible('visible')
    expect(fetchMock).toHaveBeenCalledOnce()
    await show(false)
    await documentVisible('hidden')
    await documentVisible('visible')
    expect(fetchMock).toHaveBeenCalledOnce()
    await show(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('prevents overlapping slow polls, aborts hidden work, and ignores its stale result across rapid reveal', async () => {
    const pending = deferred()
    fetchMock.mockReturnValueOnce(pending.promise)
    await mount()
    await advance(45_000)
    expect(fetchMock).toHaveBeenCalledOnce()
    const signal = fetchMock.mock.calls[0][1].signal as AbortSignal
    await show(false)
    expect(signal.aborted).toBe(true)
    await show(true)
    await show(false)
    await show(true)
    expect(fetchMock).toHaveBeenCalledOnce()
    await act(async () => { pending.resolve(response('stale row')) })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(container.textContent).not.toContain('stale row')
    expect(container.textContent).toContain('fresh row')
    await advance(15_000)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('rejects a result when the panel is already hidden before its observer notification', async () => {
    const pending = deferred()
    fetchMock.mockReturnValueOnce(pending.promise)
    await mount()
    await advance(15_000)
    displayed = false
    await act(async () => { pending.resolve(response('stale row')) })
    expect(container.textContent).not.toContain('stale row')
    await advance(30_000)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('keeps pagination rows when a reveal merges new rows', async () => {
    await mount([event('server row')], true)
    fetchMock.mockResolvedValueOnce(response('older page row'))
    await act(async () => { await mocks.loadMore!() })
    expect(fetchMock).toHaveBeenCalledWith('/api/activity?limit=8&offset=1')
    await show(false)
    await show(true)
    expect(container.textContent).toContain('older page row')
    expect(container.textContent).toContain('server row')
    expect(container.textContent).toContain('fresh row')
  })

  it('recovers from network and HTTP failures at the next normal cadence', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ ok: false })
    await mount()
    await advance(30_000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain('server row')
    await advance(15_000)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(container.textContent).toContain('fresh row')
  })

  it('aborts on unmount, disconnects notifications and never restarts after a stale completion', async () => {
    const pending = deferred()
    fetchMock.mockReturnValueOnce(pending.promise)
    await mount()
    await advance(15_000)
    const signal = fetchMock.mock.calls[0][1].signal as AbortSignal
    await act(async () => { root!.unmount(); root = undefined })
    expect(signal.aborted).toBe(true)
    expect(disconnect).toHaveBeenCalledOnce()
    await documentVisible('hidden')
    await documentVisible('visible')
    await show(false)
    await show(true)
    await act(async () => { pending.resolve(response('stale row')) })
    await advance(45_000)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('detects ancestor class changes without ResizeObserver and cleans up the fallback', async () => {
    vi.stubGlobal('ResizeObserver', undefined)
    displayed = false
    await mount()
    await act(async () => { displayed = true; container.className = 'visible' })
    expect(fetchMock).toHaveBeenCalledOnce()
    await act(async () => { displayed = false; container.className = 'hidden' })
    await advance(30_000)
    expect(fetchMock).toHaveBeenCalledOnce()
    await act(async () => { root!.unmount(); root = undefined; displayed = true; container.className = 'visible' })
    await advance(30_000)
    expect(fetchMock).toHaveBeenCalledOnce()
  })
})
