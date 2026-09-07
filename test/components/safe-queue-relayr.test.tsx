import { createElement } from 'react'
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer'
import { zeroAddress, type Address, type Hex } from 'viem'
import type { JBChainId } from '@bananapus/nana-sdk-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SafeQueuedTx } from '@/lib/safe'
import type { RelayrEntry, RelayrPendingSession } from '@/lib/relayr'

const SAFE = '0x1111111111111111111111111111111111111111' as Address
const OWNER = '0x2222222222222222222222222222222222222222' as Address
const TARGET = '0x3333333333333333333333333333333333333333' as Address
const BUNDLE = '12345678-1234-1234-1234-123456789abc'
const HASH = `0x${'ab'.repeat(32)}` as Hex

const mocks = vi.hoisted(() => ({
  rows: [] as Array<{
    chainId: JBChainId
    name: string
    projectId: number
    isRevnet: boolean
    handleTuples: Array<{ chainId: number; projectId: number }>
    info: { owners: Address[]; threshold: number }
    currentNonce: number
    transactions: SafeQueuedTx[]
    error: null
  }>,
  session: null as RelayrPendingSession | null,
  refetch: vi.fn(),
  simulate: vi.fn(),
  execute: vi.fn(),
  post: vi.fn(),
  pay: vi.fn(),
  poll: vi.fn(),
  save: vi.fn(),
  clear: vi.fn(),
  review: vi.fn(),
}))

vi.mock('@/hooks/useWallet', () => ({ useWallet: () => ({ address: OWNER }) }))
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: mocks.rows, refetch: mocks.refetch }),
}))
vi.mock('@/components/ChainIcon', () => ({ ChainIcon: () => null }))
vi.mock('@/lib/authority', () => ({
  clientFor: () => ({ readContract: async () => SAFE }),
}))
vi.mock('@/lib/safe', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/safe')>()),
  listPendingSafeTxs: async (chainId: number) =>
    mocks.rows.find(row => row.chainId === chainId)?.transactions ?? [],
  hasSafeService: () => true,
  simulateSafeExecution: mocks.simulate,
  executeSafeTx: mocks.execute,
}))
vi.mock('@/lib/transaction-review', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/transaction-review')>()),
  requireTransactionReview: mocks.review,
}))
vi.mock('@/lib/relayr', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/relayr')>()),
  loadRelayrPendingSession: () => mocks.session,
  saveRelayrPendingSession: mocks.save,
  saveRelayrPendingSessionDurably: mocks.save,
  clearRelayrPendingSession: mocks.clear,
  relayrPostBundle: mocks.post,
  relayrPay: mocks.pay,
  relayrPoll: mocks.poll,
}))

import { SafeQueueCard } from '@/components/project/SafeQueueCard'
import { canonicalSafeTxHash } from '@/lib/safe'
import {
  RELAYR_NATIVE_TOKEN,
  RELAYR_PAYMENT_ADDRESS,
  RELAYR_PAYMENT_SELECTOR,
  RelayrPaymentSendingError,
  relayrPay,
} from '@/lib/relayr'

function queued(nonce: number): SafeQueuedTx {
  return {
    to: TARGET,
    data: '0x1234',
    value: '0',
    operation: 0,
    safeTxGas: '0',
    baseGas: '0',
    gasPrice: '0',
    gasToken: zeroAddress,
    refundReceiver: zeroAddress,
    nonce,
    confirmations: [{ owner: OWNER, signature: null }],
  }
}

function chain(chainId: JBChainId, nonces: number[]) {
  return {
    chainId,
    name: `Chain ${chainId}`,
    projectId: 42,
    isRevnet: false,
    handleTuples: [{ chainId, projectId: 42 }],
    info: { owners: [OWNER], threshold: 1 },
    currentNonce: nonces[0],
    transactions: nonces.map(queued),
    error: null,
  }
}

function quote(entries: RelayrEntry[], seconds = 3_600, fundingChains = [1, 10]) {
  const deadline = Math.floor(Date.now() / 1_000) + seconds
  return {
    bundle_uuid: BUNDLE,
    payment_info: fundingChains.map(chain => ({
      chain,
      target: RELAYR_PAYMENT_ADDRESS,
      token: RELAYR_NATIVE_TOKEN,
      amount: '1000',
      payment_deadline: new Date(deadline * 1_000).toISOString(),
      calldata: `${RELAYR_PAYMENT_SELECTOR}${BUNDLE.replaceAll('-', '')}${'0'.repeat(32)}${deadline.toString(16).padStart(64, '0')}` as Hex,
    })),
    expectedTransactions: entries.map((entry, index) => ({
      entry,
      chain: entry.chain,
      txUuid: `00000000-0000-0000-0000-${String(index + 1).padStart(12, '0')}`,
    })),
  }
}

function textOf(node: ReactTestInstance): string {
  return node.children.map(child => typeof child === 'string' ? child : textOf(child)).join('')
}

let renderer: TestRenderer.ReactTestRenderer

async function renderQueue() {
  await act(async () => {
    renderer = TestRenderer.create(createElement(SafeQueueCard, {
      safe: SAFE,
      chains: mocks.rows,
      authorityLabel: 'Project owner',
    }))
  })
}

function button(label: RegExp) {
  const match = renderer.root.findAllByType('button').find(node => label.test(textOf(node)))
  if (!match) throw new Error(`Button missing: ${label}`)
  return match
}

async function click(label: RegExp) {
  await act(async () => { await button(label).props.onClick() })
}

async function selectPayment(index: number) {
  await act(async () => {
    renderer.root.findAllByType('input').filter(node => node.props.type === 'radio')[index].props.onChange()
  })
}

beforeEach(() => {
  mocks.rows = [chain(1, [5, 6]), chain(10, [5, 6])]
  mocks.session = null
  mocks.simulate.mockReset().mockImplementation(async (chainId: JBChainId, safe: Address, tx: SafeQueuedTx) => ({
    tx,
    safeTxHash: canonicalSafeTxHash(chainId, safe, tx),
    policyFingerprint: 'unchanged',
  }))
  mocks.execute.mockReset().mockResolvedValue({ status: 'confirmed', hash: HASH })
  mocks.post.mockReset().mockImplementation(async (entries: RelayrEntry[]) => quote(entries))
  mocks.save.mockReset().mockImplementation((_scope: string, session: RelayrPendingSession) => {
    mocks.session = session
    return session
  })
  mocks.clear.mockReset().mockImplementation(() => { mocks.session = null })
  mocks.pay.mockReset().mockImplementation(async (...args: Parameters<typeof relayrPay>) => {
    args[6]?.()
    throw new RelayrPaymentSendingError()
  })
  mocks.poll.mockReset().mockRejectedValue(new Error('Bundle outcomes remain unresolved.'))
  mocks.review.mockReset().mockResolvedValue(undefined)
})

afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount())
})

describe('Safe queue Relayr execution', () => {
  it('relays only the executable nonce on each testnet and offers no mainnet payment', async () => {
    const testnets = [11155111, 11155420, 84532, 421614] as const
    mocks.rows = testnets.map(id => chain(id, [5, 6]))
    mocks.post.mockImplementationOnce(async (entries: RelayrEntry[]) => quote(entries, 3_600, [1, 11155111, 84532]))
    await renderQueue()
    await click(/Review 4 ready executions/)
    expect(mocks.post.mock.calls[0][0].map((entry: RelayrEntry) => entry.chain)).toEqual(testnets)
    expect(mocks.simulate.mock.calls.map(args => args[2].nonce)).toEqual([5, 5, 5, 5])
    expect(renderer.root.findAllByType('input').filter(node => node.props.type === 'radio')).toHaveLength(2)
    await selectPayment(1)
    await click(/Pay once and execute 4/)
    expect(mocks.pay).toHaveBeenCalledWith(expect.objectContaining({ chain: 84532 }), OWNER, BUNDLE, [...testnets],
      expect.any(Function), expect.any(Function), expect.any(Function))
    expect(mocks.execute).not.toHaveBeenCalled()
    expect(mocks.session).toMatchObject({ paymentStatus: 'sending', chainIds: [...testnets], paymentChainId: 84532 })
  })

  it('quotes only the current nonce per chain and requires an explicit funding selection', async () => {
    await renderQueue()
    await click(/Review 2 ready executions/)
    expect(mocks.post.mock.calls[0][0]).toHaveLength(2)
    expect(mocks.simulate.mock.calls.map(args => args[2].nonce)).toEqual([5, 5])
    expect(button(/Pay once and execute 2/).props.disabled).toBe(true)
    expect(renderer.root.findAllByType('input').filter(node => node.props.type === 'radio')
      .every(node => !node.props.checked)).toBe(true)

    await selectPayment(1)
    await click(/Pay once and execute 2/)
    expect(mocks.pay).toHaveBeenCalledWith(
      expect.objectContaining({ chain: 10 }), OWNER, BUNDLE, [1, 10],
      expect.any(Function), expect.any(Function), expect.any(Function),
    )
    expect(mocks.session).toMatchObject({
      bundleUuid: BUNDLE, paymentStatus: 'sending', paymentHash: null,
      expectedCount: 2, chainIds: [1, 10],
    })
    expect(mocks.session?.expectedSafeExecutions).toHaveLength(2)
    expect(mocks.clear).not.toHaveBeenCalled()
    expect(button(/Pay once and execute 2/).props.disabled).toBe(true)
    await click(/Check bundle status/)
    expect(mocks.pay).toHaveBeenCalledTimes(1)
    expect(mocks.clear).not.toHaveBeenCalled()
  })

  it('requires a new funding choice when the ISO deadline triggers a refreshed quote', async () => {
    mocks.post
      .mockImplementationOnce(async (entries: RelayrEntry[]) => quote(entries, 30))
      .mockImplementationOnce(async (entries: RelayrEntry[]) => quote(entries, 3_600, [1]))
    await renderQueue()
    await click(/Review 2 ready executions/)
    await selectPayment(1)
    await click(/Pay once and execute 2/)
    expect(mocks.post).toHaveBeenCalledTimes(2)
    expect(mocks.pay).not.toHaveBeenCalled()
    expect(mocks.review).not.toHaveBeenCalled()
    expect(button(/Pay once and execute 2/).props.disabled).toBe(true)
    expect(renderer.root.findAllByType('input').filter(node => node.props.type === 'radio'))
      .toHaveLength(1)
  })

  it('executes mixed network families directly and preserves dependent nonce order', async () => {
    mocks.rows = [chain(11155111, [5, 6]), chain(1, [5])]
    await renderQueue()
    await click(/Review 3 ready executions/)
    expect(mocks.post).not.toHaveBeenCalled()
    expect(mocks.pay).not.toHaveBeenCalled()
    expect(mocks.execute).toHaveBeenCalledTimes(3)
    expect(mocks.execute.mock.calls.filter(args => args[0] === 11155111).map(args => args[2].nonce)).toEqual([5, 6])
    expect(mocks.execute.mock.calls.filter(args => args[0] === 1).map(args => args[2].nonce)).toEqual([5])
  })

  it('stops later direct Safe nonces while the first execution is still pending', async () => {
    mocks.rows = [chain(1, [5, 6])]
    mocks.execute.mockResolvedValueOnce({ status: 'submitted', hash: HASH })
    await renderQueue()
    await click(/Review 2 ready executions/)
    expect(mocks.execute).toHaveBeenCalledTimes(1)
    expect(mocks.post).not.toHaveBeenCalled()
    expect(textOf(renderer.root)).toMatch(/later nonces were not submitted/)
  })

  it('rechecks persisted pending state immediately before opening the wallet', async () => {
    await renderQueue()
    await click(/Review 2 ready executions/)
    await selectPayment(0)
    mocks.session = {
      bundleUuid: 'aaaaaaaa-1234-1234-1234-123456789abc',
      paymentStatus: 'sending', paymentHash: null, paymentChainId: 1,
      expectedCount: 2, chainIds: [1, 10], records: [], itemCount: 2,
      account: OWNER, createdAt: Date.now(),
    }
    await click(/Pay once and execute 2/)
    expect(mocks.save).not.toHaveBeenCalled()
    expect(mocks.clear).not.toHaveBeenCalled()
    expect(mocks.session.bundleUuid).toBe('aaaaaaaa-1234-1234-1234-123456789abc')
    expect(textOf(renderer.root)).toMatch(/already has an unresolved Relayr bundle/)
  })

  it('keeps a confirmed payment and every chain outcome when Relayr reports a partial failure', async () => {
    mocks.pay.mockImplementation(async (...args: Parameters<typeof relayrPay>) => {
      args[6]?.()
      args[4]?.(HASH)
      return HASH
    })
    mocks.poll.mockImplementation(async (_bundle, _count, onUpdate) => {
      onUpdate([
        { chain: 1, tx_uuid: '00000000-0000-0000-0000-000000000001', status: { state: 'success', data: { hash: HASH } } },
        { chain: 10, tx_uuid: '00000000-0000-0000-0000-000000000002', status: { state: 'failed' } },
      ])
      throw new Error('One destination failed.')
    })
    await renderQueue()
    await click(/Review 2 ready executions/)
    await selectPayment(0)
    await click(/Pay once and execute 2/)
    expect(mocks.session).toMatchObject({ paymentStatus: 'confirmed', paymentHash: HASH })
    expect(mocks.session?.records).toHaveLength(2)
    expect(mocks.clear).not.toHaveBeenCalled()
    expect(textOf(renderer.root)).toMatch(/Relayr-reported; onchain proof pending/)
    expect(textOf(renderer.root)).toMatch(/Failed/)
    await click(/Check bundle status/)
    expect(mocks.pay).toHaveBeenCalledTimes(1)
    expect(mocks.post).toHaveBeenCalledTimes(1)
    expect(mocks.clear).not.toHaveBeenCalled()
  })
})
