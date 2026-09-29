import { describe, expect, it, vi } from 'vitest'

const runtime = vi.hoisted(() => ({
  connector: { id: 'injected', name: 'Browser wallet' },
}))

vi.mock('wagmi/actions', () => ({
  getAccount: () => ({ connector: runtime.connector }),
}))

import { isSafeConnection } from '@/lib/safe-connector'

// The Safe service helpers are tested in @bananapus/nana-sdk-core/safe.
describe('Safe connector detection', () => {
  it('identifies Safe connectors by id or name', () => {
    expect(isSafeConnection({} as never)).toBe(false)
    runtime.connector = { id: 'safe', name: 'Safe' }
    expect(isSafeConnection({} as never)).toBe(true)
  })
})
