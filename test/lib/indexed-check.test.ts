// @vitest-environment jsdom

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { pollIndexed } from '@/lib/indexed-check'

let visibility: DocumentVisibilityState = 'visible'
beforeEach(() => {
  vi.useFakeTimers()
  visibility = 'visible'
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it('checks every 5 seconds for 2 minutes, then every 30, skips a hidden document and stops', async () => {
  const check = vi.fn(async () => {})
  const stop = pollIndexed(check)
  expect(check).toHaveBeenCalledTimes(1)

  await vi.advanceTimersByTimeAsync(120_000)
  // The first check, then one every 5 seconds through the 2 minutes.
  expect(check).toHaveBeenCalledTimes(25)

  await vi.advanceTimersByTimeAsync(29_999)
  expect(check).toHaveBeenCalledTimes(25)
  await vi.advanceTimersByTimeAsync(1)
  expect(check).toHaveBeenCalledTimes(26)

  visibility = 'hidden'
  await vi.advanceTimersByTimeAsync(90_000)
  expect(check).toHaveBeenCalledTimes(26)
  visibility = 'visible'
  await vi.advanceTimersByTimeAsync(30_000)
  expect(check).toHaveBeenCalledTimes(27)

  stop()
  await vi.advanceTimersByTimeAsync(300_000)
  expect(check).toHaveBeenCalledTimes(27)
})
