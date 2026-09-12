import { zeroAddress, type Address, type Hex } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))

import {
  readSafeTransaction,
  safeTxHashOf,
  type SafeQueuedTx,
} from '@/lib/safe'

const SAFE = '0x1111111111111111111111111111111111111111' as Address
const OTHER_SAFE = '0x2222222222222222222222222222222222222222' as Address
const TARGET = '0x3333333333333333333333333333333333333333' as Address
const OTHER_HASH = `0x${'ab'.repeat(32)}` as Hex

function proposal(overrides: Partial<SafeQueuedTx> = {}): SafeQueuedTx {
  return {
    to: TARGET,
    value: '17',
    data: '0x1234',
    operation: 0,
    safeTxGas: '100',
    baseGas: '20',
    gasPrice: '3',
    gasToken: zeroAddress,
    refundReceiver: zeroAddress,
    nonce: 9,
    ...overrides,
  }
}

function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const fetchMock = vi.fn<typeof fetch>()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

describe('saved Safe proposal lookup', () => {
  it.each([false, true])(
    'recovers a hash-authenticated old proposal with isExecuted=%s without a pending filter',
    async isExecuted => {
      const tx = proposal({ nonce: 0, isExecuted })
      const hash = safeTxHashOf(1, SAFE, tx)
      const body = { ...tx, safe: SAFE, safeTxHash: hash }
      fetchMock.mockResolvedValue(respond(body))

      await expect(readSafeTransaction(1, SAFE, hash)).resolves.toEqual(body)

      expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
        `https://api.safe.global/tx-service/eth/api/v1/multisig-transactions/${hash}/`,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      )
    },
  )

  it('falls back to the legacy service and preserves configured request authentication', async () => {
    const tx = proposal()
    const hash = safeTxHashOf(1, SAFE, tx)
    const body = { ...tx, safe: SAFE, safeTxHash: hash }
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => key === 'jb-safe-api-key' ? 'test-key' : null,
      },
    })
    fetchMock
      .mockResolvedValueOnce(respond({}, 503))
      .mockResolvedValueOnce(respond(body))

    await expect(readSafeTransaction(1, SAFE, hash)).resolves.toEqual(body)

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `https://safe-transaction-mainnet.safe.global/api/v1/multisig-transactions/${hash}/`,
      expect.objectContaining({ headers: { Authorization: 'Bearer test-key' } }),
    )
  })

  it.each([
    ['a different Safe', { safe: OTHER_SAFE }],
    ['a missing Safe', { safe: undefined }],
    ['a different advertised hash', { safeTxHash: OTHER_HASH }],
    ['a missing advertised hash', { safeTxHash: undefined }],
    ['a conflicting contract hash', { contractTransactionHash: OTHER_HASH }],
    ['a changed nonce', { nonce: 10 }],
    ['an invalid nonce', { nonce: -1 }],
    ['a changed target', { to: OTHER_SAFE }],
    ['changed calldata', { data: '0x5678' }],
    ['a changed value', { value: '18' }],
    ['a changed operation', { operation: 1 }],
    ['changed transaction gas', { safeTxGas: '101' }],
    ['changed base gas', { baseGas: '21' }],
    ['a changed gas price', { gasPrice: '4' }],
    ['a changed gas token', { gasToken: TARGET }],
    ['a changed refund receiver', { refundReceiver: TARGET }],
  ])('rejects %s even when the service reports success', async (_, overrides) => {
    const tx = proposal()
    const hash = safeTxHashOf(1, SAFE, tx)
    fetchMock.mockImplementation(async () =>
      respond({ ...tx, safe: SAFE, safeTxHash: hash, ...overrides }),
    )

    await expect(readSafeTransaction(1, SAFE, hash)).rejects.toThrow()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('rejects a self-consistent replacement whose hash differs from the saved proposal', async () => {
    const original = proposal()
    const replacement = proposal({ data: '0x5678' })
    const savedHash = safeTxHashOf(1, SAFE, original)
    fetchMock.mockImplementation(async () => respond({
      ...replacement,
      safe: SAFE,
      safeTxHash: safeTxHashOf(1, SAFE, replacement),
    }))

    await expect(readSafeTransaction(1, SAFE, savedHash)).rejects.toThrow(
      /different Safe transaction hash/,
    )
  })

  it.each([404, 503])('keeps service %s errors unresolved', async status => {
    const hash = safeTxHashOf(1, SAFE, proposal())
    fetchMock.mockImplementation(async () => respond({}, status))

    await expect(readSafeTransaction(1, SAFE, hash)).rejects.toThrow(
      `Safe service ${status}`,
    )
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('rejects chains without a service without issuing a request', async () => {
    const hash = safeTxHashOf(11155420, SAFE, proposal())

    await expect(readSafeTransaction(11155420, SAFE, hash)).rejects.toThrow(
      /No hosted Safe service/,
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each(['fetch', 'body'])('bounds a stalled %s and aborts the request', async phase => {
    vi.useFakeTimers()
    const hash = safeTxHashOf(84532, SAFE, proposal())
    let signal: AbortSignal | undefined
    fetchMock.mockImplementation(async (_url, init) => {
      signal = init?.signal ?? undefined
      if (phase === 'body') {
        return { ok: true, json: () => new Promise(() => {}) } as Response
      }
      return new Promise((_, reject) => {
        signal?.addEventListener('abort', () => reject(signal?.reason), { once: true })
      })
    })
    const result = expect(readSafeTransaction(84532, SAFE, hash)).rejects.toThrow(
      /timed out/,
    )

    await vi.advanceTimersByTimeAsync(10_000)
    await result

    expect(signal?.aborted).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
