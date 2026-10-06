import { createElement } from 'react'
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer'
import { zeroAddress, type Address, type Hex } from 'viem'
import type { JBChainId } from '@bananapus/nana-sdk-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SafeQueuedTransaction } from '@bananapus/nana-sdk-core/safe-service'
import type { RelayrEntry } from '@bananapus/nana-sdk-core/review/relayr'
import type { RelayrPendingSession } from '@/lib/relayr'

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
    transactions: SafeQueuedTransaction[]
    blocked: Record<string, string>
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
  viaSafeApp: false,
  chainId: undefined as number | undefined,
}))

vi.mock('@/hooks/useWallet', () => ({ useWallet: () => ({ address: OWNER }) }))
vi.mock('@wagmi/core', async importOriginal => ({
  ...(await importOriginal<typeof import('@wagmi/core')>()),
  getAccount: () => ({ address: OWNER, chainId: mocks.chainId }),
}))
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: mocks.rows, refetch: mocks.refetch }),
}))
vi.mock('@/components/ChainIcon', () => ({ ChainIcon: () => null }))
vi.mock('@/hooks/useEnsName', () => ({ useEnsName: () => ({ data: undefined }) }))
vi.mock('@/lib/safe-connector', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/safe-connector')>()),
  useSafeConnection: () => mocks.viaSafeApp,
}))
vi.mock('@/lib/authority', () => ({
  clientFor: () => ({ readContract: async () => SAFE }),
}))
vi.mock('@/lib/safe', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/safe')>()),
  readSafeQueue: async (chainId: number) => {
    const row = mocks.rows.find(candidate => candidate.chainId === chainId)
    return { nonce: row?.currentNonce ?? 0, pending: row?.transactions ?? [] }
  },
  simulateSafeExecution: mocks.simulate,
  executeSafeTx: mocks.execute,
}))
vi.mock('@bananapus/nana-sdk-core/safe-service', async importOriginal => ({
  ...(await importOriginal<typeof import('@bananapus/nana-sdk-core/safe-service')>()),
  hasSafeService: () => true,
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
import { canonicalSafeTxHash } from '@bananapus/nana-sdk-core/safe-service'
import {
  RELAYR_NATIVE_TOKEN,
  RELAYR_PAYMENT_ADDRESS,
  RELAYR_PAYMENT_SELECTOR,
  relayrPaymentDetails,
  sentRelayrPayment,
} from '@bananapus/nana-sdk-core/review/relayr'
import {
  RelayrPaymentSendingError,
  relayrPay,
  relayrPaymentLabel,
} from '@/lib/relayr'

function queued(nonce: number): SafeQueuedTransaction {
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
    blocked: {},
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
    renderer.root.findByType('select').props.onChange({ target: { value: String(index) } })
  })
}

beforeEach(() => {
  mocks.viaSafeApp = false
  mocks.chainId = undefined
  mocks.rows = [chain(1, [5, 6]), chain(10, [5, 6])]
  mocks.session = null
  mocks.simulate.mockReset().mockImplementation(async (chainId: JBChainId, safe: Address, tx: SafeQueuedTransaction) => ({
    tx,
    safeTxHash: canonicalSafeTxHash(chainId, safe, tx),
    policyFingerprint: 'unchanged',
    owners: [OWNER],
  }))
  mocks.execute.mockReset().mockResolvedValue({ status: 'confirmed', hash: HASH })
  mocks.post.mockReset().mockImplementation(async (entries: RelayrEntry[]) => quote(entries))
  mocks.save.mockReset().mockImplementation((_scope: string, session: RelayrPendingSession) => {
    mocks.session = session
    return session
  })
  mocks.clear.mockReset().mockImplementation(() => { mocks.session = null })
  mocks.pay.mockReset().mockImplementation(async ({ payment, bundleUuid, destinationChainIds, onSending }: Parameters<typeof relayrPay>[0]) => {
    onSending?.(relayrPaymentDetails(payment, { bundleUuid, destinationChainIds }))
    throw new RelayrPaymentSendingError()
  })
  mocks.poll.mockReset().mockRejectedValue(new Error('Bundle outcomes remain unresolved.'))
  mocks.review.mockReset().mockResolvedValue(undefined)
})

afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount())
})

describe('Safe queue Relayr execution', () => {
  it('checks independent chains concurrently before quoting and before payment', async () => {
    await renderQueue()
    const checkPhase = async (run: () => Promise<void>) => {
      const started: number[] = []
      const releases = new Map<number, () => void>()
      mocks.simulate.mockImplementation(async (chainId: JBChainId, safe: Address, tx: SafeQueuedTransaction) => {
        started.push(chainId)
        await new Promise<void>(resolve => releases.set(chainId, resolve))
        return { tx, safeTxHash: canonicalSafeTxHash(chainId, safe, tx), policyFingerprint: 'unchanged', owners: [OWNER] }
      })
      await act(async () => {
        const pending = run()
        await vi.waitFor(() => expect(started).toEqual([1, 10]))
        releases.get(10)!()
        releases.get(1)!()
        await pending
      })
    }
    await checkPhase(() => button(/Execute 2 ready/).props.onClick())
    expect(mocks.post.mock.calls[0][0].map((entry: RelayrEntry) => entry.chain)).toEqual([1, 10])
    await selectPayment(0)
    mocks.pay.mockImplementationOnce(async (...args: Parameters<typeof relayrPay>) => {
      await args[0].reverify?.()
      throw new Error('Stopped before wallet payment')
    })
    await checkPhase(() => button(/Pay once and execute 2/).props.onClick())
    expect(mocks.simulate).toHaveBeenCalledTimes(4)
    expect(mocks.save).not.toHaveBeenCalled()
  })

  it('does not quote a batch if any concurrent chain check fails', async () => {
    mocks.simulate.mockRejectedValueOnce(new Error('Safe policy changed'))
    await renderQueue()
    await click(/Execute 2 ready/)
    expect(mocks.simulate).toHaveBeenCalledTimes(2)
    expect(mocks.post).not.toHaveBeenCalled()
    expect(mocks.pay).not.toHaveBeenCalled()
  })

  it('blocks payment when a concurrent recheck detects changed Safe policy', async () => {
    await renderQueue()
    await click(/Execute 2 ready/)
    await selectPayment(0)
    mocks.simulate.mockRejectedValueOnce(new Error('Safe policy changed'))
    const submit = vi.fn()
    mocks.pay.mockImplementationOnce(async (...args: Parameters<typeof relayrPay>) => {
      await args[0].reverify?.()
      submit()
      return HASH
    })
    await click(/Pay once and execute 2/)
    expect(mocks.simulate).toHaveBeenCalledTimes(4)
    expect(submit).not.toHaveBeenCalled()
    expect(mocks.save).not.toHaveBeenCalled()
  })

  it('relays only the executable nonce on each testnet and offers no mainnet payment', async () => {
    const testnets = [11155111, 11155420, 84532, 421614] as const
    mocks.rows = testnets.map(id => chain(id, [5, 6]))
    mocks.post.mockImplementationOnce(async (entries: RelayrEntry[]) => quote(entries, 3_600, [1, 11155111, 84532]))
    await renderQueue()
    await click(/Execute 4 ready/)
    expect(mocks.post.mock.calls[0][0].map((entry: RelayrEntry) => entry.chain)).toEqual(testnets)
    expect(mocks.simulate.mock.calls.map(args => args[2].nonce)).toEqual([5, 5, 5, 5])
    expect(renderer.root.findAllByType('option').filter(node => !node.props.disabled)).toHaveLength(2)
    await selectPayment(1)
    await click(/Pay once and execute 4/)
    expect(mocks.pay).toHaveBeenCalledWith(expect.objectContaining({ payment: expect.objectContaining({ chain: 84532 }),
      account: OWNER, bundleUuid: BUNDLE, destinationChainIds: [...testnets], reverifyBeforeSendOnly: true }))
    // Check 1 ran at review; check 2 belongs to relayrPay right before sending.
    expect(mocks.simulate).toHaveBeenCalledTimes(4)
    expect(mocks.review).toHaveBeenCalledTimes(1)
    expect(mocks.review.mock.calls[0][0].calls).toEqual(testnets.map(chainId => expect.objectContaining({
      chainId, to: SAFE, functionName: 'execTransaction',
      calls: [expect.objectContaining({ data: '0x1234', value: 0n })],
    })))
    expect(mocks.review.mock.invocationCallOrder[0]).toBeLessThan(mocks.post.mock.invocationCallOrder[0])
    expect(mocks.execute).not.toHaveBeenCalled()
    expect(mocks.session).toMatchObject({ paymentStatus: 'sending', chainIds: [...testnets], paymentChainId: 84532 })
  })

  it('quotes only the current nonce per chain and requires an explicit funding selection', async () => {
    await renderQueue()
    await click(/Execute 2 ready/)
    expect(mocks.post.mock.calls[0][0]).toHaveLength(2)
    expect(mocks.simulate.mock.calls.map(args => args[2].nonce)).toEqual([5, 5])
    expect(button(/Pay once and execute 2/).props.disabled).toBe(true)
    const select = renderer.root.findByType('select')
    expect(select.props.value).toBe(-1)
    expect(select.props['aria-label']).toBe('Pay on')
    expect(renderer.root.findAllByType('option').map(textOf)).toEqual([
      'Choose a chain',
      ...quote([]).payment_info.map(relayrPaymentLabel),
    ])

    await selectPayment(1)
    await click(/Pay once and execute 2/)
    expect(mocks.pay).toHaveBeenCalledWith(expect.objectContaining({ payment: expect.objectContaining({ chain: 10 }),
      account: OWNER, bundleUuid: BUNDLE, destinationChainIds: [1, 10], reverifyBeforeSendOnly: true }))
    expect(mocks.session).toMatchObject({
      bundleUuid: BUNDLE, paymentStatus: 'sending', paymentHash: null,
      expectedCount: 2, chainIds: [1, 10],
    })
    expect(mocks.session?.expectedSafeExecutions).toHaveLength(2)
    expect(mocks.clear).not.toHaveBeenCalled()
    // A saved receipt replaces the pay button, so no second payment can start.
    expect(() => button(/Pay once and execute 2/)).toThrow()
    await click(/Check status/)
    expect(mocks.pay).toHaveBeenCalledTimes(1)
    expect(mocks.clear).not.toHaveBeenCalled()
  })

  it('preselects the connected chain when it is quoted', async () => {
    mocks.chainId = 10
    await renderQueue()
    await click(/Execute 2 ready/)
    expect(renderer.root.findByType('select').props.value).toBe(1)
    await click(/Pay once and execute 2/)
    expect(mocks.pay).toHaveBeenCalledWith(expect.objectContaining({ payment: expect.objectContaining({ chain: 10 }),
      account: OWNER, bundleUuid: BUNDLE, destinationChainIds: [1, 10], reverifyBeforeSendOnly: true }))
  })

  it('asks for another pay click when the ISO deadline refreshes the quote, preselecting a lone offer', async () => {
    mocks.post
      .mockImplementationOnce(async (entries: RelayrEntry[]) => quote(entries, 30))
      .mockImplementationOnce(async (entries: RelayrEntry[]) => quote(entries, 3_600, [1]))
    await renderQueue()
    await click(/Execute 2 ready/)
    await selectPayment(1)
    await click(/Pay once and execute 2/)
    expect(mocks.post).toHaveBeenCalledTimes(2)
    expect(mocks.pay).not.toHaveBeenCalled()
    expect(mocks.review).toHaveBeenCalledTimes(1)
    expect(renderer.root.findAllByType('option').filter(node => !node.props.disabled)).toHaveLength(1)
    expect(renderer.root.findByType('select').props.value).toBe(0)
    expect(button(/Pay once and execute 2/).props.disabled).toBe(false)
  })

  it('executes mixed network families directly and preserves dependent nonce order', async () => {
    mocks.rows = [chain(11155111, [5, 6]), chain(1, [5])]
    await renderQueue()
    await click(/Execute 3 ready/)
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
    await click(/Execute 2 ready/)
    expect(mocks.execute).toHaveBeenCalledTimes(1)
    expect(mocks.post).not.toHaveBeenCalled()
    expect(textOf(renderer.root)).toMatch(/later nonces were not submitted/)
  })

  it('rechecks persisted pending state immediately before opening the wallet', async () => {
    await renderQueue()
    await click(/Execute 2 ready/)
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
    mocks.pay.mockImplementation(async ({ payment, bundleUuid, destinationChainIds, onSending, onSent }: Parameters<typeof relayrPay>[0]) => {
      const details = relayrPaymentDetails(payment, { bundleUuid, destinationChainIds })
      onSending?.(details)
      const payments = [sentRelayrPayment(details, HASH)]
      onSent?.(payments)
      return { hash: HASH, payments }
    })
    mocks.poll.mockImplementation(async (_bundle, _count, onUpdate) => {
      onUpdate([
        { chain: 1, tx_uuid: '00000000-0000-0000-0000-000000000001', status: { state: 'success', data: { hash: HASH } } },
        { chain: 10, tx_uuid: '00000000-0000-0000-0000-000000000002', status: { state: 'failed' } },
      ])
      throw new Error('One destination failed.')
    })
    await renderQueue()
    await click(/Execute 2 ready/)
    await selectPayment(0)
    await click(/Pay once and execute 2/)
    expect(mocks.session).toMatchObject({ paymentStatus: 'confirmed', paymentHash: HASH })
    expect(mocks.session?.records).toHaveLength(2)
    expect(mocks.clear).not.toHaveBeenCalled()
    expect(textOf(renderer.root)).toMatch(/Landed \| verifying/)
    expect(textOf(renderer.root)).toMatch(/Failed/)
    await click(/Check status/)
    expect(mocks.pay).toHaveBeenCalledTimes(1)
    expect(mocks.post).toHaveBeenCalledTimes(1)
    expect(mocks.clear).not.toHaveBeenCalled()
  })

  it('refuses a queued transaction that pays a gas refund, in one line', async () => {
    mocks.rows = [{ ...chain(1, [5]), transactions: [{ ...queued(5), gasPrice: '1', confirmations: [] }] }]
    await renderQueue()
    expect(textOf(renderer.root)).toContain("This transaction pays a gas refund, so it can't be executed here.")
    expect(renderer.root.findAllByType('button').filter(node => /^(Sign|Execute)$/.test(textOf(node)))).toHaveLength(0)
    expect(() => button(/ready/)).toThrow()
  })

  it('hands execution to Safe{Wallet} when the site is opened as a Safe App', async () => {
    mocks.viaSafeApp = true
    await renderQueue()
    expect(() => button(/Execute 2 ready/)).toThrow()
    expect(renderer.root.findAllByType('button').filter(node => /^Execute$/.test(textOf(node)))).toHaveLength(0)
    expect(textOf(renderer.root)).toMatch(/connected as a Safe/)
  })
})
