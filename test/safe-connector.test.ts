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
  swapDeadline,
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

  it('gives swaps a 20-minute deadline for EOAs and 30 days for Safe signature collection', () => {
    const nowMs = 1_700_000_000_000
    const nowSec = 1_700_000_000
    // EOA: proposal and execution are one act, so 20 minutes is plenty.
    expect(swapDeadline(false, nowMs)).toBe(BigInt(nowSec + 20 * 60))
    // Safe: co-signer collection routinely outlives 20 minutes — match the
    // 30-day Permit2 windows so the executed swap doesn't revert on deadline.
    expect(swapDeadline(true, nowMs)).toBe(BigInt(nowSec + 30 * 24 * 60 * 60))
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
