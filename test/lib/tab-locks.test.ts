import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { requireWebLocks, withTabLocks } from '@/lib/tab-locks'

afterEach(() => { vi.unstubAllGlobals() })

describe('withTabLocks', () => {
  it.each([
    ['Web Locks', () => vi.stubGlobal('navigator', { locks: tabLockManager() })],
    ['no Web Locks', () => vi.stubGlobal('navigator', {})],
  ])('with %s, refuses a held key with the busy line and runs once it is free', async (_name, setup) => {
    setup()
    let release!: () => void
    const first = withTabLocks(['b', 'a'], 'Busy elsewhere.', () => new Promise<string>(resolve => { release = () => resolve('first') }))
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    await expect(withTabLocks(['a'], 'Busy elsewhere.', () => 'second')).rejects.toThrow('Busy elsewhere.')
    release()
    await expect(first).resolves.toBe('first')
    await expect(withTabLocks(['a', 'c'], 'Busy elsewhere.', () => 'third')).resolves.toBe('third')
  })

  it('waits for a held key when it has no busy line', async () => {
    vi.stubGlobal('navigator', {})
    const order: string[] = []
    let release!: () => void
    const first = withTabLocks(['k'], undefined, () => new Promise<void>(resolve => { release = () => { order.push('first'); resolve() } }))
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    const second = withTabLocks(['k'], undefined, () => { order.push('second') })
    release()
    await Promise.all([first, second])
    expect(order).toEqual(['first', 'second'])
  })
})

describe('requireWebLocks', () => {
  it('lets a payment or recovery flow run only with Web Locks', () => {
    vi.stubGlobal('navigator', { locks: tabLockManager() })
    expect(() => requireWebLocks('Use a browser with Web Locks support.')).not.toThrow()
    vi.stubGlobal('navigator', {})
    expect(() => requireWebLocks('Use a browser with Web Locks support.')).toThrow('Use a browser with Web Locks support.')
  })

  it('is needed because the SDK fallback admits a second tab once a suspended tab’s lease lapses', async () => {
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('indexedDB', sharedIndexedDb())
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const tabA = await tabContext('a')
    const tabB = await tabContext('b')
    let releaseA!: () => void
    let aHeld = false
    const runA = tabA.request('payments', { ifAvailable: true }, async lock => {
      expect(lock).not.toBeNull()
      aHeld = true
      await new Promise<void>(resolve => { releaseA = resolve })
    })
    await vi.waitFor(() => expect(aHeld).toBe(true))
    // While A's lease is live, B is refused.
    await expect(tabB.request('payments', { ifAvailable: true }, async lock => lock)).resolves.toBeNull()
    // A is backgrounded: its renewal timer doesn't run past the 15-second lease, and its callback is still pending.
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 16_000)
    await expect(tabB.request('payments', { ifAvailable: true }, async lock => lock)).resolves.not.toBeNull()
    expect(aHeld).toBe(true)
    releaseA()
    await runA
    // The flows that pay or recover refuse in this browser instead of taking that lease.
    expect(() => requireWebLocks('Use a browser with Web Locks support.')).toThrow('Use a browser with Web Locks support.')
  })
})

/** A minimal LockManager over one tab, as a browser with Web Locks has. */
function tabLockManager() {
  const held = new Map<string, Promise<void>>()
  return {
    async request(name: string, options: { ifAvailable?: boolean }, work: (lock: object | null) => Promise<unknown>) {
      if (held.has(name) && options.ifAvailable) return work(null)
      while (held.has(name)) await held.get(name)
      let done!: () => void
      held.set(name, new Promise<void>(resolve => { done = resolve }))
      try { return await work({ name }) } finally { held.delete(name); done() }
    },
  }
}

type Lease = Pick<LockManager, 'request'>

/**
 * One tab's copy of the SDK's browserLocks(): a fresh module instance with its
 * own in-tab queues, sharing the origin's IndexedDB with every other tab.
 */
async function tabContext(tab: string): Promise<Lease> {
  delete (globalThis as Record<symbol, unknown>)[Symbol.for('nana-sdk:write-lock-queues')]
  const url = pathToFileURL(join(process.cwd(), 'node_modules/@bananapus/nana-sdk-core/dist/esm/review/locks.js')).href
  const { browserLocks } = await import(/* @vite-ignore */ `${url}?tab=${tab}`) as { browserLocks: () => Lease }
  return browserLocks()
}

/** An origin's IndexedDB as the SDK's lease uses it: one object store, atomic readwrite transactions. */
function sharedIndexedDb() {
  const stores = new Map<string, Map<IDBValidKey, unknown>>()
  const later = (fn: () => void) => { setTimeout(fn, 0) }
  const db = {
    transaction(name: string) {
      const store = stores.get(name)!
      const transaction: { oncomplete?: () => void; onerror?: () => void; onabort?: () => void; error: null; objectStore: () => unknown } = {
        error: null,
        objectStore: () => ({
          get(key: IDBValidKey) {
            const request: { result?: unknown; onsuccess?: () => void } = {}
            later(() => { request.result = store.get(key); request.onsuccess?.(); later(() => transaction.oncomplete?.()) })
            return request
          },
          put(value: unknown, key: IDBValidKey) { store.set(key, value) },
          delete(key: IDBValidKey) { store.delete(key) },
        }),
      }
      return transaction
    },
  }
  return {
    open() {
      const request: { result: typeof db & { createObjectStore: (name: string) => void }; onupgradeneeded?: () => void; onsuccess?: () => void } = {
        result: { ...db, createObjectStore: (name: string) => { stores.set(name, new Map()) } },
      }
      later(() => {
        if (!stores.size) request.onupgradeneeded?.()
        request.onsuccess?.()
      })
      return request
    },
  }
}
