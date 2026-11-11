import { afterEach, describe, expect, it, vi } from 'vitest'
import { LockLostError } from '@bananapus/nana-sdk-core/review/locks'
import { fence, withTabLocks, type TabLocks } from '@/lib/tab-locks'

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

  it.each([
    ['Web Locks', () => vi.stubGlobal('navigator', { locks: tabLockManager() })],
    ['no Web Locks', () => vi.stubGlobal('navigator', {})],
  ])('with %s, hands work every lock it holds, so its writes can check them', async (_name, setup) => {
    setup()
    const names = await withTabLocks(['b', 'a', 'b'], 'Busy elsewhere.', async locks => {
      for (const lock of locks) await lock.assertHeld()
      return locks.map(lock => lock.name)
    })
    expect(names).toEqual(['a', 'b'])
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

describe('fence', () => {
  const lock = (held: boolean) => ({ name: 'k', mode: 'exclusive', signal: new AbortController().signal,
    held: async () => held, assertHeld: async () => { if (!held) throw new LockLostError('k') } }) as TabLocks[number]

  it('writes while every lock is held, and writes nothing once one passed to another tab', async () => {
    const write = vi.fn((value: string) => value.length)
    await expect(fence([lock(true)], write)('abc')).resolves.toBe(3)
    await expect(fence([lock(true), lock(false)], write)('abcd')).rejects.toMatchObject({ code: 'LOCK_LOST' })
    expect(write.mock.calls).toEqual([['abc']])
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
