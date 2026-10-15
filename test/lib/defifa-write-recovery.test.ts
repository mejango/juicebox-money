// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeFunctionData, erc20Abi, TransactionNotFoundError, type Address, type Hex } from 'viem'
import { createBrowserWriteRecovery, createHeldWriteStorage } from '@bananapus/nana-sdk-core/review'
import { clearDefifaWriteRecovery, defifaWriteNamespace, readDefifaWriteRecovery, sendRecoverableDefifaWrite } from '@/lib/defifa-write-recovery'
import { writeHolds } from '@/lib/write-holds'
import type { TxRequest, TxSendOptions } from '@/hooks/useSafeTx'

const ACCOUNT = '0x1111111111111111111111111111111111111111' as Address
const TOKEN = '0x2222222222222222222222222222222222222222' as Address
const TARGET = '0x3333333333333333333333333333333333333333' as Address
const HASH = `0x${'a'.repeat(64)}` as Hex
const scope = { chainId: 8453, projectId: 27, account: ACCOUNT, action: 'pay' as const }
const request: TxRequest = { chainId: 8453, address: TOKEN, abi: erc20Abi, functionName: 'approve', args: [TARGET, 7n] }

beforeEach(() => {
  localStorage.clear()
  const held = new Set<string>()
  vi.stubGlobal('navigator', { locks: { request: async (key: string, _: unknown, run: (lock: object | null) => Promise<unknown>) => {
    if (held.has(key)) return run(null)
    held.add(key)
    try { return await run({ name: key }) } finally { held.delete(key) }
  } } })
})
afterEach(() => localStorage.clear())

describe('Defifa writes held by the SDK hold of their namespace', () => {
  const call = { to: TOKEN, data: encodeFunctionData(request), value: 0n }
  /** The record an earlier visit saved: reserved and given its hash, nothing more. */
  async function saved(safe = false) {
    const journal = createBrowserWriteRecovery({ chainId: 8453, account: ACCOUNT, safe, namespace: 'defifa:pay:27', call }, { storage: createHeldWriteStorage() })
    await journal.withLock(async () => { journal.submitted(HASH, journal.reserve()) })
    return readDefifaWriteRecovery(scope)!
  }

  it('keeps a Safe proposal row saved before the write hold from being sent again without the explicit exit', async () => {
    await saved(true)
    const send = vi.fn(async () => HASH)
    await expect(sendRecoverableDefifaWrite({ scope, request, send, options: { reviewedAccount: ACCOUNT } })).rejects.toThrow()
    expect(send).not.toHaveBeenCalled()
    // The hold of its namespace says what is held, with no exit while the proposal can still run.
    const client = { getChainId: async () => 8453, getTransactionReceipt: async () => null, getTransaction: async ({ hash }: { hash: Hex }) => { throw new TransactionNotFoundError({ hash }) } }
    const state = await writeHolds.open({ chainId: 8453, account: ACCOUNT, safe: true, namespace: defifaWriteNamespace(scope), call }).state(client as never)
    expect(state).toMatchObject({ status: 'pending-known-hash', exit: false })
  })

  it('refuses mismatched reviewed scope before reserving or exposing a wallet', async () => {
    const send = vi.fn(async () => HASH)
    await expect(sendRecoverableDefifaWrite({ scope, request: { ...request, chainId: 1 }, send, options: { reviewedAccount: ACCOUNT } })).rejects.toThrow('reviewed account and network')
    await expect(sendRecoverableDefifaWrite({ scope, request, send, options: { reviewedAccount: TOKEN } })).rejects.toThrow('reviewed account and network')
    expect(send).not.toHaveBeenCalled()
    expect(readDefifaWriteRecovery(scope)).toBeNull()
  })

  it("sends under the hold of the action's namespace, one for approval and mint, another per project", async () => {
    const send = vi.fn(async (_request: TxRequest, options: TxSendOptions) => { await options.beforeWrite?.(); return HASH })
    await sendRecoverableDefifaWrite({ scope, request, send, options: { reviewedAccount: ACCOUNT } })
    await sendRecoverableDefifaWrite({ scope: { ...scope, projectId: 46 }, request, send, options: { reviewedAccount: ACCOUNT } })
    expect(send.mock.calls.map(([, options]) => options.intent)).toEqual(['defifa:pay:27', 'defifa:pay:46'])
  })

  for (const outcome of ['onWriteRejected', 'onBeforeWriteAborted'] as const) {
    it(`passes the typed ${outcome} callback through, and tells the card nothing is held`, async () => {
      const callback = vi.fn()
      const onRecord = vi.fn()
      await sendRecoverableDefifaWrite({ scope, request, onRecord, options: { reviewedAccount: ACCOUNT, [outcome]: callback }, send: async (_request, options) => {
        await options.beforeWrite?.(); await options[outcome]?.(); return null
      } })
      expect(callback).toHaveBeenCalledOnce()
      expect(onRecord).toHaveBeenLastCalledWith(null)
    })
  }

  it('clears only the exact retained record, and nothing once the hold settled it', async () => {
    const original = await saved()
    await clearDefifaWriteRecovery(scope, { ...original, id: 'another-record' })
    expect(readDefifaWriteRecovery(scope)?.id).toBe(original.id)
    await clearDefifaWriteRecovery(scope, original)
    expect(readDefifaWriteRecovery(scope)).toBeNull()
    // Already gone (the hold settled it): nothing is written back.
    await clearDefifaWriteRecovery(scope, original)
    expect(readDefifaWriteRecovery(scope)).toBeNull()
  })
})
