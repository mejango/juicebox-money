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
