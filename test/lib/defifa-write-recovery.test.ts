// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { erc20Abi, type Address, type Hex } from 'viem'
import { clearDefifaWriteRecovery, readDefifaWriteRecovery, sendRecoverableDefifaWrite } from '@/lib/defifa-write-recovery'
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

describe('SDK-owned native write recovery', () => {
  it('refuses mismatched reviewed scope before reserving or exposing a wallet', async () => {
    const send = vi.fn(async () => HASH)
    await expect(sendRecoverableDefifaWrite({ scope, request: { ...request, chainId: 1 }, safe: false, send, options: { reviewedAccount: ACCOUNT } })).rejects.toThrow('reviewed account and network')
    await expect(sendRecoverableDefifaWrite({ scope, request, safe: false, send, options: { reviewedAccount: TOKEN } })).rejects.toThrow('reviewed account and network')
    expect(send).not.toHaveBeenCalled()
    expect(readDefifaWriteRecovery(scope)).toBeNull()
  })

  it('reserves before wallet exposure, persists the returned identity and blocks changed retries', async () => {
    const wallet = vi.fn()
    const send = vi.fn(async (_request: TxRequest, options: TxSendOptions) => {
      await options.beforeWrite?.()
      expect(readDefifaWriteRecovery(scope)?.hash).toBeUndefined()
      wallet()
      return HASH
    })
    await sendRecoverableDefifaWrite({ scope, request, safe: false, send, options: { reviewedAccount: ACCOUNT } })
    expect(wallet).toHaveBeenCalledOnce()
    expect(readDefifaWriteRecovery(scope)?.hash).toBe(HASH)
    const retry = vi.fn(async () => HASH)
    await expect(sendRecoverableDefifaWrite({ scope, request: { ...request, args: [TARGET, 9n] }, safe: false, send: retry, options: { reviewedAccount: ACCOUNT } })).rejects.toThrow('earlier NFT action')
    expect(retry).not.toHaveBeenCalled()
  })

  it('retains hashless uncertainty across reads while allowing another project', async () => {
    const unknown = async (_request: TxRequest, options: TxSendOptions) => { await options.beforeWrite?.(); return null }
    await sendRecoverableDefifaWrite({ scope, request, safe: false, send: unknown, options: { reviewedAccount: ACCOUNT } })
    expect(readDefifaWriteRecovery(scope)).toMatchObject({ account: ACCOUNT, chainId: 8453 })
    expect(readDefifaWriteRecovery(scope)?.hash).toBeUndefined()
    const other = { ...scope, projectId: 46 }
    await sendRecoverableDefifaWrite({ scope: other, request, safe: false, send: async (_request, options) => { await options.beforeWrite?.(); return HASH }, options: { reviewedAccount: ACCOUNT } })
    expect(readDefifaWriteRecovery(other)?.hash).toBe(HASH)
    expect(readDefifaWriteRecovery(scope)?.hash).toBeUndefined()
  })

  for (const outcome of ['onWriteRejected', 'onBeforeWriteAborted'] as const) {
    it(`releases only the typed ${outcome} callback before a fresh intent`, async () => {
      const callback = vi.fn()
      await sendRecoverableDefifaWrite({ scope, request, safe: false, options: { reviewedAccount: ACCOUNT, [outcome]: callback }, send: async (_request, options) => {
        await options.beforeWrite?.(); await options[outcome]?.(); return null
      } })
      expect(callback).toHaveBeenCalledOnce()
      expect(readDefifaWriteRecovery(scope)).toBeNull()
    })
  }

  it('cleans its reservation when the final caller context guard aborts before the writer', async () => {
    const wallet = vi.fn()
    await expect(sendRecoverableDefifaWrite({ scope, request, safe: false, options: { reviewedAccount: ACCOUNT, beforeWrite: () => { throw new Error('Project changed') } }, send: async (_request, options) => {
      await options.beforeWrite?.(); wallet(); return HASH
    } })).rejects.toThrow('Project changed')
    expect(wallet).not.toHaveBeenCalled()
    expect(readDefifaWriteRecovery(scope)).toBeNull()
  })

  it("holds the original call in this tab's memory where durable storage is refused", async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage unavailable') })
    const wallet = vi.fn()
    await expect(sendRecoverableDefifaWrite({ scope, request, safe: false, options: { reviewedAccount: ACCOUNT }, send: async (_request, options) => {
      await options.beforeWrite?.(); wallet(); return HASH
    } })).resolves.toBe(HASH)
    expect(wallet).toHaveBeenCalledOnce()
    expect(readDefifaWriteRecovery(scope)?.hash).toBe(HASH)
  })

  it('coordinates simultaneous tabs through the SDK lock and clears only the exact retained record', async () => {
    let release!: () => void
    const pause = new Promise<void>(resolve => { release = resolve })
    const first = sendRecoverableDefifaWrite({ scope, request, safe: false, options: { reviewedAccount: ACCOUNT }, send: async (_request, options) => {
      await options.beforeWrite?.(); await pause; return HASH
    } })
    await new Promise(resolve => setTimeout(resolve, 0))
    const second = vi.fn(async () => HASH)
    await expect(sendRecoverableDefifaWrite({ scope, request, safe: false, options: { reviewedAccount: ACCOUNT }, send: second })).rejects.toThrow('another tab')
    expect(second).not.toHaveBeenCalled()
    release(); await first
    const original = readDefifaWriteRecovery(scope)!
    await expect(clearDefifaWriteRecovery(scope, { ...original, id: 'another-record' })).rejects.toThrow('changed')
    expect(readDefifaWriteRecovery(scope)?.id).toBe(original.id)
    await clearDefifaWriteRecovery(scope, original)
    expect(readDefifaWriteRecovery(scope)).toBeNull()
  })
})
