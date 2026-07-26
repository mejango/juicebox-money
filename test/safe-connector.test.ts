import { beforeEach, describe, expect, it, vi } from 'vitest'

const runtime = vi.hoisted(() => ({
  connector: { id: 'injected', name: 'Browser wallet' },
}))

vi.mock('wagmi/actions', () => ({
  getAccount: () => ({ connector: runtime.connector }),
}))

import {
  isSafeConnection,
  SAFE_NONCE_GUIDANCE,
  safeQueueUrl,
  waitForSafeExecutionHash,
} from '@/lib/safe-connector'

const SAFE = '0x1111111111111111111111111111111111111111' as const
const PROPOSAL = `0x${'ab'.repeat(32)}` as const
const EXECUTION = `0x${'cd'.repeat(32)}` as const

describe('Safe connector transaction boundaries', () => {
  beforeEach(() => {
    runtime.connector = { id: 'injected', name: 'Browser wallet' }
  })

  it('identifies Safe connectors and explains the authoritative nonce selector', () => {
    runtime.connector = { id: 'safe', name: 'Safe' }
    expect(isSafeConnection({} as never)).toBe(true)
    expect(SAFE_NONCE_GUIDANCE).toMatch(/next available/i)
    expect(SAFE_NONCE_GUIDANCE).toMatch(/queued nonces/i)
    expect(safeQueueUrl(8453, SAFE)).toContain(`safe=base:${SAFE}`)
  })

  it('resolves a proposal identifier to the mined execution hash before receipt polling', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          isExecuted: true,
          isSuccessful: true,
          transactionHash: EXECUTION,
        }),
      })),
    )

    await expect(waitForSafeExecutionHash(8453, PROPOSAL)).resolves.toBe(EXECUTION)
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining(`/multisig-transactions/${PROPOSAL}/`),
    )
  })
})
