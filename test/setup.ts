import { afterEach, beforeEach, vi } from 'vitest'
import { resetSafeRelayrForTests, resetWriteHoldsForTests } from '@bananapus/nana-sdk-core/testing'

function blockedNetworkConstructor(transport: string) {
  return class {
    constructor(url?: string | URL) {
      throw new Error(
        `Unexpected ${transport} connection in unit test: ${String(url ?? 'unknown URL')}`,
      )
    }
  }
}

beforeEach(() => {
  // Each test is a fresh page: no hold followers, tab memory, write locks or
  // Safe Relayr watches from an earlier one (the SDK's own resets).
  resetWriteHoldsForTests()
  resetSafeRelayrForTests()
  // Node's own Web Locks outlive a test: a send left unfinished would hold its lock into every later test.
  // Hidden, the SDK takes its tab locks, which the reset above clears for each test.
  if (globalThis.navigator) Object.defineProperty(globalThis.navigator, 'locks', { value: undefined, configurable: true })
  // A DOM environment's storage keeps saved writes: each test starts with none.
  try {
    const storage = globalThis.localStorage
    if (storage && typeof storage.key === 'function') {
      for (let index = storage.length - 1; index >= 0; index--) {
        const key = storage.key(index)
        if (key?.startsWith('nana-sdk:reviewed-write:')) storage.removeItem(key)
      }
    }
  } catch {
    // No storage in this environment.
  }
  // React 19 requires test environments to opt into act() semantics
  // explicitly. Every renderer mutation in the component suites is wrapped
  // in act(), so advertise that contract and fail loudly if a future test is
  // not.
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal(
    'fetch',
    vi.fn(async input => {
      throw new Error(
        `Unexpected network request in unit test: ${String(input)}`,
      )
    }),
  )
  vi.stubGlobal('XMLHttpRequest', blockedNetworkConstructor('XMLHttpRequest'))
  vi.stubGlobal('WebSocket', blockedNetworkConstructor('WebSocket'))
  vi.stubGlobal('EventSource', blockedNetworkConstructor('EventSource'))
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  if (globalThis.navigator && Object.hasOwn(globalThis.navigator, 'locks')) delete (globalThis.navigator as { locks?: unknown }).locks
})
