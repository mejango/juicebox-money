// @vitest-environment jsdom
import { QueryClient } from '@tanstack/react-query'
import { createElement, type ReactNode } from 'react'
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer'
import { UserRejectedRequestError, erc20Abi, zeroAddress, type Address } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PreparedDefifaPay } from '@bananapus/nana-sdk-core/v6'
import type { Shop } from '@/hooks/useShop721'

const ALICE = '0x1111111111111111111111111111111111111111' as Address
const BOB = '0x2222222222222222222222222222222222222222' as Address
const HOOK = '0x3333333333333333333333333333333333333333' as Address
const TERMINAL = '0x4444444444444444444444444444444444444444' as Address
const TOKEN = '0x5555555555555555555555555555555555555555' as Address
const NATIVE = '0x000000000000000000000000000000000000EEEe' as Address
const queries = new QueryClient()
const controls = vi.hoisted(() => ({ prepare: vi.fn(), verify: vi.fn(), approvalProof: vi.fn(), media: undefined as Record<number, { image: string }> | undefined }))
vi.mock('@bananapus/nana-sdk-core/v6', async original => ({ ...(await original<typeof import('@bananapus/nana-sdk-core/v6')>()), prepareDefifaPay: controls.prepare, verifyDefifaNftTransaction: controls.verify }))
vi.mock('@bananapus/nana-sdk-core/review', async original => ({ ...(await original<typeof import('@bananapus/nana-sdk-core/review')>()), verifyReviewedWriteReceipt: controls.approvalProof }))
vi.mock('@/hooks/useShop721', async original => ({ ...(await original<typeof import('@/hooks/useShop721')>()), useShop721Media: () => ({ data: controls.media }) }))
vi.mock('@/components/project/DefifaRecovery', () => ({ DefifaRecovery: ({ children }: { children: ReactNode }) => children }))
vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('@wagmi/core', async original => {
  const { wallet } = await import('../support/fake-wallet')
  return { ...(await original<typeof import('@wagmi/core')>()), getAccount: () => ({ address: wallet.account, chainId: 1 }) }
})
vi.mock('wagmi', async () => ({ ...(await import('../support/fake-wallet')).walletHooks }))
vi.mock('@/hooks/useWallet', async () => ({ useWallet: (await import('../support/fake-wallet')).useFakeWallet }))
vi.mock('@/lib/transaction-review', async original => ({ ...(await original<typeof import('@/lib/transaction-review')>()), requestContractTransactionReview: (await import('../support/fake-wallet')).wallet.requestReview }))
vi.mock('@/lib/safe-connector', async original => ({ ...(await original<typeof import('@/lib/safe-connector')>()), isSafeConnection: () => false, useSafeConnection: () => false }))
vi.mock('@tanstack/react-query', async original => ({ ...(await original<typeof import('@tanstack/react-query')>()), useQueryClient: () => queries }))
vi.mock('@/components/ui/ModalShell', () => ({
  ModalDialog: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  ModalCloseButton: (props: Record<string, unknown>) => createElement('button', props),
  useEnclosingModalCard: () => null,
  useHoldEnclosingModal: () => {},
}))
import { DefifaNftTransactionRevertedError, buildDefifaPayMetadata, buildPayTx } from '@bananapus/nana-sdk-core/v6'
import { wallet, sentHash } from '../support/fake-wallet'
import { DefifaCheckout } from '@/components/project/DefifaCheckout'
import { readDefifaWriteRecovery } from '@/lib/defifa-write-recovery'

const shop = {
  protocol: 'defifa', hook: HOOK, phase: 1,
  pricing: { currency: 1, decimals: 18, symbol: 'ETH' },
  tiers: [{ id: 1, name: 'Banny', price: 100n, remaining: 10, currentSupply: 2n, discountPercent: 0 }],
} as Shop
function prepared(token: Address = NATIVE, amount = 100n, delegate: Address = ALICE): PreparedDefifaPay {
  return {
    inventory: {
      protocol: 'defifa', hook: HOOK, store: HOOK, implementation: HOOK,
      contractUri: '', pricing: { token, decimals: 18, currency: 1 }, phase: 1,
      tiers: [], nextStartingId: null, blockNumber: 10n,
      capabilities: { genericPay: false, genericCashOut: false, manageTiers: false },
      ruleset: {
        ruleset: { id: 1, cycleNumber: 1, start: 0, duration: 0, weight: 0n, weightCutPercent: 0, approvalHook: zeroAddress, basedOnId: 0, metadata: 0n },
        metadata: { reservedPercent: 0, cashOutTaxRate: 0, baseCurrency: 1, pausePay: false, pauseCreditTransfers: false, allowOwnerMinting: false, allowSetCustomToken: false, allowTerminalMigration: false, allowSetTerminals: false, allowSetController: false, allowAddAccountingContext: false, allowAddPriceFeed: false, ownerMustSendPayouts: false, holdFees: false, scopeCashOutsToLocalBalances: false, useDataHookForPay: true, useDataHookForCashOut: true, dataHook: HOOK, metadata: 0 },
      },
    },
    transaction: buildPayTx({ chainId: 1, terminal: TERMINAL, projectId: 42n, token, amount, beneficiary: ALICE, metadata: buildDefifaPayMetadata({ metadataIdTarget: HOOK, tierIdsToMint: [1n] }) }),
    amount, selectedTiers: [{ tierId: 1n, count: 1n, unitPrice: amount }], attestationDelegate: zeroAddress, effectiveAttestationDelegate: delegate, effectiveDelegates: [{ tierId: 1n, delegate }],
  }
}
function text(node: ReactTestInstance): string {
  return node.children.map(child => typeof child === 'object' ? text(child) : String(child)).join('')
}
let renderer: TestRenderer.ReactTestRenderer
async function click(label: string) {
  const button = renderer.root.findAllByType('button').find(node => text(node) === label || node.props['aria-label'] === label || node.props.title === `${label} to cart`)
  expect(button, label).toBeDefined()
  await act(async () => button!.props.onClick())
}
async function openReview() { await click('Add Banny'); await click('Review mint') }
beforeEach(async () => {
  localStorage.clear()
  vi.stubGlobal('navigator', { locks: { request: async (name: string, _: unknown, run: (lock: object) => Promise<unknown>) => run({ name }) } })
  wallet.reset(); wallet.connect(ALICE)
  controls.media = undefined
  controls.prepare.mockReset().mockResolvedValue(prepared())
  controls.verify.mockReset().mockResolvedValue(undefined)
  controls.approvalProof.mockReset().mockResolvedValue('success')
  await act(async () => { renderer = TestRenderer.create(createElement(DefifaCheckout, { chainId: 1, projectId: 42, shop })) })
})
afterEach(async () => { await act(async () => renderer.unmount()); localStorage.clear(); vi.unstubAllGlobals() })
describe('native Defifa checkout through the reviewed engine', () => {
  it('wallet-action:mint-defifa-nfts sends the exact prepared call and verifies its receipt before claiming success', async () => {
    await openReview()
    expect(text(renderer.root)).toContain('including NFTs you already hold')
    expect(text(renderer.root)).toContain(ALICE)
    await click('Confirm mint')
    expect(wallet.writes()).toEqual([{ functionName: 'pay', account: ALICE }])
    expect(controls.prepare).toHaveBeenCalledTimes(2)
    expect(text(renderer.root)).not.toContain('NFT mint verified onchain.')
    await act(async () => wallet.confirm(sentHash(1)))
    expect(controls.verify).toHaveBeenCalledWith(wallet.client, expect.objectContaining({ account: ALICE, hook: HOOK, transaction: prepared().transaction }), expect.objectContaining({ transactionHash: sentHash(1) }))
    expect(text(renderer.root)).toContain('NFT mint verified onchain.')
  })
  it('drops an unsent review when the connected account changes', async () => {
    await openReview()
    await act(async () => wallet.connect(BOB))
    expect(text(renderer.root)).not.toContain('Confirm mint')
    expect(wallet.writeContract).not.toHaveBeenCalled()
  })
  it('releases an explicit wallet rejection for a new review', async () => {
    wallet.writeContract.mockRejectedValueOnce(new UserRejectedRequestError(new Error('User rejected')))
    await openReview(); await click('Confirm mint')
    await click('Cancel')
    expect(text(renderer.root)).not.toContain('Confirm mint')
    await openReview()
    expect(text(renderer.root)).toContain('Confirm mint')
  })
  it('dismisses an ambiguous hashless review only while preserving its SDK record and blocking a retry', async () => {
    wallet.writeContract.mockRejectedValueOnce(new Error('Connection closed after submission'))
    await openReview(); await click('Confirm mint')
    const scope = { chainId: 1, projectId: 42, account: ALICE, action: 'pay' as const }
    const original = readDefifaWriteRecovery(scope)
    expect(original).toBeTruthy()
    expect(original?.hash).toBeUndefined()
    expect(text(renderer.root)).toContain('wallet submission is unconfirmed')
    await click('Cancel')
    expect(text(renderer.root)).not.toContain('wallet submission is unconfirmed')
    expect(readDefifaWriteRecovery(scope)).toEqual(original)
    // The boundary is a passthrough in this owning checkout test. The adapter
    // independently blocks even a fresh draft, without exposing another wallet write.
    await openReview(); await click('Confirm mint')
    expect(readDefifaWriteRecovery(scope)).toEqual(original)
    expect(wallet.writeContract).toHaveBeenCalledTimes(1)
  })
  it('discards a late preparation after the account changes', async () => {
    let resolve!: (value: PreparedDefifaPay) => void
    controls.prepare.mockImplementationOnce(() => new Promise<PreparedDefifaPay>(done => { resolve = done }))
    await click('Add Banny'); await click('Review mint')
    await act(async () => wallet.connect(BOB))
    await act(async () => resolve(prepared()))
    expect(text(renderer.root)).not.toContain('Confirm mint')
    expect(wallet.writeContract).not.toHaveBeenCalled()
  })
  it('refuses a project change during simulation before invoking the wallet', async () => {
    let resolve!: (value: { request: Record<string, unknown> }) => void
    let simulated!: Record<string, unknown>
    wallet.client.simulateContract.mockImplementationOnce(async request => {
      simulated = request
      return new Promise<{ request: Record<string, unknown> }>(done => { resolve = done })
    })
    await openReview(); await click('Confirm mint')
    await act(async () => renderer.update(createElement(DefifaCheckout, { chainId: 1, projectId: 43, shop })))
    await act(async () => resolve({ request: simulated }))
    expect(wallet.writeContract).not.toHaveBeenCalled()
    expect(text(renderer.root)).toContain('connected account or project changed')
  })
  it('refuses a wallet switch during the final fresh preparation', async () => {
    await openReview()
    controls.prepare.mockImplementationOnce(async () => { wallet.connect(BOB); return prepared() })
    await click('Confirm mint')
    expect(wallet.writeContract).not.toHaveBeenCalled()
    expect(text(renderer.root)).toContain('connected account or project changed')
  })
  it.each(['price', 'default delegate', 'phase'])('refuses a stale %s after review', async what => {
    await openReview()
    if (what === 'phase') controls.prepare.mockRejectedValueOnce(new Error('Defifa NFT entry is not open.'))
    else controls.prepare.mockResolvedValueOnce(what === 'price' ? prepared(NATIVE, 101n) : prepared(NATIVE, 100n, BOB))
    await click('Confirm mint')
    expect(wallet.writeContract).not.toHaveBeenCalled()
    expect(text(renderer.root)).toContain(what === 'phase' ? 'not open' : 'changed. Review again.')
  })
  it('sorts category-ordered selections by ID while reviewing each native name and price', async () => {
    const ordered = prepared(NATIVE, 600n)
    ordered.transaction = buildPayTx({ chainId: 1, terminal: TERMINAL, projectId: 42n, token: NATIVE, amount: 600n, beneficiary: ALICE, metadata: buildDefifaPayMetadata({ metadataIdTarget: HOOK, tierIdsToMint: [1n, 2n, 3n] }) })
    ordered.selectedTiers = [1n, 2n, 3n].map(tierId => ({ tierId, count: 1n, unitPrice: tierId * 100n }))
    ordered.effectiveDelegates = [1n, 2n, 3n].map(tierId => ({ tierId, delegate: ALICE }))
    controls.prepare.mockResolvedValue(ordered)
    const tiers = [{ ...shop.tiers[0], id: 3, name: 'Third' }, { ...shop.tiers[0], id: 1, name: 'First' }, { ...shop.tiers[0], id: 2, name: 'Second' }]
    await act(async () => renderer.update(createElement(DefifaCheckout, { chainId: 1, projectId: 42, shop: { ...shop, tiers } })))
    await click('Add Third'); await click('Add First'); await click('Add Second'); await click('Review mint')
    expect(controls.prepare).toHaveBeenLastCalledWith(wallet.client, expect.objectContaining({ tierIdsToMint: [1n, 2n, 3n] }))
    expect(text(renderer.root)).toContain('Tier 1: First')
    expect(text(renderer.root)).toContain('Tier 2: Second')
    expect(text(renderer.root)).toContain('Tier 3: Third')
    expect(text(renderer.root)).toContain('0.0000000000000001 ETH')
    expect(text(renderer.root)).toContain('0.0000000000000002 ETH')
    expect(text(renderer.root)).toContain('0.0000000000000003 ETH')
  })
  it('requires a new review when individual tier prices change but the total stays the same', async () => {
    const two = prepared(NATIVE, 200n)
    two.transaction = buildPayTx({ chainId: 1, terminal: TERMINAL, projectId: 42n, token: NATIVE, amount: 200n, beneficiary: ALICE, metadata: buildDefifaPayMetadata({ metadataIdTarget: HOOK, tierIdsToMint: [1n, 2n] }) })
    two.selectedTiers = [{ tierId: 1n, count: 1n, unitPrice: 100n }, { tierId: 2n, count: 1n, unitPrice: 100n }]
    two.effectiveDelegates = [{ tierId: 1n, delegate: ALICE }, { tierId: 2n, delegate: ALICE }]
    controls.prepare.mockResolvedValueOnce(two).mockResolvedValueOnce({ ...two, selectedTiers: [{ tierId: 1n, count: 1n, unitPrice: 90n }, { tierId: 2n, count: 1n, unitPrice: 110n }] })
    await act(async () => renderer.update(createElement(DefifaCheckout, { chainId: 1, projectId: 42, shop: { ...shop, tiers: [...shop.tiers, { ...shop.tiers[0], id: 2, name: 'Bean' }] } })))
    await click('Add Banny'); await click('Add Bean'); await click('Review mint'); await click('Confirm mint')
    expect(wallet.writeContract).not.toHaveBeenCalled()
    expect(text(renderer.root)).toContain('price or voting delegation changed')
  })
  it('permits an explicit new review only after the SDK proves the exact finalized mint failed', async () => {
    controls.verify.mockRejectedValueOnce(new DefifaNftTransactionRevertedError(sentHash(1), 1))
    await openReview(); await click('Confirm mint')
    await act(async () => wallet.confirm(sentHash(1)))
    expect(text(renderer.root)).toContain('NFT mint failed onchain')
    expect(text(renderer.root)).not.toContain('NFT mint verified onchain.')
    await click('Close review')
    expect(text(renderer.root)).toContain(sentHash(1))
    await openReview()
    expect(text(renderer.root)).toContain(sentHash(1))
    expect(wallet.writeContract).toHaveBeenCalledTimes(1)
    expect(text(renderer.root)).toContain('Confirm mint')
  })
  it.each([{ hash: sentHash(2), chainId: 1 }, { hash: sentHash(1), chainId: 8453 }])('does not release a failed proof for another identity $chainId/$hash', async ({ hash, chainId }) => {
    controls.verify.mockRejectedValueOnce(new DefifaNftTransactionRevertedError(hash, chainId))
    await openReview(); await click('Confirm mint')
    await act(async () => wallet.confirm(sentHash(1)))
    expect(text(renderer.root)).toContain('Confirmation needs verification')
    const original = readDefifaWriteRecovery({ chainId: 1, projectId: 42, account: ALICE, action: 'pay' })
    await click('Cancel')
    expect(readDefifaWriteRecovery({ chainId: 1, projectId: 42, account: ALICE, action: 'pay' })).toEqual(original)
    expect(wallet.writeContract).toHaveBeenCalledTimes(1)
  })
  it('retains a submitted mint after an account switch, with unavailable proof and no repeat send', async () => {
    controls.verify.mockRejectedValueOnce(new Error('Receipt unavailable'))
    await openReview(); await click('Confirm mint')
    await act(async () => wallet.connect(BOB))
    expect(text(renderer.root)).toContain(sentHash(1))
    await click('Recheck confirmation')
    expect(wallet.writeContract).toHaveBeenCalledTimes(1)
    await act(async () => wallet.confirm(sentHash(1)))
    expect(text(renderer.root)).toContain('Receipt unavailable')
    expect(text(renderer.root)).not.toContain('NFT mint verified onchain.')
    await click('Recheck confirmation')
    expect(wallet.writeContract).toHaveBeenCalledTimes(1)
    expect(text(renderer.root)).toContain('NFT mint verified onchain.')
  })
  it('wallet-action:approve-defifa-mint-payment approves the exact amount, then simulates mint at the approval block', async () => {
    controls.prepare.mockResolvedValue(prepared(TOKEN))
    wallet.client.readContract.mockImplementation(async ({ functionName, blockNumber }: { functionName: string; blockNumber?: bigint }) => functionName === 'allowance' ? blockNumber === undefined ? 0n : 100n : Promise.reject(new Error('Unexpected read')))
    await openReview(); await click('Approve payment')
    expect(wallet.writes()).toEqual([{ functionName: 'approve', account: ALICE }])
    const call = (wallet.writeContract.mock.calls[0] as unknown as [{ abi: unknown; args: unknown[] }])[0]
    expect(call.abi).toBe(erc20Abi); expect(call.args).toEqual([TERMINAL, 100n])
    await act(async () => wallet.confirm(sentHash(1), 77n))
    expect(text(renderer.root)).toContain('Payment approval verified.')
    await click('Confirm mint')
    expect(wallet.writes()).toEqual([{ functionName: 'approve', account: ALICE }, { functionName: 'pay', account: ALICE }])
    expect(wallet.client.simulateContract).toHaveBeenLastCalledWith(expect.objectContaining({ functionName: 'pay', blockNumber: 77n, account: ALICE }))
  })
  it('allows a new deliberate review only after an authenticated failed approval', async () => {
    controls.prepare.mockResolvedValue(prepared(TOKEN))
    wallet.client.readContract.mockResolvedValue(0n)
    controls.approvalProof.mockResolvedValueOnce('failed')
    await openReview(); await click('Approve payment')
    await act(async () => wallet.confirm(sentHash(1)))
    expect(text(renderer.root)).toContain('payment approval failed onchain')
    expect(renderer.root.findAllByType('button').find(node => text(node) === 'Close review')?.props.disabled).toBe(false)
    await click('Close review')
    expect(text(renderer.root)).toContain(sentHash(1))
    await openReview()
    expect(text(renderer.root)).toContain(sentHash(1))
    expect(text(renderer.root)).toContain('Approve payment')
    expect(wallet.writeContract).toHaveBeenCalledTimes(1)
  })
  it('retains failed approval proof and never starts a mint', async () => {
    controls.prepare.mockResolvedValue(prepared(TOKEN))
    wallet.client.readContract.mockResolvedValue(0n)
    controls.approvalProof.mockRejectedValue(new Error('Approval receipt unavailable'))
    await openReview(); await click('Approve payment')
    await act(async () => wallet.confirm(sentHash(1)))
    expect(text(renderer.root)).toContain('Approval receipt unavailable')
    await click('Recheck confirmation')
    expect(wallet.writes()).toEqual([{ functionName: 'approve', account: ALICE }])
  })
  it('shows inactive phase honestly without a disabled mint placeholder', async () => {
    await act(async () => renderer.update(createElement(DefifaCheckout, { chainId: 1, projectId: 42, shop: { ...shop, phase: 3 } })))
    expect(text(renderer.root)).toContain('NFT minting is not open in this phase.')
    expect(renderer.root.findAllByType('button').every(node => node.props.disabled)).toBe(true)
    expect(text(renderer.root)).toContain('Shop')
  })
  it('retains selections across preview pages in the complete native intent', async () => {
    const tiers = Array.from({ length: 13 }, (_, index) => ({ ...shop.tiers[0], id: index + 1, name: index === 0 ? 'Banny' : `Team ${index + 1}` }))
    const quote = prepared(NATIVE, 200n)
    quote.transaction = buildPayTx({ chainId: 1, terminal: TERMINAL, projectId: 42n, token: NATIVE, amount: 200n, beneficiary: ALICE, metadata: buildDefifaPayMetadata({ metadataIdTarget: HOOK, tierIdsToMint: [1n, 13n] }) })
    quote.selectedTiers = [1n, 13n].map(tierId => ({ tierId, count: 1n, unitPrice: 100n }))
    quote.effectiveDelegates = [1n, 13n].map(tierId => ({ tierId, delegate: ALICE }))
    controls.prepare.mockResolvedValue(quote)
    await act(async () => renderer.update(createElement(DefifaCheckout, { chainId: 1, projectId: 42, shop: { ...shop, tiers } })))
    await click('Add Banny'); await click('Next NFTs'); await click('Add Team 13'); await click('Previous NFTs'); await click('Review mint')
    expect(controls.prepare).toHaveBeenLastCalledWith(wallet.client, expect.objectContaining({ tierIdsToMint: [1n, 13n] }))
    expect(text(renderer.root)).toContain('Tier 1: Banny'); expect(text(renderer.root)).toContain('Tier 13: Team 13')
  })
  it('shows exact mixed-price totals and names across pages in the shared amount and cart owners', async () => {
    const tiers = Array.from({ length: 13 }, (_, index) => ({ ...shop.tiers[0], id: index + 1, name: index === 0 ? 'Banny' : `Team ${index + 1}`, price: index === 12 ? 2750000n : 1250000n }))
    await act(async () => renderer.update(createElement(DefifaCheckout, { chainId: 1, projectId: 42, shop: { ...shop, pricing: { ...shop.pricing, decimals: 6, symbol: 'USDC' }, tiers } })))
    await click('Add Banny'); await click('Next NFTs'); await click('Add Team 13')
    const amount = renderer.root.findByProps({ 'aria-label': 'NFT amount' })
    expect(amount.props.readOnly).toBe(true)
    expect(amount.props.value).toBe('4')
    const summary = renderer.root.findByProps({ 'aria-label': 'Selected NFTs' })
    expect(text(summary)).toContain('Banny')
    expect(text(summary)).toContain('Team 13')
    expect(text(summary)).toContain('2 NFTs4 USDC')
    await click('Previous NFTs')
    expect(renderer.root.findByProps({ 'aria-label': 'NFT amount' }).props.value).toBe('4')
    expect(wallet.writeContract).not.toHaveBeenCalled()
  })
  it('locks preview pages, selection and delegate during a pending quote and review', async () => {
    let finish!: (quote: PreparedDefifaPay) => void
    controls.prepare.mockReturnValueOnce(new Promise<PreparedDefifaPay>(resolve => { finish = resolve }))
    const tiers = Array.from({ length: 13 }, (_, index) => ({ ...shop.tiers[0], id: index + 1, name: index === 0 ? 'Banny' : `Team ${index + 1}` }))
    await act(async () => renderer.update(createElement(DefifaCheckout, { chainId: 1, projectId: 42, shop: { ...shop, tiers } })))
    await click('Add Banny'); await click('Review mint')
    expect(renderer.root.findByProps({ title: 'Add Banny to cart' }).props.disabled).toBe(true)
    expect(renderer.root.findAllByType('button').find(node => text(node) === 'Next NFTs')!.props.disabled).toBe(true)
    expect(renderer.root.findByProps({ placeholder: 'Use the contract default' }).props.disabled).toBe(true)
    await act(async () => { finish(prepared()) })
    expect(renderer.root.findByProps({ title: 'Add Banny to cart' }).props.disabled).toBe(true)
    expect(renderer.root.findAllByType('button').find(node => text(node) === 'Next NFTs')!.props.disabled).toBe(true)
    expect(renderer.root.findByProps({ placeholder: 'Use the contract default' }).props.disabled).toBe(true)
    expect(wallet.writeContract).not.toHaveBeenCalled()
  })
  it('hydrates the shared preview while cosmetic failure leaves selection and preparation usable', async () => {
    controls.media = { 1: { image: 'data:image/svg+xml;base64,PHN2Zy8+' } }
    await act(async () => renderer.update(createElement(DefifaCheckout, { chainId: 1, projectId: 42, shop })))
    expect(renderer.root.findByType('img').props.alt).toBe('Banny')
    controls.media = undefined
    await act(async () => renderer.update(createElement(DefifaCheckout, { chainId: 1, projectId: 42, shop })))
    expect(renderer.root.findAllByType('img')).toHaveLength(0)
    await openReview()
    expect(controls.prepare).toHaveBeenCalledOnce()
  })

})
