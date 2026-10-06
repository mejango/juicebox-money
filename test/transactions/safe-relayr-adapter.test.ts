import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Address, Hex } from 'viem'
import type { SafeRelayrOptions, SafeRelayrSession } from '@bananapus/nana-sdk-core/review/safe-relayr'
import type { RelayrPendingSession } from '@/lib/relayr'
import { RELAYR_PAYMENT_ADDRESS, RELAYR_PAYMENT_SELECTOR, type RelayrSentPayment } from '@bananapus/nana-sdk-core/review/relayr'

const OWNER = '0x2222222222222222222222222222222222222222' as Address
const SAFE = '0x1111111111111111111111111111111111111111' as Address
const SCOPE = `safe-queue:${SAFE}`
const BUNDLE = '12345678-1234-1234-1234-123456789abc'
const HASH = `0x${'ab'.repeat(32)}` as Hex
const REPLACEMENT = `0x${'cd'.repeat(32)}` as Hex

const mocks = vi.hoisted(() => ({
  saved: null as RelayrPendingSession | null,
  evidence: false,
  options: null as SafeRelayrOptions | null,
  save: vi.fn(),
  pay: vi.fn(),
}))

vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('@wagmi/core', () => ({ getAccount: () => ({ address: OWNER }) }))
vi.mock('@/lib/transaction-review', () => ({ requireTransactionReview: vi.fn() }))
vi.mock('@/lib/relayr', () => ({
  hasRelayrPendingEvidence: () => mocks.evidence,
  loadRelayrPendingSession: () => mocks.saved,
  relayrChainClient: vi.fn(),
  relayrPay: mocks.pay,
  saveRelayrPendingSessionDurably: mocks.save,
  withRelayrScopeLock: async (_scope: string, run: () => Promise<unknown>) => run(),
}))
vi.mock('@bananapus/nana-sdk-core/review/safe-relayr', async importOriginal => ({
  ...(await importOriginal<typeof import('@bananapus/nana-sdk-core/review/safe-relayr')>()),
  createSafeRelayrController: (options: SafeRelayrOptions) => {
    mocks.options = options
    return { prepare: vi.fn(), check: vi.fn(), fund: vi.fn() }
  },
}))

import { createProjectSafeRelayr, safeRelayrSession } from '@/lib/safe-relayr'

function legacy(): RelayrPendingSession {
  return {
    bundleUuid: BUNDLE, paymentHash: HASH, paymentChainId: 1,
    paymentStatus: 'confirmed', chainIds: [1, 10], expectedCount: 2,
    records: [], itemCount: 2, account: OWNER, createdAt: 10,
  }
}

function payment(hash: Hex): RelayrSentPayment {
  return {
    hash, chainId: 1, target: RELAYR_PAYMENT_ADDRESS, amount: '1000', bundleUuid: BUNDLE,
    calldata: `${RELAYR_PAYMENT_SELECTOR}${BUNDLE.replaceAll('-', '')}${'0'.repeat(32)}${'f'.repeat(64)}`,
    deadline: ((1n << 256n) - 1n).toString(),
  }
}

function session(): SafeRelayrSession {
  return {
    id: 'session', account: OWNER, bundleUuid: BUNDLE, executions: [],
    paymentStatus: 'confirmed', payments: [], state: 'active', createdAt: 10,
    quote: { bundle_uuid: BUNDLE, expectedTransactions: [], payment_info: [], transactions: [] },
  }
}

beforeEach(() => {
  mocks.saved = null
  mocks.evidence = false
  mocks.options = null
  mocks.pay.mockReset()
  mocks.save.mockReset().mockImplementation((_scope: string, saved: RelayrPendingSession) => {
    mocks.saved = structuredClone(saved)
    return mocks.saved
  })
})

function adapter() {
  const onSaved = vi.fn()
  createProjectSafeRelayr({ scope: SCOPE, revalidate: vi.fn(), afterVerified: vi.fn(), onSaved })
  return { options: mocks.options!, onSaved }
}

describe('Safe Relayr journal adapter', () => {
  it('refuses an unreadable stored receipt instead of treating it as an empty journal', () => {
    vi.stubGlobal('window', {})
    mocks.evidence = true
    expect(() => safeRelayrSession(SCOPE)).toThrow(/could not be read/)
    expect(mocks.save).not.toHaveBeenCalled()
  })

  it('retains every legacy chain reservation even without exact execution proofs', () => {
    mocks.saved = legacy()
    const restored = safeRelayrSession(SCOPE)!
    expect(restored).toMatchObject({ bundleUuid: BUNDLE, paymentStatus: 'confirmed', executions: [] })
    expect(restored.reservationKeys).toEqual([`1:${SAFE}:*`, `10:${SAFE}:*`])
    expect(mocks.saved.paymentHash).toBe(HASH)
    expect(mocks.save).not.toHaveBeenCalled()
  })

  it('normalizes legacy position-paired IDs through the original per-chain records', () => {
    const firstId = '00000000-0000-0000-0000-000000000001'
    const secondId = '00000000-0000-0000-0000-000000000002'
    const entries = [1, 10].map(chain => ({ chain, target: SAFE, data: '0x1234' as Hex, value: '0' }))
    mocks.saved = {
      ...legacy(), expectedEntries: entries,
      expectedSafeExecutions: entries.map((entry, index) => ({
        chainId: entry.chain, safe: SAFE, nonce: 1, safeTxHash: HASH, txUuid: [firstId, secondId][index],
      })),
      records: [
        { tx_uuid: secondId, request: { ...entries[0], virtual_nonce: 0 } },
        { tx_uuid: firstId, request: { ...entries[1], virtual_nonce: 0 } },
      ],
    }
    const restored = safeRelayrSession(SCOPE)!
    expect(restored.quote?.expectedTransactions).toEqual([
      { chain: 1, entry: entries[0], txUuid: secondId },
      { chain: 10, entry: entries[1], txUuid: firstId },
    ])
    expect(restored.reservationKeys).toEqual([`1:${SAFE}:1`, `10:${SAFE}:1`])
    expect(mocks.saved.expectedSafeExecutions?.[0].txUuid).toBe(firstId)
    expect(mocks.save).not.toHaveBeenCalled()
  })

  it.each([
    { paymentHash: HASH, paymentChainId: null },
    { paymentHash: null, paymentChainId: 1 },
  ])('keeps partial legacy funding evidence unresolved: %j', evidence => {
    mocks.saved = { ...legacy(), paymentStatus: 'unpaid', ...evidence }
    expect(safeRelayrSession(SCOPE)).toMatchObject({ paymentStatus: 'sending', payments: [] })
    expect(mocks.save).not.toHaveBeenCalled()
  })

  it('refuses a malformed shared lifecycle record without overwriting its legacy receipt', () => {
    mocks.saved = { ...legacy(), safeLifecycle: { id: 'broken' } as SafeRelayrSession }
    expect(() => safeRelayrSession(SCOPE)).toThrow(/incomplete/)
    expect(mocks.saved.paymentHash).toBe(HASH)
    expect(mocks.save).not.toHaveBeenCalled()
  })

  it('preserves the legacy payment hash and chain when saving read-only status updates', async () => {
    mocks.saved = legacy()
    const restored = safeRelayrSession(SCOPE)!
    const { options } = adapter()
    const records = [{ chain: 1, tx_uuid: BUNDLE, status: { state: 'pending' } }]
    await options.store.save({ ...restored, records })
    expect(mocks.saved).toMatchObject({ paymentHash: HASH, paymentChainId: 1, paymentStatus: 'confirmed', records, chainIds: [1, 10], expectedCount: 2, itemCount: 2 })
    expect(safeRelayrSession(SCOPE)?.reservationKeys).toEqual([`1:${SAFE}:*`, `10:${SAFE}:*`])
    expect(mocks.pay).not.toHaveBeenCalled()
  })

  it('refuses an empty legacy reservation rather than freeing its saved payment', () => {
    mocks.saved = { ...legacy(), chainIds: [] }
    expect(() => safeRelayrSession(SCOPE)).toThrow(/no chain information/)
    mocks.saved = { ...legacy(), safeLifecycle: session() }
    expect(() => safeRelayrSession(SCOPE)).toThrow(/incomplete/)
    expect(mocks.saved.paymentHash).toBe(HASH)
    expect(mocks.save).not.toHaveBeenCalled()
  })

  it('retains the original and replacement payment hashes when the wallet reports only its latest result', async () => {
    const original = payment(HASH)
    const replacement = payment(REPLACEMENT)
    mocks.pay.mockImplementation(async ({ onSending, onSent }) => {
      await onSending()
      await onSent([original])
      await onSent([replacement])
      return { hash: REPLACEMENT, payments: [replacement] }
    })
    const { options } = adapter()
    const onSent = vi.fn()
    const onSending = vi.fn()
    const result = await options.sendPayment({
      session: session(),
      payment: { chain: 1, target: RELAYR_PAYMENT_ADDRESS, amount: '1000', calldata: original.calldata },
      beforeSend: vi.fn(), onSending, onSent,
    })
    expect(onSending).toHaveBeenCalledOnce()
    expect(onSent).toHaveBeenLastCalledWith([original, replacement])
    expect(result).toEqual({ hash: REPLACEMENT, payments: [original, replacement] })
  })
})
