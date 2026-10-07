import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement, type ReactNode } from 'react'
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer'
import { zeroAddress, type Address } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  account: '0x1111111111111111111111111111111111111111' as Address,
  phase: 'idle',
  multicall: vi.fn(),
  readContract: vi.fn(),
  contexts: vi.fn(),
  terminal: vi.fn(),
  send: vi.fn(),
  reset: vi.fn(),
}))

vi.mock('wagmi', () => ({ useConfig: () => ({}) }))
vi.mock('wagmi/actions', () => ({
  getAccount: () => ({ address: mocks.account }),
  getPublicClient: () => ({ multicall: mocks.multicall, readContract: mocks.readContract }),
}))
vi.mock('@/hooks/useWallet', () => ({
  useWallet: () => ({ address: mocks.account, isConnected: true, openSignIn: vi.fn() }),
}))
vi.mock('@/hooks/useSafeTx', () => ({
  useSafeTx: () => ({ phase: mocks.phase, busy: false, send: mocks.send, reset: mocks.reset }),
}))
vi.mock('@bananapus/nana-sdk-core/v6', async importOriginal => ({
  ...(await importOriginal<typeof import('@bananapus/nana-sdk-core/v6')>()),
  getAccountingContexts: mocks.contexts,
  resolvePaymentTerminal: mocks.terminal,
}))
vi.mock('@/components/ui/ModalShell', () => ({
  ModalShell: ({ children }: { children: ReactNode }) => createElement('div', null, children),
}))
vi.mock('@/components/ui/TxConfirmDialog', () => ({
  TxConfirmDialog: ({ title, onConfirm, preparing }: {
    title: string
    onConfirm: () => void
    preparing: boolean
  }) => createElement('section', null, title,
    createElement('button', { onClick: onConfirm, disabled: preparing }, 'Confirm & redeem')),
}))

import { RedeemShopItemsModal, type RedeemableShopTarget } from '@/components/project/RedeemShopItemsModal'
import { NATIVE_TOKEN } from '@bananapus/nana-sdk-core'

const ALICE = '0x1111111111111111111111111111111111111111' as Address
const BOB = '0x2222222222222222222222222222222222222222' as Address
const HOOK = '0x3333333333333333333333333333333333333333' as Address
const TERMINAL = '0x5555555555555555555555555555555555555555' as Address
const target: RedeemableShopTarget = {
  chainId: 1,
  projectId: 42,
  hook: HOOK,
  idTarget: HOOK,
  items: [{ tokenId: '7', tierId: 1 }],
}

let client: QueryClient
let renderer: TestRenderer.ReactTestRenderer | undefined

function text(instance: ReactTestInstance): string {
  return instance.children.map(child => typeof child === 'string' ? child : text(child)).join('')
}

function modal(value = target) {
  return createElement(QueryClientProvider, { client }, createElement(RedeemShopItemsModal, {
    targets: [value], names: { 1: 'Banny' }, onClose: () => {},
  }))
}

async function settle() {
  await act(async () => { await vi.advanceTimersByTimeAsync(1) })
}

async function mount(value = target) {
  await act(async () => { renderer = TestRenderer.create(modal(value)) })
  await settle()
}

async function unmount() {
  await act(async () => { renderer?.unmount() })
  renderer = undefined
}

async function click(label: string) {
  const button = renderer!.root.findAllByType('button').find(item => text(item) === label)
  expect(button, label).toBeDefined()
  expect(button!.props.disabled).not.toBe(true)
  await act(async () => { await button!.props.onClick() })
  await settle()
}

function quoteQuery() {
  return client.getQueryCache().find({ queryKey: ['shop-item-cash-out-quote'], exact: false })!
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-07T12:00:00.000Z'))
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
  mocks.account = ALICE
  mocks.phase = 'idle'
  mocks.multicall.mockReset().mockImplementation(async ({ contracts }: { contracts: unknown[] }) =>
    contracts.map(() => ({ status: 'success', result: mocks.account })))
  mocks.contexts.mockReset().mockResolvedValue([{ token: NATIVE_TOKEN, decimals: 18, currency: 1 }])
  mocks.terminal.mockReset().mockResolvedValue({ address: TERMINAL, isRouter: false })
  mocks.readContract.mockReset().mockImplementation(async ({ functionName }: { functionName: string }) => {
    if (functionName === 'previewCashOutFrom') return [0n, 10n ** 18n, 0n]
    if (functionName === 'FEELESS_ADDRESSES') return zeroAddress
    if (functionName === 'feeFreeSurplusOf') return 0n
    throw new Error(`Unexpected contract read: ${functionName}`)
  })
  mocks.send.mockReset().mockResolvedValue(undefined)
})

afterEach(async () => {
  await unmount()
  client.clear()
})

describe('shop redemption preparation query', () => {
  it('reuses a successful quote for five seconds and refetches at expiry and invalidation', async () => {
    await mount()
    expect(text(renderer!.root)).toContain("You'll receive approximately")
    const readAt = quoteQuery().state.dataUpdatedAt
    await unmount()
    vi.setSystemTime(readAt + 4_999)
    await mount()
    expect(mocks.contexts).toHaveBeenCalledTimes(1)
    await unmount()
    vi.setSystemTime(readAt + 5_000)
    await mount()
    expect(mocks.contexts).toHaveBeenCalledTimes(2)
    await unmount()
    await client.invalidateQueries({ queryKey: ['shop-item-cash-out-quote'] })
    await mount()
    expect(mocks.contexts).toHaveBeenCalledTimes(3)
  })

  it.each([
    ['chain', { chainId: 10 }],
    ['project', { projectId: 43 }],
    ['hook', { hook: BOB }],
    ['metadata target', { idTarget: BOB }],
    ['token selection', { items: [{ tokenId: '8', tierId: 1 }] }],
    ['account', {}],
  ] as const)('isolates quotes by %s and reuses the original exact identity', async (identity, changed) => {
    await mount()
    await unmount()
    if (identity === 'account') mocks.account = BOB
    await mount({ ...target, ...changed, items: 'items' in changed ? [...changed.items] : target.items })
    expect(mocks.contexts).toHaveBeenCalledTimes(2)
    expect(client.getQueryCache().findAll({ queryKey: ['shop-item-cash-out-quote'] })).toHaveLength(2)
    await unmount()
    mocks.account = ALICE
    await mount()
    expect(mocks.contexts).toHaveBeenCalledTimes(2)
  })

  it('forces fresh ownership and quote reads for review despite a fresh displayed quote', async () => {
    await mount()
    await click('Redeem 1 item')
    expect(mocks.multicall).toHaveBeenCalledTimes(2)
    expect(mocks.contexts).toHaveBeenCalledTimes(2)
    expect(text(renderer!.root)).toContain('Confirm redemption')
    await click('Confirm & redeem')
    expect(mocks.send).toHaveBeenCalledTimes(1)
    expect(mocks.send.mock.calls[0][1]).toMatchObject({ reviewedAccount: ALICE })
  })

  it('retries a failed quote on remount without granting it a freshness window', async () => {
    mocks.contexts.mockRejectedValueOnce(new Error('RPC unavailable'))
    await mount()
    expect(text(renderer!.root)).toContain('RPC unavailable')
    await unmount()
    await mount()
    expect(mocks.contexts).toHaveBeenCalledTimes(2)
    expect(text(renderer!.root)).toContain("You'll receive approximately")
  })

  it('blocks review after ownership changes and retries after a failed refresh', async () => {
    await mount()
    mocks.multicall.mockResolvedValueOnce([{ status: 'success', result: BOB }])
    await click('Redeem 1 item')
    expect(text(renderer!.root)).toContain('Your item ownership changed.')
    expect(text(renderer!.root)).not.toContain('Confirm redemption')
    expect(mocks.send).not.toHaveBeenCalled()
    await unmount()
    await mount()
    expect(mocks.multicall).toHaveBeenCalledTimes(3)
    expect(text(renderer!.root)).toContain("You'll receive approximately")
  })

  it('invalidates the quote after confirmed redemption so reopening reads again', async () => {
    await mount()
    await click('Redeem 1 item')
    await click('Confirm & redeem')
    mocks.phase = 'success'
    await act(async () => { renderer!.update(modal()) })
    await settle()
    expect(quoteQuery().state.isInvalidated).toBe(true)
    expect(mocks.contexts).toHaveBeenCalledTimes(2)
    await unmount()
    mocks.phase = 'idle'
    await mount()
    expect(mocks.contexts).toHaveBeenCalledTimes(3)
  })
})
