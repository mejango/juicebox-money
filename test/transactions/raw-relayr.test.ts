import { beforeEach, expect, it, vi } from 'vitest'
import type { Address, Hex } from 'viem'
import { RawQuoteNotObtainedError, type RawRelayrState } from '@/lib/raw-relayr-lifecycle'
import type { RelayrEntry } from '@bananapus/nana-sdk-core/review/relayr'

const account = '0x1111111111111111111111111111111111111111' as Address
const target = '0x2222222222222222222222222222222222222222' as Address
const blockHash = `0x${'aa'.repeat(32)}` as Hex
const hash = (i: number) => `0x${String(i).padStart(64, '0')}` as Hex
const mocks = vi.hoisted(() => ({ lifecycle: vi.fn(), reverify: vi.fn(), transaction: vi.fn(), receipt: vi.fn(), block: vi.fn(), address: '' as Address }))
vi.mock('@wagmi/core', () => ({ getAccount: () => ({ address: mocks.address }) }))
vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('@/lib/viewAs', () => ({ assertNoViewAs: vi.fn() }))
vi.mock('@/lib/safe-connector', () => ({ isSafeConnection: () => false }))
vi.mock('@/lib/relayr', () => ({ withRelayrScopeLock: (_key: string, run: () => Promise<void>) => run() }))
vi.mock('@/lib/wallet-core', () => ({ publicClient: () => ({ getTransaction: mocks.transaction, getTransactionReceipt: mocks.receipt, getBlock: mocks.block }) }))
vi.mock('@/lib/raw-relayr-lifecycle', async original => ({ ...(await original<typeof import('@/lib/raw-relayr-lifecycle')>()), runRawRelayrLifecycle: mocks.lifecycle }))
import { isRawRelayrSessionReleased, loadRawRelayrSession, runRawRelayrCalls } from '@/lib/raw-relayr'

let scope = 0
const calls = [{ chainId: 1, target, data: '0x1234' as Hex }, { chainId: 1, target, data: '0x5678' as Hex }]
beforeEach(() => {
  vi.clearAllMocks()
  scope++
  mocks.address = account
  const values = new Map<string, string>()
  vi.stubGlobal('window', { localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) } })
  vi.stubGlobal('navigator', { locks: {} })
  mocks.reverify.mockResolvedValue(undefined)
  mocks.lifecycle.mockImplementation(async ({ session, entries, saveState: persist, reverify }: { session: RawRelayrState; entries: RelayrEntry[]; saveState: (s: RawRelayrState) => void; reverify: () => Promise<void> }) => {
    await reverify()
    session.quote = { bundle_uuid: '00000000-0000-0000-0000-000000000001', payment_info: [], transactions: [], expectedTransactions: entries.map((entry, i) => ({ chain: entry.chain, entry, txUuid: `uuid-${i}` })) }
    session.records = entries.map((entry, i) => ({ tx_uuid: `uuid-${i}`, request: entry, status: { state: 'success', data: { hash: hash(i + 1) } } })).reverse()
    session.phase = 'executing'
    persist(session)
  })
  mocks.transaction.mockImplementation(({ hash: h }: { hash: Hex }) => ({ hash: h, chainId: 1, to: target, input: calls[Number(BigInt(h)) - 1].data, value: 0n, blockHash, blockNumber: 12n }))
  mocks.receipt.mockImplementation(({ hash: h }: { hash: Hex }) => ({ transactionHash: h, status: 'success', blockHash, blockNumber: 12n }))
  mocks.block.mockResolvedValue({ hash: blockHash })
})
const run = (onComplete = vi.fn().mockResolvedValue(undefined)) => runRawRelayrCalls({ calls, account, pendingScope: String(scope), reverify: mocks.reverify, onComplete })

it('binds same-chain destinations by UUID and returns receipts in reviewed order', async () => {
  const complete = vi.fn().mockResolvedValue(undefined)
  await run(complete)
  expect(complete.mock.calls[0][0].map((receipt: { transactionHash: Hex }) => receipt.transactionHash)).toEqual([hash(1), hash(2)])
  expect(loadRawRelayrSession(String(scope))).toBeNull()
})
it('preserves the completed bundle when its owner cannot persist completion', async () => {
  await expect(run(vi.fn().mockRejectedValue(new Error('storage')))).rejects.toThrow('storage')
  expect(loadRawRelayrSession(String(scope))?.phase).toBe('complete')
  await run()
  expect(mocks.lifecycle).toHaveBeenCalledTimes(1)
})
it('keeps a bundle pending when a UUID record is duplicated', async () => {
  const original = mocks.lifecycle.getMockImplementation()!
  mocks.lifecycle.mockImplementation(async (args) => { await original(args); args.session.records.push(args.session.records[0]); args.saveState(args.session) })
  const complete = vi.fn()
  await expect(run(complete)).rejects.toThrow('unresolved')
  expect(complete).not.toHaveBeenCalled()
  expect(loadRawRelayrSession(String(scope))).not.toBeNull()
})
it('refuses noncanonical destination receipts', async () => {
  mocks.block.mockResolvedValue({ hash: hash(99) })
  await expect(run()).rejects.toThrow('canonical')
  expect(loadRawRelayrSession(String(scope))).not.toBeNull()
})
it('returns canonically reverted receipts for owner outcome reconciliation', async () => {
  mocks.receipt.mockImplementation(({ hash: h }: { hash: Hex }) => ({ transactionHash: h, status: 'reverted', blockHash, blockNumber: 12n }))
  const complete = vi.fn().mockResolvedValue(undefined)
  await run(complete)
  expect(complete.mock.calls[0][0].map((receipt: { status: string }) => receipt.status)).toEqual(['reverted', 'reverted'])
})
it('refuses native value and a changed wallet before publishing', async () => {
  await expect(runRawRelayrCalls({ calls: [{ ...calls[0], value: 1n }], account, pendingScope: String(scope), reverify: mocks.reverify, onComplete: vi.fn() })).rejects.toThrow('native value')
  mocks.address = target
  await expect(run()).rejects.toThrow('wallet')
  expect(mocks.lifecycle).not.toHaveBeenCalled()
})

it('fails closed on owner preflight failure before publishing', async () => {
  mocks.reverify.mockRejectedValue(new Error('execution reverted'))
  const complete = vi.fn()
  await expect(run(complete)).rejects.toThrow('execution reverted')
  expect(complete).not.toHaveBeenCalled()
  expect(loadRawRelayrSession(String(scope))).toBeNull()
})


it('keeps an empty retained recovery record ambiguous instead of treating it as absent', async () => {
  window.localStorage.setItem(`jb-raw-relayr-v1:${scope}`, '')
  expect(() => loadRawRelayrSession(String(scope))).toThrow()
  await expect(run()).rejects.toThrow()
  expect(mocks.lifecycle).not.toHaveBeenCalled()
  expect(window.localStorage.getItem(`jb-raw-relayr-v1:${scope}`)).toBe('')
})

it('drops the saved bundle when no quote was obtained, since nothing was reserved or paid', async () => {
  mocks.lifecycle.mockImplementationOnce(async ({ session, saveState: persist }: { session: RawRelayrState; saveState: (s: RawRelayrState, beforeWrite?: boolean) => void }) => {
    session.phase = 'publishing'
    persist(session, true)
    throw new RawQuoteNotObtainedError('Cancelled. Nothing was paid.')
  })
  await expect(run()).rejects.toBeInstanceOf(RawQuoteNotObtainedError)
  expect(loadRawRelayrSession(String(scope))).toBeNull()
})

it('treats a bundle saved before its quote arrived as releasable, never one that has a quote', async () => {
  mocks.lifecycle.mockImplementationOnce(async ({ session, saveState: persist }: { session: RawRelayrState; saveState: (s: RawRelayrState, beforeWrite?: boolean) => void }) => {
    session.phase = 'publishing'
    persist(session, true)
    throw new Error('connection lost')
  })
  await expect(run()).rejects.toThrow('connection lost')
  expect(loadRawRelayrSession(String(scope))?.phase).toBe('publishing')
  expect(await isRawRelayrSessionReleased(String(scope))).toBe(true)
})

it('reports each attempt as it is found and checked', async () => {
  const seen: string[][] = []
  await runRawRelayrCalls({ calls, account, pendingScope: String(scope), reverify: mocks.reverify, onComplete: vi.fn().mockResolvedValue(undefined), onAttempts: states => seen.push([...states]) })
  expect(seen[0]).toEqual(['checking', 'checking'])
  expect(seen.at(-1)).toEqual(['confirmed', 'confirmed'])
})

it('reports a reverted attempt without hiding the others', async () => {
  mocks.receipt.mockImplementation(({ hash: h }: { hash: Hex }) => ({ transactionHash: h, status: h === hash(2) ? 'reverted' : 'success', blockHash, blockNumber: 12n }))
  const seen: string[][] = []
  await runRawRelayrCalls({ calls, account, pendingScope: String(scope), reverify: mocks.reverify, onComplete: vi.fn().mockResolvedValue(undefined), onAttempts: states => seen.push([...states]) })
  expect(seen.at(-1)).toEqual(['confirmed', 'reverted'])
})

it('verifies each available destination while polling and keeps going past an unresolved first attempt', async () => {
  const seen: string[][] = []
  mocks.lifecycle.mockImplementation(async ({ session, entries, saveState: persist }: { session: RawRelayrState; entries: RelayrEntry[]; saveState: (s: RawRelayrState) => void }) => {
    session.quote = { bundle_uuid: '00000000-0000-0000-0000-000000000001', payment_info: [], transactions: [], expectedTransactions: entries.map((entry, i) => ({ chain: entry.chain, entry, txUuid: `uuid-${i}` })) }
    // Only the second destination has a hash yet.
    session.records = [{ tx_uuid: 'uuid-1', request: entries[1], status: { state: 'success', data: { hash: hash(2) } } }]
    session.phase = 'executing'
    persist(session)
    await new Promise(resolve => setTimeout(resolve, 0))
  })
  await expect(runRawRelayrCalls({ calls, account, pendingScope: String(scope), reverify: mocks.reverify, onComplete: vi.fn(), onAttempts: states => seen.push([...states]) })).rejects.toThrow('unresolved')
  expect(seen.at(-1)).toEqual(['waiting', 'confirmed'])
  expect(loadRawRelayrSession(String(scope))).not.toBeNull()
})

it('keeps verifying later destinations after one receipt read fails, and holds the bundle', async () => {
  mocks.receipt.mockImplementation(({ hash: h }: { hash: Hex }) => {
    if (h === hash(1)) throw new Error('RPC unavailable')
    return { transactionHash: h, status: 'success', blockHash, blockNumber: 12n }
  })
  const seen: string[][] = []
  const complete = vi.fn()
  await expect(runRawRelayrCalls({ calls, account, pendingScope: String(scope), reverify: mocks.reverify, onComplete: complete, onAttempts: states => seen.push([...states]) })).rejects.toThrow('RPC unavailable')
  expect(seen.at(-1)).toEqual(['checking', 'confirmed'])
  expect(complete).not.toHaveBeenCalled()
  expect(loadRawRelayrSession(String(scope))).not.toBeNull()
})
