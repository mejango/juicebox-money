import { createPacedJBCenterLimiter } from '@bananapus/nana-sdk-core/jbcenter'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createRpcLanes } from '@/lib/rpc-lanes'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

it('starts the first lane ahead of a queue, at the same pace', async () => {
  const lanes = createRpcLanes(createPacedJBCenterLimiter())
  const started: [string, number][] = []
  const t0 = Date.now()
  const request = (name: string) => async () => { started.push([name, Date.now() - t0]) }
  const all = Array.from({ length: 40 }, (_, index) => lanes.rest.run(request(`page ${index}`)))
  await vi.advanceTimersByTimeAsync(250)
  all.push(lanes.first.run(request('pay')))
  await vi.advanceTimersByTimeAsync(125 * 50)
  await Promise.all(all)

  // Behind 40 first-come requests this read would start 5 seconds in.
  const pay = started.findIndex(([name]) => name === 'pay')
  expect(pay).toBeLessThanOrEqual(4)
  expect(started[pay][1]).toBeLessThanOrEqual(500)
  expect(started).toHaveLength(41)
  // Nothing outruns the limiter's 125 ms between starts.
  for (let index = 1; index < started.length; index += 1) {
    expect(started[index][1] - started[index - 1][1]).toBeGreaterThanOrEqual(125)
  }
})

it('sends nothing for a request that aborts while held, and keeps the rest moving', async () => {
  const lanes = createRpcLanes(createPacedJBCenterLimiter())
  const send = vi.fn(async () => 'sent')
  const abort = new AbortController()
  const first = lanes.rest.run(send)
  const second = lanes.rest.run(send)
  const aborted = lanes.rest.run(send, { signal: abort.signal })
  const last = lanes.rest.run(send)
  abort.abort(new Error('gone'))
  await expect(aborted).rejects.toThrow('gone')
  await vi.advanceTimersByTimeAsync(1_000)
  await expect(Promise.all([first, second, last])).resolves.toEqual(['sent', 'sent', 'sent'])
  expect(send).toHaveBeenCalledTimes(3)
})

it('hands on when the request waiting in the limiter aborts or its send fails', async () => {
  const lanes = createRpcLanes(createPacedJBCenterLimiter())
  const abort = new AbortController()
  const failing = lanes.rest.run(async () => { throw new Error('rpc') })
  const waitingInLimiter = lanes.rest.run(async () => 'never', { signal: abort.signal })
  const after = lanes.first.run(async () => 'answered')
  abort.abort(new Error('gone'))
  await expect(failing).rejects.toThrow('rpc')
  await expect(waitingInLimiter).rejects.toThrow('gone')
  await vi.advanceTimersByTimeAsync(1_000)
  await expect(after).resolves.toBe('answered')
})
