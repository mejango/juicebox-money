import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPacedRpcFetch } from '@/lib/rpc-request-pacing'

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0) })
afterEach(() => { vi.useRealTimers() })

describe('RPC request start pacing', () => {
  it('starts all four chain requests while earlier responses are unresolved', async () => {
    const releases: ((response: Response) => void)[] = []
    const starts: number[] = []
    const send = vi.fn(() => {
      starts.push(Date.now())
      return new Promise<Response>(resolve => releases.push(resolve))
    })
    const paced = createPacedRpcFetch(send)
    const requests = [1, 10, 8453, 42161].map(chain => paced(`/rpc/${chain}`))
    await vi.advanceTimersByTimeAsync(375)
    expect(starts).toEqual([0, 125, 250, 375])
    releases.reverse().forEach(release => release(new Response('ok')))
    await expect(Promise.all(requests)).resolves.toHaveLength(4)
  })

  it('removes aborted queued requests without sending them or delaying followers', async () => {
    const send = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('ok'))
    const paced = createPacedRpcFetch(send)
    const controller = new AbortController()
    const first = paced('/first')
    const aborted = paced('/aborted', { signal: controller.signal })
    const assertion = expect(aborted).rejects.toThrow('Cancelled')
    const last = paced('/last')
    controller.abort(new Error('Cancelled'))
    await assertion
    await vi.advanceTimersByTimeAsync(125)
    await Promise.all([first, last])
    expect(send.mock.calls.map(args => args[0])).toEqual(['/first', '/last'])
  })

  it('honors a 429 cooldown across requests without holding successful responses', async () => {
    const starts: number[] = []
    const paced = createPacedRpcFetch(vi.fn(async () => {
      starts.push(Date.now())
      return starts.length === 1
        ? new Response('', { status: 429, headers: { 'Retry-After': '2' } })
        : new Response('ok')
    }))
    const first = paced('/one')
    const second = paced('/two')
    expect((await first).status).toBe(429)
    await vi.advanceTimersByTimeAsync(1999)
    expect(starts).toEqual([0])
    await vi.advanceTimersByTimeAsync(1)
    await second
    expect(starts).toEqual([0, 2000])
  })

  it('does not release a catch-up burst after timers are delayed', async () => {
    const starts: number[] = []
    const paced = createPacedRpcFetch(async () => {
      starts.push(Date.now())
      return new Response('ok')
    })
    const requests = [1, 2, 3].map(index => paced(`/rpc/${index}`))
    await Promise.resolve()
    vi.setSystemTime(1000)
    await vi.advanceTimersByTimeAsync(125)
    expect(starts).toEqual([0, 1125])
    await vi.advanceTimersByTimeAsync(125)
    await Promise.all(requests)
    expect(starts).toEqual([0, 1125, 1250])
  })
})
