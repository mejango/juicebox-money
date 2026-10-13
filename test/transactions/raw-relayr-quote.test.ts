import { beforeEach, expect, it, vi } from 'vitest'
import type { Address, Hex } from 'viem'

const account = '0x1111111111111111111111111111111111111111' as Address
const target = '0x2222222222222222222222222222222222222222' as Address
const mocks = vi.hoisted(() => ({ post: vi.fn() }))
vi.mock('@/providers/Providers', () => ({ wagmiConfig: {}, SUPPORTED_CHAINS: [] }))
vi.mock('@/lib/relayr', async original => ({ ...(await original<typeof import('@/lib/relayr')>()), relayrPostBundle: mocks.post }))

import { RawQuoteNotObtainedError, runRawRelayrLifecycle, type RawRelayrState } from '@/lib/raw-relayr-lifecycle'

const entries = [{ chain: 1, target, data: '0x1234' as Hex, value: '0' }]
const start = (signal?: AbortSignal) => {
  const session: RawRelayrState = { account, phase: 'reviewed', records: [] }
  const saved: string[] = []
  const run = runRawRelayrLifecycle({ session, entries, signal, releasable: true, assertAccount: () => {}, reverify: async () => {},
    saveState: next => { saved.push(next.phase) } })
  return { session, saved, run }
}
beforeEach(() => vi.resetAllMocks())

it('asks for the quote with a five-minute wait and the caller’s cancel signal', async () => {
  const cancel = new AbortController()
  mocks.post.mockRejectedValue(new Error('stop'))
  const { run } = start(cancel.signal)
  await expect(run).rejects.toThrow('stop')
  expect(mocks.post).toHaveBeenCalledWith(entries, { timeoutMs: 300_000, signal: cancel.signal })
})

it('releases an unsigned quote request that returned nothing, so nothing is left pending', async () => {
  mocks.post.mockRejectedValue(new Error('The quote did not arrive in time. Nothing was paid.'))
  const { session, saved, run } = start()
  const failure = await run.catch((error: unknown) => error) as Error
  expect(failure).toBeInstanceOf(RawQuoteNotObtainedError)
  expect(failure.message).toContain('Nothing was paid')
  expect(session.phase).toBe('reviewed')
  expect(session.quote).toBeUndefined()
  expect(saved.at(-1)).toBe('reviewed')
})

it('never moves on to payment when the caller cancelled after the quote was saved, and keeps the quote', async () => {
  const cancel = new AbortController()
  mocks.post.mockImplementation(async () => {
    cancel.abort()
    return { bundle_uuid: 'b', payment_info: [], transactions: [], expectedTransactions: [{ chain: 1, entry: { ...entries[0], virtual_nonce: 0 }, txUuid: 'u', }] }
  })
  const onQuoted = vi.fn()
  const session: RawRelayrState = { account, phase: 'reviewed', records: [] }
  const failure = await runRawRelayrLifecycle({ session, entries: [{ ...entries[0], virtual_nonce: 0 }], signal: cancel.signal, releasable: true, onQuoted,
    assertAccount: () => {}, reverify: async () => {}, saveState: () => {} }).catch((error: unknown) => error) as Error
  expect(failure).not.toBeInstanceOf(RawQuoteNotObtainedError)
  expect(failure.message).toContain('Nothing was paid')
  expect(onQuoted).not.toHaveBeenCalled()
  expect(session.quote).toBeDefined()
})
