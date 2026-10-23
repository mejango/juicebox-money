// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement, type ComponentProps, type ReactNode } from 'react'
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { zeroAddress } from 'viem'

const m = vi.hoisted(() => ({ realEngine: false, account: '0x1111111111111111111111111111111111111111', holdings: vi.fn(), cash: vi.fn(), transfer: vi.fn(), verify: vi.fn(), clear: vi.fn(), read: vi.fn(), saved: null as unknown, send: vi.fn(), phase: 'idle', receipt: null as unknown, hash: null as unknown }))
vi.mock('@/lib/defifa-write-recovery', async original => {
  const actual = await original<typeof import('@/lib/defifa-write-recovery')>()
  return ({
  clearDefifaWriteRecovery: m.clear,
  readDefifaWriteRecovery: (scope: Parameters<typeof actual.readDefifaWriteRecovery>[0]) => m.realEngine ? actual.readDefifaWriteRecovery(scope) : m.read(scope),
  DEFIFA_RECOVERY_QUERY_PREFIX: ['defifa-write-recovery'],
  runRecoverableDefifaWrite: async ({ run, action, onRecord, scope }: Parameters<typeof import('@/lib/defifa-write-recovery').runRecoverableDefifaWrite>[0]) => {
    if (m.realEngine) return actual.runRecoverableDefifaWrite({ run, action, onRecord, scope })
    const [call] = action.calls
    const record = { version: 1 as const, id: 'owned-test', chainId: scope.chainId, account: scope.account, safe: false, call: { to: call.to, data: call.data, value: '0' } }
    return run({ ...action,
      beforeWallet: async (reviewed, step) => {
        m.saved = record; onRecord?.(record)
        try { await action.beforeWallet?.(reviewed, step) } catch (error) { m.saved = null; onRecord?.(null); await action.onUnsent?.(reviewed, step); throw error }
      },
      onUnsent: async (reviewed, step) => { m.saved = null; onRecord?.(null); await action.onUnsent?.(reviewed, step) },
    })
  },
}) })
vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('@wagmi/core', async original => {
  const { wallet, walletActions } = await import('../support/fake-wallet')
  return { ...(await original<typeof import('@wagmi/core')>()), ...walletActions, getAccount: () => ({ address: m.realEngine ? wallet.account : m.account, chainId: 1 }) }
})
vi.mock('wagmi', async () => {
  const { walletHooks } = await import('../support/fake-wallet')
  return { ...walletHooks, useConfig: () => ({}), usePublicClient: () => m.realEngine ? walletHooks.usePublicClient() : {} }
})
vi.mock('wagmi/actions', async () => {
  const { wallet } = await import('../support/fake-wallet')
  return { getAccount: () => ({ address: m.realEngine ? wallet.account : m.account, chainId: 1 }) }
})
vi.mock('@/hooks/useWallet', async () => {
  const { useFakeWallet } = await import('../support/fake-wallet')
  return { useWallet: () => { const connected = useFakeWallet(); return m.realEngine ? connected : ({ address: m.account, openSignIn: vi.fn() }) } }
})
vi.mock('@/hooks/useReviewedAction', async original => {
  const actual = await original<typeof import('@/hooks/useReviewedAction')>()
  return { ...actual, useReviewedAction: (chainId: number) => m.realEngine ? actual.useReviewedAction(chainId) : ({ phase: m.phase, hash: m.hash, receipt: m.receipt, run: m.send, busy: m.phase === 'pending', notice: null, error: null, reset: vi.fn(), dismiss: vi.fn(), isSafe: false }) }
})
vi.mock('@/lib/transaction-review', async original => {
  const { wallet } = await import('../support/fake-wallet')
  return { ...(await original<typeof import('@/lib/transaction-review')>()), requestContractTransactionReview: wallet.requestReview }
})
vi.mock('@/lib/safe-connector', async original => ({ ...(await original<typeof import('@/lib/safe-connector')>()), isSafeConnection: () => false, useSafeConnection: () => false }))
vi.mock('@bananapus/nana-sdk-core/v6', async original => ({ ...(await original<typeof import('@bananapus/nana-sdk-core/v6')>()), getDefifaHoldings: m.holdings, prepareDefifaCashOut: m.cash, prepareDefifaTransfer: m.transfer, verifyDefifaNftTransaction: m.verify }))
vi.mock('@/components/project/DefifaRecovery', () => ({ DefifaRecovery: ({ children, active }: { children: ReactNode; active: boolean }) => !active && m.saved ? createElement('p', null, 'Original NFT action retained') : children }))
vi.mock('@/components/ui/TxProgress', async original => {
  const actual = await original<typeof import('@/components/ui/TxProgress')>()
  return { ...actual, TxProgress: ({ title, start, startKey, next, status, error, children, rows, complete, onClose, busy }: ComponentProps<typeof actual.TxProgress>) => {
    actual.useStartOnce(true, !!complete, start, startKey)
    return createElement('section', null, title, status, error, children, ...(rows ?? []).map(row => createElement('p', { key: String(row.label) }, row.label, row.value)), createElement('button', { onClick: onClose, disabled: busy }, 'Close'), complete ? createElement('button', { onClick: onClose }, 'Done') : next ? createElement('button', { onClick: next.onClick, disabled: busy || next.disabled }, next.label) : null)
  } }
})
import { wallet } from '../support/fake-wallet'
import { readDefifaWriteRecovery } from '@/lib/defifa-write-recovery'
import type { Address } from 'viem'
import { DefifaOwnedNfts } from '@/components/project/DefifaOwnedNfts'
import type { Shop } from '@/hooks/useShop721'
import { erc721Abi } from 'viem'
import { DefifaNftTransactionRevertedError } from '@bananapus/nana-sdk-core/v6'
import { jbMultiTerminalAbi } from '@bananapus/nana-sdk-core'
const HOOK = '0x3333333333333333333333333333333333333333'
const OTHER = '0x2222222222222222222222222222222222222222'
const inventory = { hook: HOOK, implementation: HOOK, phase: 4, pricing: { decimals: 18 } }
const shop: Shop = {
  hook: HOOK, protocol: 'defifa', cashOutEnabled: false, transfersPaused: null, transferPauseByStage: null, configFlags: null,
  pricing: { currency: 1, decimals: 18, symbol: 'ETH' },
  tiers: [{ id: 1, name: 'Home team', price: 1n, remaining: 100, initial: 100, category: 0, discountPercent: 0, reserveFrequency: 0, votingUnits: 1n, splitPercent: 0, encodedIpfsUri: `0x${'0'.repeat(64)}`, resolvedUri: '' }],
}
const cash = () => ({ inventory, transaction: { chainId: 1, address: HOOK, abi: jbMultiTerminalAbi, functionName: 'cashOutTokensOf', args: [m.account, 1n, 0n, zeroAddress, 0n, m.account, '0x'] }, reclaimAmount: 0n, protocolRewards: { defifaToken: HOOK, defifaAmount: 1n, defifaDecimals: 18, baseProtocolDecimals: 18, baseProtocolToken: OTHER, baseProtocolAmount: 0n } })
let renderer: TestRenderer.ReactTestRenderer
let queries: QueryClient
function text(node: ReactTestInstance): string { return node.children.map(child => typeof child === 'string' ? child : text(child)).join('') }
async function click(label: string) { const button = renderer.root.findAllByType('button').find(node => text(node) === label)!; expect(button).toBeDefined(); expect(button.props.disabled).not.toBe(true); await act(async () => button.props.onClick()); await settle() }
/** The panel's way to send again: a retry or a fresh review, never offered while an action is held. */
const offered = () => renderer.root.findAllByType('button').find(node => ['Try again', 'Review again'].includes(text(node)) && !node.props.disabled)
const reviewOpen = () => renderer.root.findAllByType('button').some(node => text(node) === 'Close')
async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) }) }
async function manual(value = '1000000001') { await act(async () => renderer.root.findAllByType('input').find(node => node.props.placeholder === 'Token IDs separated by commas')!.props.onChange({ target: { value } })) }
function element(projectId = 1, collection = shop) { return createElement(QueryClientProvider, { client: queries }, createElement(DefifaOwnedNfts, { chainId: 1, projectId, shop: collection })) }
beforeEach(async () => {
  m.realEngine = false
  localStorage.clear()
  m.account = '0x1111111111111111111111111111111111111111'; m.phase = 'idle'; m.receipt = null; m.hash = null
  m.holdings.mockReset().mockResolvedValue({ hook: HOOK, blockNumber: 99n, tokens: [], totalOwned: 1n, totalCandidates: 200n, nextCursor: '100', complete: false })
  m.cash.mockReset().mockImplementation(async () => cash()); m.transfer.mockReset().mockImplementation(async (_client, args) => ({ inventory, transaction: { chainId: 1, address: HOOK, abi: erc721Abi, functionName: 'safeTransferFrom', args: [args.account, args.recipient, args.tokenId] } }))
  m.saved = null; m.read.mockReset().mockImplementation(() => m.saved); m.verify.mockReset().mockResolvedValue(undefined); m.clear.mockReset().mockImplementation(async () => { m.saved = null }); m.send.mockReset().mockImplementation(async action => { if (m.account !== action.account) throw new Error('Account changed'); await action.reverify(action.calls[0], 0); await action.beforeWallet?.(action.calls[0], 0); return null })
  queries = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => { renderer = TestRenderer.create(element()) }); await settle()
})
afterEach(async () => { await act(async () => renderer.unmount()); queries.clear(); localStorage.clear() })
describe('native owned NFT actions', () => {
  it.each(['cash-out', 'transfer'] as const)('real reviewed engine prevents %s wallet exposure after unmount during simulation', async action => {
    await act(async () => renderer.unmount())
    m.realEngine = true
    wallet.reset(); wallet.connect(m.account as Address)
    vi.stubGlobal('navigator', { locks: { request: async (_key: string, _options: unknown, run: (lock: object) => Promise<unknown>) => run({}) } })
    const reservations = vi.spyOn(Storage.prototype, 'setItem')
    let release!: () => void
    // Every simulation, at review and before the send, waits until released.
    const simulated = new Promise(resolve => { release = () => resolve('0x') })
    wallet.client.request.mockImplementation(async ({ method }) => method === 'eth_call' ? simulated : Promise.reject(new Error(`unexpected ${method}`)))
    await act(async () => { renderer = TestRenderer.create(element()) }); await settle()
    await manual()
    if (action === 'transfer') await act(async () => renderer.root.findAllByType('input').find(node => node.props.placeholder === '0x…')!.props.onChange({ target: { value: OTHER } }))
    await click(action === 'transfer' ? 'Transfer Defifa NFT' : 'Cash out Defifa NFTs')
    expect(wallet.client.request).toHaveBeenCalledWith(expect.objectContaining({ method: 'eth_call' }))
    expect(wallet.writeContract).not.toHaveBeenCalled()
    await act(async () => renderer.unmount())
    await act(async () => release()); await settle()
    expect(wallet.writeContract).not.toHaveBeenCalled()
    expect(reservations).toHaveBeenCalled()
    expect(readDefifaWriteRecovery({ chainId: 1, projectId: 1, account: m.account as Address, action })).toBeNull()
  })

  it.each(['cash-out', 'transfer'] as const)('final synchronous gate prevents %s exposure after beforeWrite yields', async action => {
    await act(async () => renderer.unmount())
    m.realEngine = true
    wallet.reset(); wallet.connect(m.account as Address)
    wallet.client.simulateContract.mockImplementation(async request => ({ request }))
    vi.stubGlobal('navigator', { locks: { request: async (_key: string, _options: unknown, run: (lock: object) => Promise<unknown>) => run({}) } })
    await act(async () => { renderer = TestRenderer.create(element()) }); await settle()
    await manual()
    if (action === 'transfer') await act(async () => renderer.root.findAllByType('input').find(node => node.props.placeholder === '0x…')!.props.onChange({ target: { value: OTHER } }))
    const originalSet = Storage.prototype.setItem
    let unmounted = false
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      originalSet.call(this, key, value)
      if (!unmounted) {
        unmounted = true
        queueMicrotask(() => { act(() => renderer.unmount()) })
      }
    })
    await click(action === 'transfer' ? 'Transfer Defifa NFT' : 'Cash out Defifa NFTs')
    expect(unmounted).toBe(true)
    expect(wallet.writeContract).not.toHaveBeenCalled()
    expect(readDefifaWriteRecovery({ chainId: 1, projectId: 1, account: m.account as Address, action })).toBeNull()
  })
  it("says in its review when this browser can't remember pending transactions", async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('SecurityError') })
    await manual(); await click('Cash out Defifa NFTs')
    expect(JSON.stringify(renderer.toJSON())).toContain("This browser can't remember pending transactions. Check your wallet before repeating one.")
  })
  it('wallet-action:cash-out-defifa-nfts preserves zero currency with positive protocol rewards', async () => {
    await manual(); await click('Cash out Defifa NFTs')
    expect(m.cash).toHaveBeenCalledTimes(2); expect(m.send).toHaveBeenCalledTimes(1)
    expect(m.cash.mock.calls[1][1]).toMatchObject({ tokenIds: [1000000001n], minimumReclaim: 0n })
  })
  it('wallet-action:transfer-defifa-nft prepares and freshly checks exactly one NFT and recipient', async () => {
    await manual(); await act(async () => renderer.root.findAllByType('input').find(node => node.props.placeholder === '0x…')!.props.onChange({ target: { value: OTHER } }))
    await click('Transfer Defifa NFT')
    expect(m.transfer).toHaveBeenCalledTimes(2); expect(m.transfer.mock.calls[1][1]).toMatchObject({ recipient: OTHER, tokenId: 1000000001n })
  })
  it.each([0, 3])('does not offer cash-out in phase %s but retains transfers', async phase => {
    await act(async () => renderer.update(element(1, { ...shop, phase })))
    expect(renderer.root.findAllByType('button').find(node => text(node) === 'Cash out Defifa NFTs')).toBeUndefined()
    expect(renderer.root.findAllByType('button').find(node => text(node) === 'Transfer Defifa NFT')).toBeDefined()
  })
  it('bounds manual selections to the shared adapter action budget', async () => {
    await manual(Array.from({ length: 129 }, (_, index) => String(index + 1)).join(',')); await click('Cash out Defifa NFTs')
    expect(text(renderer.root)).toContain('at most 128 NFTs'); expect(m.cash).not.toHaveBeenCalled(); expect(m.send).not.toHaveBeenCalled()
  })
  it('hides owned actions and manual selection only after an authoritative complete empty scan', async () => {
    m.holdings.mockResolvedValueOnce({ hook: HOOK, blockNumber: 100n, tokens: [], totalOwned: 0n, totalCandidates: 0n, nextCursor: null, complete: true })
    await click('Refresh ownership')
    expect(text(renderer.root)).toContain('You do not own any NFTs from this collection')
    expect(renderer.root.findAllByType('input')).toHaveLength(0)
    expect(renderer.root.findAllByType('button').find(node => text(node) === 'Cash out Defifa NFTs')).toBeUndefined()
    expect(renderer.root.findAllByType('button').find(node => text(node) === 'Transfer Defifa NFT')).toBeUndefined()
    expect(renderer.root.findAllByType('button').find(node => text(node) === 'Refresh ownership')).toBeDefined()
  })
  it('retains manual selection and actions for incomplete ownership evidence', async () => {
    m.holdings.mockResolvedValueOnce({ hook: HOOK, blockNumber: 100n, tokens: [], totalOwned: 0n, totalCandidates: 200n, nextCursor: '100', complete: false })
    await click('Refresh ownership')
    expect(text(renderer.root)).toContain('Partial ownership scan')
    expect(renderer.root.findAllByType('input').find(node => node.props.placeholder === 'Token IDs separated by commas')).toBeDefined()
    expect(renderer.root.findAllByType('button').find(node => text(node) === 'Cash out Defifa NFTs')).toBeDefined()
    expect(renderer.root.findAllByType('button').find(node => text(node) === 'Transfer Defifa NFT')).toBeDefined()
  })
  it('preserves the snapshot for deliberate continuation and displays incomplete coverage', async () => {
    expect(text(renderer.root)).toContain('Partial ownership scan')
    expect(text(renderer.root)).not.toContain('at block')
    await click('Load next ownership page')
    expect(m.holdings.mock.calls.at(-1)![1]).toMatchObject({ cursor: '100', blockNumber: 99n, limit: 100 })
  })
  it('shows ownership failures with retry and permits verified manual selection', async () => {
    m.holdings.mockRejectedValueOnce(new Error('Ownership RPC unavailable'))
    await click('Refresh ownership'); expect(text(renderer.root)).toContain('Ownership RPC unavailable')
    await click('Retry'); expect(text(renderer.root)).toContain('Partial ownership scan')
    await manual(); await click('Cash out Defifa NFTs'); expect(m.cash).toHaveBeenCalledTimes(2)
  })
  it('reports SDK transfer-pause failure without wallet submission', async () => {
    await manual(); await act(async () => renderer.root.findAllByType('input').find(node => node.props.placeholder === '0x…')!.props.onChange({ target: { value: OTHER } }))
    m.transfer.mockRejectedValueOnce(new Error('Transfers are paused'))
    await click('Transfer Defifa NFT'); expect(text(renderer.root)).toContain('Transfers are paused'); expect(m.send).not.toHaveBeenCalled()
  })
  it('holds pending execution instead of offering another send', async () => {
    await manual(); await click('Cash out Defifa NFTs')
    m.phase = 'pending'; m.hash = `0x${'a'.repeat(64)}`
    await act(async () => renderer.update(element()))
    expect(offered()).toBeUndefined()
    expect(text(renderer.root)).toContain('Awaiting confirmation'); expect(m.send).toHaveBeenCalledTimes(1)
  })
  it('blocks empty-value cashouts and invalid transfer recipients before sending', async () => {
    m.cash.mockImplementation(async () => ({ ...cash(), protocolRewards: { ...cash().protocolRewards, defifaAmount: 0n } }))
    await manual(); await click('Cash out Defifa NFTs'); expect(text(renderer.root)).toContain('nothing to claim')
    await click('Transfer Defifa NFT'); expect(text(renderer.root)).toContain('nonzero recipient'); expect(m.send).not.toHaveBeenCalled()
  })
  it('rejects changed reward evidence after review', async () => {
    // The review's fresh check reads different rewards than the prepared ones.
    m.cash.mockImplementationOnce(async () => cash()).mockImplementation(async () => ({ ...cash(), protocolRewards: { ...cash().protocolRewards, defifaAmount: 2n } }))
    await manual(); await click('Cash out Defifa NFTs')
    expect(text(renderer.root)).toContain('NFT action changed')
  })
  /** The review stays open in the wallet layer until the payer answers it. */
  function holdReview() {
    let answer!: () => void
    const answered = new Promise<void>(resolve => { answer = resolve })
    const send = m.send.getMockImplementation()!
    m.send.mockImplementationOnce(async action => { await answered; return send(action) })
    return async () => { await act(async () => answer()); await settle() }
  }
  it('sends nothing when the account changes while its review is open', async () => {
    const confirmReview = holdReview()
    await manual(); await click('Cash out Defifa NFTs'); m.account = OTHER
    await act(async () => renderer.update(element()))
    await confirmReview()
    expect(text(renderer.root)).toContain('Account changed')
    expect(m.saved).toBeNull()
  })
  it.each(['project', 'hook'])('sends nothing when the %s changes while its review is open', async changed => {
    const confirmReview = holdReview()
    await manual(); await click('Cash out Defifa NFTs')
    await act(async () => renderer.update(element(changed === 'project' ? 2 : 1, changed === 'hook' ? { ...shop, hook: OTHER } : shop)))
    await confirmReview()
    expect(text(renderer.root)).toMatch(/changed/)
    expect(m.saved).toBeNull()
  })
  it('retains execution context across an account change after submission begins', async () => {
    let resolve!: (value: null) => void
    m.send.mockImplementationOnce(async action => { await action.beforeWallet(action.calls[0], 0); return new Promise(done => { resolve = done }) })
    await manual(); await click('Cash out Defifa NFTs')
    m.account = OTHER
    await act(async () => renderer.update(element()))
    await act(async () => resolve(null)); await settle()
    expect(text(renderer.root)).toContain('submission outcome is unknown')
    expect(offered()).toBeUndefined()
    expect(m.send).toHaveBeenCalledTimes(1)
  })
  it('discards a late preparation after an account switch', async () => {
    let resolve!: (value: ReturnType<typeof cash>) => void
    m.cash.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    await manual()
    const button = renderer.root.findAllByType('button').find(node => text(node) === 'Cash out Defifa NFTs')!
    await act(async () => button.props.onClick())
    m.account = OTHER; await act(async () => renderer.update(element()))
    await act(async () => resolve(cash())); await settle()
    expect(reviewOpen()).toBe(false)
    expect(m.send).not.toHaveBeenCalled()
  })
  it('releases an unsent step before another deliberate attempt', async () => {
    m.send.mockImplementationOnce(async action => { await action.beforeWallet(action.calls[0], 0); await action.onUnsent(action.calls[0], 0); return null })
    await manual(); await click('Cash out Defifa NFTs')
    await click('Review again'); expect(m.send).toHaveBeenCalledTimes(2)
  })
  it('rejects a project change between fresh verification and the wallet writer', async () => {
    let release!: () => void
    m.send.mockImplementationOnce(async action => {
      await action.reverify(action.calls[0], 0)
      await new Promise<void>(resolve => { release = resolve })
      await action.beforeWallet(action.calls[0], 0)
      throw new Error('Writer must not be reached')
    })
    await manual(); await click('Cash out Defifa NFTs')
    await act(async () => renderer.update(element(2)))
    await act(async () => release()); await settle()
    expect(text(renderer.root)).toContain('project changed before submission')
    expect(reviewOpen()).toBe(false)
  })
  it('does not permit another send after an ambiguous hashless wallet write', async () => {
    await manual(); await click('Cash out Defifa NFTs')
    expect(text(renderer.root)).toContain('submission outcome is unknown')
    expect(offered()).toBeUndefined()
    expect(m.send).toHaveBeenCalledTimes(1)
  })
  it.each(['unknown', 'proof-error'])('can close a nonbusy %s while retaining the saved original action', async outcome => {
    await manual(); await click('Cash out Defifa NFTs')
    if (outcome === 'proof-error') {
      m.phase = 'success'; m.hash = `0x${'a'.repeat(64)}`; m.receipt = { transactionHash: m.hash }; m.verify.mockRejectedValueOnce(new Error('Unverified NFT effects'))
      await act(async () => renderer.update(element())); await settle()
    }
    const record = m.saved
    await click('Close')
    expect(m.read).toHaveBeenCalled(); expect(m.saved).toBe(record); expect(m.clear).not.toHaveBeenCalled()
    expect(text(renderer.root)).toContain('Original NFT action retained'); expect(m.send).toHaveBeenCalledTimes(1)
  })
  it('retains the reviewed currency symbol when a pending action survives project changes', async () => {
    await manual(); await click('Cash out Defifa NFTs')
    m.phase = 'pending'; m.hash = `0x${'a'.repeat(64)}`
    await act(async () => renderer.update(element(2, { ...shop, pricing: { ...shop.pricing, symbol: 'USDC' } })))
    expect(text(renderer.root)).toContain('Reclaimed0 ETH')
    expect(text(renderer.root)).toContain('Minimum0 ETH')
    expect(text(renderer.root)).not.toContain('0 USDC')
  })
  it('permits a new action only after SDK-authenticated canonical reversion, retaining its failed hash', async () => {
    await manual(); await click('Cash out Defifa NFTs')
    m.phase = 'error'; m.hash = `0x${'a'.repeat(64)}`; m.receipt = { transactionHash: m.hash }
    m.verify.mockRejectedValueOnce(new DefifaNftTransactionRevertedError(`0x${'a'.repeat(64)}`, 1))
    await act(async () => renderer.update(element())); await settle()
    expect(text(renderer.root)).toContain('reviewed transaction reverted onchain')
    expect(m.clear).toHaveBeenCalledTimes(1)
    await click('Done')
    m.phase = 'idle'; m.hash = null; m.receipt = null
    await act(async () => renderer.update(element()))
    expect(text(renderer.root)).toContain('View previous failed transaction')
    await manual(); await click('Cash out Defifa NFTs')
    expect(m.send).toHaveBeenCalledTimes(2)
  })
  it.each(['chain', 'hash'])('keeps a typed failure with mismatched %s evidence held', async changed => {
    await manual(); await click('Cash out Defifa NFTs')
    m.phase = 'error'; m.hash = `0x${'a'.repeat(64)}`; m.receipt = { transactionHash: m.hash }
    m.verify.mockRejectedValueOnce(new DefifaNftTransactionRevertedError(`0x${(changed === 'hash' ? 'b' : 'a').repeat(64)}`, changed === 'chain' ? 10 : 1))
    await act(async () => renderer.update(element())); await settle()
    expect(text(renderer.root)).toContain('NFT effects are not verified')
    expect(m.clear).not.toHaveBeenCalled()
    expect(renderer.root.findAllByType('button').find(node => text(node) === 'Done')).toBeUndefined()
    expect(offered()).toBeUndefined()
    expect(m.send).toHaveBeenCalledTimes(1)
  })
  it('keeps failed receipt proof held and allows only read-only verification retry', async () => {
    await manual(); await click('Cash out Defifa NFTs')
    m.phase = 'success'; m.hash = `0x${'a'.repeat(64)}`; m.receipt = { transactionHash: m.hash }; m.verify.mockRejectedValueOnce(new Error('Missing native effects'))
    await act(async () => renderer.update(element())); await settle()
    expect(text(renderer.root)).toContain('NFT effects are not verified')
    expect(offered()).toBeUndefined()
    await click('Retry receipt verification'); expect(text(renderer.root)).toContain('NFT effects verified onchain'); expect(m.clear).toHaveBeenCalledTimes(1); expect(m.send).toHaveBeenCalledTimes(1)
  })
})
