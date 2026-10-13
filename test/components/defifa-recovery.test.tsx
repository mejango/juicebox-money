// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { erc20Abi, erc721Abi, type Address, type Hex } from 'viem'
import { DefifaNftTransactionRevertedError } from '@bananapus/nana-sdk-core/v6'
import { DefifaRecovery } from '@/components/project/DefifaRecovery'
import { readDefifaWriteRecovery, sendRecoverableDefifaWrite, type DefifaWriteAction } from '@/lib/defifa-write-recovery'
import type { TxRequest } from '@/hooks/useSafeTx'

const ACCOUNT = '0x1111111111111111111111111111111111111111' as Address
const HOOK = '0x2222222222222222222222222222222222222222' as Address
const RECIPIENT = '0x3333333333333333333333333333333333333333' as Address
const HASH = `0x${'a'.repeat(64)}` as Hex
const EXECUTION = `0x${'b'.repeat(64)}` as Hex
const scope = { chainId: 8453, projectId: 27, account: ACCOUNT, action: 'transfer' as DefifaWriteAction }
const request: TxRequest = { chainId: 8453, address: HOOK, abi: erc721Abi, functionName: 'safeTransferFrom', args: [ACCOUNT, RECIPIENT, 123n] }
const m = vi.hoisted(() => ({ receipt: vi.fn(), restore: vi.fn(), verify: vi.fn(), approval: vi.fn(), safe: vi.fn(), reported: vi.fn() }))
vi.mock('wagmi', () => ({ usePublicClient: () => ({ getTransactionReceipt: m.receipt }) }))
vi.mock('@bananapus/nana-sdk-core/v6', async original => ({ ...await original(), restoreDefifaNftReceiptContext: m.restore, verifyDefifaNftTransaction: m.verify }))
vi.mock('@bananapus/nana-sdk-core/review', async original => ({ ...await original(), verifyReviewedWriteReceipt: m.approval }))
vi.mock('@/lib/safe-connector', () => ({ waitForSafeExecutionHash: m.safe, reportedSafeExecution: m.reported }))

let root: Root | undefined
let host: HTMLDivElement
let queries: QueryClient
const settle = async () => { for (let i = 0; i < 5; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }) }
const render = async (account = ACCOUNT, action: DefifaWriteAction = 'transfer') => {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  queries = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => root!.render(<QueryClientProvider client={queries}><DefifaRecovery chainId={8453} projectId={27} account={account} hook={HOOK} actions={[action]} active={false}><p>Fresh NFT controls</p></DefifaRecovery></QueryClientProvider>))
  await settle()
}
const save = (known = true, safe = false, action: DefifaWriteAction = 'transfer') => sendRecoverableDefifaWrite({
  scope: { ...scope, action }, request: action === 'pay' ? { ...request, abi: erc20Abi, functionName: 'approve', args: [RECIPIENT, 7n] } : request,
  safe, options: { reviewedAccount: ACCOUNT }, send: async (_request, options) => { await options.beforeWrite?.(); return known ? HASH : null },
})
const click = async () => { await act(async () => host.querySelector<HTMLButtonElement>('button')!.click()); await settle() }
beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('navigator', { locks: { request: (_key: string, _options: unknown, run: (lock: object) => Promise<unknown>) => run({}) } })
  m.receipt.mockReset().mockResolvedValue({ transactionHash: HASH, blockNumber: 50n })
  m.restore.mockReset().mockResolvedValue({ hook: HOOK, implementation: HOOK, account: ACCOUNT, transaction: request })
  m.verify.mockReset().mockResolvedValue(undefined)
  m.approval.mockReset().mockResolvedValue('success')
  m.safe.mockReset().mockResolvedValue(EXECUTION)
  m.reported.mockReset().mockResolvedValue(null)
})
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; queries?.clear(); document.body.innerHTML = ''; localStorage.clear() })

describe('original native action recovery', () => {
  it('holds a hashless write across unmount and reload, with one line and the exit', async () => {
    await save(false); await render()
    expect(host.textContent).toContain("Your earlier NFT transfer hasn't confirmed yet. Check your wallet.")
    expect(host.textContent).not.toContain('Fresh NFT controls')
    expect(host.querySelector('input')).toBeNull()
    expect([...host.querySelectorAll('button')].map(button => button.textContent)).toEqual(['I checked my wallet. Send again'])
    await act(async () => root!.unmount()); root = undefined
    await render()
    expect(host.textContent).toContain("Your earlier NFT transfer hasn't confirmed yet.")
    expect(readDefifaWriteRecovery(scope)?.hash).toBeUndefined()
    expect(m.verify).not.toHaveBeenCalled()
    await click()
    expect(readDefifaWriteRecovery(scope)).toBeNull()
    expect(host.textContent).toContain('Fresh NFT controls')
  })

  it('recovers the known original request without a new quote and releases only after native proof', async () => {
    await save(); await render(); await click()
    expect(m.receipt).toHaveBeenCalledWith({ hash: HASH })
    expect(m.restore.mock.calls[0][1]).toMatchObject({ chainId: 8453, projectId: 27n, record: { hash: HASH }, expectedHook: HOOK })
    expect(m.verify).toHaveBeenCalledOnce()
    expect(readDefifaWriteRecovery(scope)).toBeNull()
    expect(host.textContent).toContain('Fresh NFT controls')
    expect(host.querySelector('a')?.href).toContain(HASH)
  })

  it('retains the exact record on proof outages and permits only read-only rechecks', async () => {
    await save(); m.verify.mockRejectedValue(new Error('RPC unavailable')); await render(); await click()
    expect(host.textContent).toContain('RPC unavailable')
    expect(host.textContent).not.toContain('Fresh NFT controls')
    expect(readDefifaWriteRecovery(scope)?.hash).toBe(HASH)
    m.verify.mockResolvedValue(undefined); await click()
    expect(m.verify).toHaveBeenCalledTimes(2)
    expect(readDefifaWriteRecovery(scope)).toBeNull()
  })

  it('releases an authenticated finalized revert and preserves the original failed link', async () => {
    await save(); m.verify.mockRejectedValue(new DefifaNftTransactionRevertedError(HASH, 8453)); await render(); await click()
    expect(readDefifaWriteRecovery(scope)).toBeNull()
    expect(host.textContent).toContain('Original transaction failed onchain')
    expect(host.querySelector('a')?.href).toContain(HASH)
  })

  it('keeps proposal and actual execution identities separate for Safe recovery', async () => {
    await save(true, true); m.receipt.mockResolvedValue({ transactionHash: EXECUTION, blockNumber: 50n }); await render(); await click()
    expect(m.safe.mock.calls[0].slice(0, 2)).toEqual([8453, HASH])
    expect(m.receipt).toHaveBeenCalledWith({ hash: EXECUTION })
    expect(m.restore.mock.calls[0][1].record.hash).toBe(HASH)
    expect(host.querySelector('a')?.href).toContain(EXECUTION)
  })

  it('aborts Safe execution lookup on unmount while retaining the original saved proposal', async () => {
    let signal!: AbortSignal
    m.safe.mockImplementation((_chain: number, _hash: Hex, options: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      signal = options.signal
      signal.addEventListener('abort', () => reject(new Error('Lookup aborted')), { once: true })
    }))
    await save(true, true); await render(); await click()
    expect(signal.aborted).toBe(false)
    await act(async () => root!.unmount()); root = undefined
    await settle()
    expect(signal.aborted).toBe(true)
    expect(readDefifaWriteRecovery(scope)?.hash).toBe(HASH)
    expect(m.receipt).not.toHaveBeenCalled()
    expect(m.verify).not.toHaveBeenCalled()
  })

  it('does not display an old account’s proof as the newly connected account’s success', async () => {
    let finish!: () => void
    m.verify.mockImplementation(() => new Promise<void>(resolve => { finish = resolve }))
    await save(); await render(); await click()
    expect(readDefifaWriteRecovery(scope)).not.toBeNull()
    await act(async () => root!.render(<QueryClientProvider client={queries}><DefifaRecovery chainId={8453} projectId={27} account={RECIPIENT} hook={HOOK} actions={['transfer']} active={false}><p>Fresh NFT controls</p></DefifaRecovery></QueryClientProvider>))
    await settle()
    await act(async () => finish()); await settle()
    expect(readDefifaWriteRecovery(scope)).toBeNull()
    expect(host.textContent).toContain('Fresh NFT controls')
    expect(host.textContent).not.toContain('Original transaction verified')
  })

  it('surfaces corrupt saved evidence rather than guessing an empty journal', async () => {
    await save()
    vi.spyOn(Storage.prototype, 'getItem').mockReturnValue('{broken')
    await render()
    expect(host.querySelector('[role="alert"]')).not.toBeNull()
    expect(host.textContent).toContain('Retry saved action')
    expect(host.textContent).not.toContain('Fresh NFT controls')
  })

  it('verifies a saved failed approval separately without claiming the NFT operation succeeded', async () => {
    await save(true, false, 'pay'); m.approval.mockResolvedValue('failed'); await render(ACCOUNT, 'pay'); await click()
    expect(m.approval).toHaveBeenCalledOnce()
    expect(m.restore).not.toHaveBeenCalled()
    expect(m.verify).not.toHaveBeenCalled()
    expect(readDefifaWriteRecovery({ ...scope, action: 'pay' })).toBeNull()
    expect(host.textContent).toContain('Original transaction failed onchain')
  })
})
