import { afterEach, beforeEach, vi } from 'vitest'

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
  // Writes held in a storage-less tab live in the SDK's tab memory, and in a
  // DOM environment's storage: each test starts with none.
  const tab = globalThis as unknown as Record<symbol, unknown>
  const memory = tab[Symbol.for('nana-sdk:held-writes')] as Map<string, string> | undefined
  ;(tab[Symbol.for('nana-sdk:held-writes-seen')] as WeakMap<object, Map<string, string>> | undefined)?.get(memory ?? {})?.clear()
  memory?.clear()
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
})
