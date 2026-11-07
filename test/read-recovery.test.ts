// @vitest-environment jsdom

import { QueryClient, QueryObserver } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { recoveringRead } from '@/lib/read-recovery'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

it('recovers by itself once an outage ends, trying less often the longer it lasts', async () => {
  let down = true
  const read = vi.fn(async () => {
    if (down) throw new Error('rpc down')
    return 'answer'
  })
  const observer = new QueryObserver(new QueryClient(), { queryKey: ['read'], queryFn: read, ...recoveringRead })
  const stop = observer.subscribe(() => {})

  // Three tries, one second then two apart, and then the verdict.
  await vi.advanceTimersByTimeAsync(3_000)
  expect(read).toHaveBeenCalledTimes(3)
  expect(observer.getCurrentResult().isError).toBe(true)

  await vi.advanceTimersByTimeAsync(19_999)
  expect(read).toHaveBeenCalledTimes(3)
  await vi.advanceTimersByTimeAsync(1)
  expect(read).toHaveBeenCalledTimes(4)
  await vi.advanceTimersByTimeAsync(3_000)
  expect(read).toHaveBeenCalledTimes(6)

  // The second wait is twice the first.
  await vi.advanceTimersByTimeAsync(39_999)
  expect(read).toHaveBeenCalledTimes(6)

  down = false
  await vi.advanceTimersByTimeAsync(1)
  expect(observer.getCurrentResult().isSuccess).toBe(true)
  const settled = read.mock.calls.length
  await vi.advanceTimersByTimeAsync(600_000)
  expect(read).toHaveBeenCalledTimes(settled)
  stop()
})
