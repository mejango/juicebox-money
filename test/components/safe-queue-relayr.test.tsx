import { createElement } from 'react'
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer'
import { zeroAddress, type Address, type Hex } from 'viem'
import type { JBChainId } from '@bananapus/nana-sdk-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SafeQueuedTransaction } from '@bananapus/nana-sdk-core/safe-service'
import type { RelayrEntry, RelayrTransactionRecord } from '@bananapus/nana-sdk-core/review/relayr'
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
  realStorage: false,
  refetch: vi.fn(),
  simulate: vi.fn(),
  simulateFrozen: vi.fn(),
  execute: vi.fn(),
  post: vi.fn(),
  pay: vi.fn(),
  poll: vi.fn(),
  save: vi.fn(),
  clear: vi.fn(),
  review: vi.fn(),
  viaSafeApp: false,
  chainId: undefined as number | undefined,
  address: '0x2222222222222222222222222222222222222222' as Address | undefined,
  bundle: null as { bundle_uuid: string; payment_received: boolean; transactions: RelayrTransactionRecord[] } | null,
  getBlock: vi.fn(),
  getTransaction: vi.fn(),
  getTransactionReceipt: vi.fn(),
  request: vi.fn(),
}))

vi.mock('@/hooks/useWallet', () => ({ useWallet: () => ({ address: mocks.address }) }))
vi.mock('@wagmi/core', async importOriginal => ({
  ...(await importOriginal<typeof import('@wagmi/core')>()),
  getAccount: () => ({ address: mocks.address, chainId: mocks.chainId }),
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
  simulateFrozenSafeExecution: mocks.simulateFrozen,
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
vi.mock('@/lib/relayr', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/relayr')>()
  return {
    ...actual,
    loadRelayrPendingSession: (scope: string, requireExactFunding = false) => mocks.realStorage
      ? actual.loadRelayrPendingSession(scope, requireExactFunding) : mocks.session,
    saveRelayrPendingSession: (scope: string, session: RelayrPendingSession) => mocks.realStorage
      ? actual.saveRelayrPendingSession(scope, session) : mocks.save(scope, session),
    saveRelayrPendingSessionDurably: (scope: string, session: RelayrPendingSession, preserveOnFailure?: boolean) => mocks.realStorage
      ? actual.saveRelayrPendingSessionDurably(scope, session, preserveOnFailure) : mocks.save(scope, session, preserveOnFailure),
    clearRelayrPendingSession: (scope: string) => mocks.realStorage ? actual.clearRelayrPendingSession(scope) : mocks.clear(scope),
    relayrPostBundle: mocks.post,
    relayrPay: mocks.pay,
    relayrPoll: mocks.poll,
    relayrChainClient: (chainId: number) => ({
      getBlock: mocks.getBlock,
      getTransaction: mocks.getTransaction,
      getTransactionReceipt: mocks.getTransactionReceipt,
      request: (args: unknown) => mocks.request(chainId, args),
    }),
  }
})

import { SafeQueueCard } from '@/components/project/SafeQueueCard'
import { safeExecRelayrEntry } from '@/lib/safe'
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
  clearRelayrPendingSession,
  loadRelayrPendingSession,
  saveRelayrPendingSession,
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
  const transactions = entries.map((entry, index) => ({
    chain: entry.chain,
    request: entry,
    tx_uuid: `00000000-0000-0000-0000-${String(index + 1).padStart(12, '0')}`,
    status: { state: 'pending' },
  }))
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
    transactions,
    tx_uuids: transactions.map(transaction => transaction.tx_uuid),
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

async function closeBatch() {
  await act(async () => {
    renderer.root.findAllByType('button').find(node => node.props['aria-label'] === 'Close')!.props.onClick()
  })
}

async function updateQueue() {
  await act(async () => {
    renderer.update(createElement(SafeQueueCard, {
      safe: SAFE, chains: mocks.rows, authorityLabel: 'Project owner',
    }))
  })
}

function setupRealRelayrStorage() {
  const records = new Map<string, string>()
  const storage = {
    getItem: (key: string) => records.get(key) ?? null,
    setItem: (key: string, value: string) => { records.set(key, value) },
    removeItem: (key: string) => { records.delete(key) },
    key: (index: number) => [...records.keys()][index] ?? null,
    get length() { return records.size },
  }
  vi.stubGlobal('window', { localStorage: storage })
  mocks.realStorage = true
  const scope = `safe-queue:${SAFE}`
  clearRelayrPendingSession(scope)
  return { scope, storage }
}

async function publicationWithLostQuote() {
  const { scope } = setupRealRelayrStorage()
  mocks.post.mockRejectedValueOnce(new Error('The quote response was lost.'))
  await renderQueue()
  await click(/Execute 2 ready/)
  expect(loadRelayrPendingSession(scope)?.safeLifecycle).toMatchObject({
    state: 'publishing', paymentStatus: 'unfunded',
  })
  expect(loadRelayrPendingSession(scope)?.safeLifecycle?.quote).toBeUndefined()
  await closeBatch()
  await act(async () => renderer.unmount())
  await renderQueue()
  return scope
}

beforeEach(() => {
  mocks.viaSafeApp = false
  mocks.chainId = undefined
  mocks.address = OWNER
  mocks.bundle = null
  mocks.rows = [chain(1, [5, 6]), chain(10, [5, 6])]
  mocks.session = null
  mocks.realStorage = false
  mocks.simulate.mockReset().mockImplementation(async (chainId: JBChainId, safe: Address, tx: SafeQueuedTransaction) => ({
    tx,
    safeTxHash: canonicalSafeTxHash(chainId, safe, tx),
    policyFingerprint: 'unchanged',
    owners: [OWNER],
  }))
  mocks.simulateFrozen.mockReset().mockResolvedValue('unchanged')
  mocks.getBlock.mockReset().mockImplementation(async () => ({ number: 10n, hash: HASH, timestamp: BigInt(Math.floor(Date.now() / 1_000)) }))
  mocks.getTransaction.mockReset().mockRejectedValue(new Error('Payment has not been mined.'))
  mocks.getTransactionReceipt.mockReset().mockRejectedValue(new Error('Payment has not been mined.'))
  mocks.request.mockReset().mockResolvedValue(`0x${'5'.padStart(64, '0')}`)
  mocks.execute.mockReset().mockResolvedValue({ status: 'confirmed', hash: HASH })
  mocks.post.mockReset().mockImplementation(async (entries: RelayrEntry[]) => quote(entries))
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const entries = (JSON.parse(String(init.body)) as { transactions: RelayrEntry[] }).transactions
      const quoted = await mocks.post(entries)
      mocks.bundle = { bundle_uuid: quoted.bundle_uuid, payment_received: false, transactions: quoted.transactions }
      return Response.json(quoted)
    }
    if (!mocks.bundle) throw new Error('No saved Relayr bundle.')
    return Response.json(mocks.bundle)
  }))
  mocks.save.mockReset().mockImplementation((_scope: string, session: RelayrPendingSession) => {
    mocks.session = session
    return session
  })
  mocks.clear.mockReset().mockImplementation(() => { mocks.session = null })
  mocks.pay.mockReset().mockImplementation(async ({ payment, bundleUuid, destinationChainIds, reverify, onSending }: Parameters<typeof relayrPay>[0]) => {
    await reverify?.()
    await onSending?.(relayrPaymentDetails(payment, { bundleUuid, destinationChainIds }))
    throw new RelayrPaymentSendingError()
  })
  mocks.poll.mockReset().mockRejectedValue(new Error('Bundle outcomes remain unresolved.'))
  mocks.review.mockReset().mockResolvedValue(undefined)
})

afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount())
  if (mocks.realStorage) clearRelayrPendingSession(`safe-queue:${SAFE}`)
})

describe('Safe queue Relayr execution', () => {
  it('checks independent chains concurrently before quoting and before payment', async () => {
    await renderQueue()
    const checkPhase = async (run: () => Promise<void>) => {
      const started: number[] = []
      const releases = new Map<number, () => void>()
      mocks.simulateFrozen.mockImplementation(async (chainId: JBChainId) => {
        started.push(chainId)
        await new Promise<void>(resolve => releases.set(chainId, resolve))
        return 'unchanged'
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
    expect(mocks.simulateFrozen).toHaveBeenCalledTimes(4)
    expect(mocks.session?.paymentStatus).toBe('unpaid')
  })

  it('does not quote a batch if any concurrent chain check fails', async () => {
    mocks.simulateFrozen.mockRejectedValueOnce(new Error('Safe policy changed'))
    await renderQueue()
    await click(/Execute 2 ready/)
    expect(mocks.simulateFrozen).toHaveBeenCalledTimes(2)
    expect(mocks.post).not.toHaveBeenCalled()
    expect(mocks.pay).not.toHaveBeenCalled()
    await click(/Retry checks/)
    expect(mocks.simulateFrozen).toHaveBeenCalledTimes(4)
    expect(mocks.post).toHaveBeenCalledTimes(1)
    expect(mocks.pay).not.toHaveBeenCalled()
  })

  it('blocks payment when a concurrent recheck detects changed Safe policy', async () => {
    await renderQueue()
    await click(/Execute 2 ready/)
    await selectPayment(0)
    mocks.simulateFrozen.mockRejectedValueOnce(new Error('Safe policy changed'))
    const submit = vi.fn()
    mocks.pay.mockImplementationOnce(async (...args: Parameters<typeof relayrPay>) => {
      await args[0].reverify?.()
      submit()
      return HASH
    })
    await click(/Pay once and execute 2/)
    expect(mocks.simulateFrozen).toHaveBeenCalledTimes(4)
    expect(submit).not.toHaveBeenCalled()
    expect(mocks.session?.paymentStatus).toBe('unpaid')
  })

  it('relays only the executable nonce on each testnet and offers no mainnet payment', async () => {
    const testnets = [11155111, 11155420, 84532, 421614] as const
    mocks.rows = testnets.map(id => chain(id, [5, 6]))
    mocks.post.mockImplementationOnce(async (entries: RelayrEntry[]) => quote(entries, 3_600, [1, 11155111, 84532]))
    await renderQueue()
    await click(/Execute 4 ready/)
    expect(mocks.post.mock.calls[0][0].map((entry: RelayrEntry) => entry.chain)).toEqual(testnets)
    expect(mocks.simulateFrozen.mock.calls.map(args => args[2])).toEqual([5, 5, 5, 5])
    expect(renderer.root.findAllByType('option').filter(node => !node.props.disabled)).toHaveLength(2)
    await selectPayment(1)
    await click(/Pay once and execute 4/)
    expect(mocks.pay).toHaveBeenCalledWith(expect.objectContaining({ payment: expect.objectContaining({ chain: 84532 }),
      account: OWNER, bundleUuid: BUNDLE, destinationChainIds: [...testnets], reverifyBeforeSendOnly: true }))
    // Check 1 ran at review; check 2 belongs to relayrPay right before sending.
    expect(mocks.simulateFrozen).toHaveBeenCalledTimes(8)
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
    expect(mocks.simulateFrozen.mock.calls.map(args => args[2])).toEqual([5, 5])
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
    await click(/Check existing bundle/)
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

  it('retains the original quote after a definite wallet rejection before any payment hash', async () => {
    mocks.pay.mockImplementationOnce(async ({ payment, bundleUuid, destinationChainIds, reverify, onSending }: Parameters<typeof relayrPay>[0]) => {
      await reverify?.()
      await onSending?.(relayrPaymentDetails(payment, { bundleUuid, destinationChainIds }))
      throw Object.assign(new Error('User rejected request.'), { code: 4001 })
    })
    await renderQueue()
    await click(/Execute 2 ready/)
    await selectPayment(0)
    await click(/Pay once and execute 2/)
    expect(mocks.session).toMatchObject({ bundleUuid: BUNDLE, paymentStatus: 'unpaid', paymentHash: null })
    expect(mocks.session?.safeLifecycle?.paymentStatus).toBe('unfunded')
    expect(button(/Pay once and execute 2/).props.disabled).toBe(false)
    expect(mocks.clear).not.toHaveBeenCalled()
    await closeBatch()
    await click(/Execute 2 ready/)
    expect(mocks.post).toHaveBeenCalledTimes(1)
    expect(mocks.pay).toHaveBeenCalledTimes(1)
    expect(mocks.review).toHaveBeenLastCalledWith(expect.objectContaining({ confirmLabel: 'Use saved quote' }))
  })

  it('keeps the original payable quote when its deadline is near on the device clock', async () => {
    mocks.post.mockImplementationOnce(async (entries: RelayrEntry[]) => quote(entries, 30))
    await renderQueue()
    await click(/Execute 2 ready/)
    await selectPayment(1)
    await click(/Pay once and execute 2/)
    expect(mocks.post).toHaveBeenCalledTimes(1)
    expect(mocks.pay).toHaveBeenCalledTimes(1)
    expect(mocks.review).toHaveBeenCalledTimes(1)
    expect(mocks.session).toMatchObject({ bundleUuid: BUNDLE, paymentStatus: 'sending' })
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
    const savedBeforePayment = mocks.save.mock.calls.length
    await click(/Pay once and execute 2/)
    expect(mocks.save).toHaveBeenCalledTimes(savedBeforePayment)
    expect(mocks.pay).not.toHaveBeenCalled()
    expect(mocks.clear).not.toHaveBeenCalled()
    expect(mocks.session.bundleUuid).toBe('aaaaaaaa-1234-1234-1234-123456789abc')
    expect(textOf(renderer.root)).toMatch(/another account|unavailable|immutable execution proof/)
  })

  it.each(['replaced', 'missing'] as const)('offers recovery when the reviewed journal is %s before funding', async state => {
    const { scope } = setupRealRelayrStorage()
    await renderQueue()
    await click(/Execute 2 ready/)
    const saved = loadRelayrPendingSession(scope)!
    await selectPayment(0)
    if (state === 'missing') clearRelayrPendingSession(scope)
    else saveRelayrPendingSession(scope, {
      ...saved, safeLifecycle: { ...saved.safeLifecycle!, id: 'replacement-session' },
    })
    await click(/Pay once and execute 2/)
    expect(mocks.pay).not.toHaveBeenCalled()
    expect(mocks.post).toHaveBeenCalledTimes(1)
    expect(button(/Check existing bundle/).props.disabled).toBe(false)
    expect(() => button(/Pay once and execute 2/)).toThrow()
    if (state === 'missing') expect(loadRelayrPendingSession(scope)).toBeNull()
    else expect(loadRelayrPendingSession(scope)?.safeLifecycle?.id).toBe('replacement-session')
  })

  it('keeps a confirmed payment and every chain outcome when Relayr reports a partial failure', async () => {
    mocks.pay.mockImplementation(async ({ payment, bundleUuid, destinationChainIds, reverify, onSending, onSent }: Parameters<typeof relayrPay>[0]) => {
      const details = relayrPaymentDetails(payment, { bundleUuid, destinationChainIds })
      await reverify?.()
      await onSending?.(details)
      const payments = [sentRelayrPayment(details, HASH)]
      await onSent?.(payments)
      mocks.getTransaction.mockResolvedValue({
        hash: HASH, chainId: payment.chain, from: OWNER, to: details.target,
        input: details.calldata, value: details.amount, blockHash: HASH, blockNumber: 10n,
      })
      mocks.getTransactionReceipt.mockResolvedValue({
        transactionHash: HASH, to: details.target, blockHash: HASH, blockNumber: 10n, status: 'success',
      })
      mocks.bundle = { bundle_uuid: BUNDLE, payment_received: true, transactions: [
        { chain: 1, tx_uuid: '00000000-0000-0000-0000-000000000001', status: { state: 'success', data: { hash: HASH } } },
        { chain: 10, tx_uuid: '00000000-0000-0000-0000-000000000002', status: { state: 'failed' } },
      ] }
      return { hash: HASH, payments }
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
    await click(/Check existing bundle/)
    expect(mocks.pay).toHaveBeenCalledTimes(1)
    expect(mocks.post).toHaveBeenCalledTimes(1)
    expect(mocks.clear).not.toHaveBeenCalled()
  })

  it('does not publish or pay after closing during the checks', async () => {
    let release!: () => void
    const checks = new Promise<void>(resolve => { release = resolve })
    mocks.simulateFrozen.mockImplementation(async () => { await checks; return 'unchanged' })
    await renderQueue()
    let preparing!: Promise<void>
    await act(async () => {
      preparing = button(/Execute 2 ready/).props.onClick()
      await vi.waitFor(() => expect(mocks.simulateFrozen).toHaveBeenCalledTimes(2))
    })
    await closeBatch()
    await act(async () => { release(); await preparing })
    expect(renderer.root.findAllByType('dialog')).toHaveLength(0)
    expect(mocks.review).not.toHaveBeenCalled()
    expect(mocks.post).not.toHaveBeenCalled()
    expect(mocks.pay).not.toHaveBeenCalled()
    expect(mocks.save).not.toHaveBeenCalled()
  })

  it('retains a quote returned after closing and resumes it without publishing again', async () => {
    let release!: () => void
    const quoted = new Promise<void>(resolve => { release = resolve })
    mocks.post.mockImplementationOnce(async (entries: RelayrEntry[]) => { await quoted; return quote(entries) })
    await renderQueue()
    let preparing!: Promise<void>
    await act(async () => {
      preparing = button(/Execute 2 ready/).props.onClick()
      await vi.waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1))
    })
    await closeBatch()
    await act(async () => { release(); await preparing })
    expect(renderer.root.findAllByType('dialog')).toHaveLength(0)
    expect(mocks.session?.safeLifecycle).toMatchObject({ state: 'active', bundleUuid: BUNDLE, paymentStatus: 'unfunded' })
    expect(mocks.pay).not.toHaveBeenCalled()
    await click(/View existing bundle/)
    expect(mocks.review).toHaveBeenCalledTimes(1)
    await click(/Review saved quote/)
    expect(mocks.post).toHaveBeenCalledTimes(1)
    expect(mocks.review).toHaveBeenLastCalledWith(expect.objectContaining({ confirmLabel: 'Use saved quote' }))
    expect(renderer.root.findAllByType('select')).toHaveLength(1)
  })

  it('invalidates checking when the connected account changes', async () => {
    let release!: () => void
    const checks = new Promise<void>(resolve => { release = resolve })
    mocks.simulateFrozen.mockImplementation(async () => { await checks; return 'unchanged' })
    await renderQueue()
    let preparing!: Promise<void>
    await act(async () => {
      preparing = button(/Execute 2 ready/).props.onClick()
      await vi.waitFor(() => expect(mocks.simulateFrozen).toHaveBeenCalledTimes(2))
    })
    mocks.address = TARGET
    await updateQueue()
    await act(async () => { release(); await preparing })
    expect(renderer.root.findAllByType('dialog')).toHaveLength(0)
    expect(mocks.review).not.toHaveBeenCalled()
    expect(mocks.post).not.toHaveBeenCalled()
    expect(mocks.pay).not.toHaveBeenCalled()
    expect(button(/Execute 2 ready/).props.disabled).toBe(false)
  })

  it('does not publish after unmounting during the checks', async () => {
    let release!: () => void
    const checks = new Promise<void>(resolve => { release = resolve })
    mocks.simulateFrozen.mockImplementation(async () => { await checks; return 'unchanged' })
    await renderQueue()
    let preparing!: Promise<void>
    await act(async () => {
      preparing = button(/Execute 2 ready/).props.onClick()
      await vi.waitFor(() => expect(mocks.simulateFrozen).toHaveBeenCalledTimes(2))
    })
    await act(async () => renderer.unmount())
    await act(async () => { release(); await preparing })
    expect(mocks.post).not.toHaveBeenCalled()
    expect(mocks.pay).not.toHaveBeenCalled()
    expect(mocks.save).not.toHaveBeenCalled()
  })

  it('ignores an old check failure after closing and starting another review', async () => {
    let reject!: (reason: Error) => void
    const checks = new Promise<string>((_resolve, rejectPromise) => { reject = rejectPromise })
    mocks.simulateFrozen.mockImplementationOnce(() => checks)
    await renderQueue()
    let preparing!: Promise<void>
    await act(async () => {
      preparing = button(/Execute 2 ready/).props.onClick()
      await vi.waitFor(() => expect(mocks.simulateFrozen).toHaveBeenCalledTimes(2))
    })
    await closeBatch()
    // The first run still owns the shared lock until its checks drain.
    await click(/Execute 2 ready/)
    expect(textOf(renderer.root)).toMatch(/already being processed/)
    await act(async () => { reject(new Error('Old run failed')); await preparing })
    expect(textOf(renderer.root)).toMatch(/already being processed/)
    expect(textOf(renderer.root)).not.toMatch(/Old run failed/)
    await click(/Retry checks/)
    expect(mocks.post).toHaveBeenCalledTimes(1)
    expect(mocks.pay).not.toHaveBeenCalled()
  })

  it('resumes and rechecks the original execution bytes when another owner adds a signature', async () => {
    const extraOwner = '0x4444444444444444444444444444444444444444' as Address
    mocks.rows = mocks.rows.map(row => ({ ...row, info: { ...row.info, owners: [OWNER, extraOwner] } }))
    await renderQueue()
    await click(/Execute 2 ready/)
    const originalEntries = mocks.post.mock.calls[0][0] as RelayrEntry[]
    await closeBatch()
    mocks.rows = mocks.rows.map(row => ({ ...row, transactions: row.transactions.map(tx => ({
      ...tx, confirmations: [...(tx.confirmations ?? []), { owner: extraOwner, signature: null }],
    })) }))
    await updateQueue()
    await click(/Execute 2 ready/)
    expect(mocks.post).toHaveBeenCalledTimes(1)
    expect(mocks.review).toHaveBeenLastCalledWith(expect.objectContaining({ confirmLabel: 'Use saved quote' }))
    expect(mocks.simulateFrozen.mock.calls.slice(-2).map(args => args[3])).toEqual(originalEntries.map(entry => entry.data))
    await selectPayment(0)
    await click(/Pay once and execute 2/)
    expect(mocks.simulateFrozen.mock.calls.slice(-2).map(args => args[3])).toEqual(originalEntries.map(entry => entry.data))
    expect(mocks.session?.expectedTransactions?.map(binding => binding.entry)).toEqual(originalEntries)
    expect(mocks.pay).toHaveBeenCalledTimes(1)
    expect(mocks.post).toHaveBeenCalledTimes(1)
  })

  it('keeps an older paid bundle read-only when no canonical destination proof is available', async () => {
    await renderQueue()
    await click(/Execute 2 ready/)
    const saved = mocks.session!
    mocks.session = { ...saved, safeLifecycle: undefined, paymentStatus: 'confirmed', paymentHash: HASH }
    await act(async () => renderer.unmount())
    await renderQueue()
    await click(/View existing bundle/)
    expect(mocks.session?.bundleUuid).toBe(BUNDLE)
    expect(mocks.session?.paymentStatus).toBe('confirmed')
    expect(mocks.post).toHaveBeenCalledTimes(1)
    expect(mocks.pay).not.toHaveBeenCalled()
    expect(mocks.clear).not.toHaveBeenCalled()
    expect(() => button(/Pay once and execute 2/)).toThrow()
  })

  it('retains the existing receipt when a different nonce selection shares its Safe journal', async () => {
    await renderQueue()
    await click(/Execute 2 ready/)
    const saved = structuredClone(mocks.session)
    await closeBatch()
    mocks.rows = [chain(1, [6]), chain(10, [6])]
    await updateQueue()
    await click(/Execute 2 ready/)
    expect(mocks.post).toHaveBeenCalledTimes(1)
    expect(mocks.session).toEqual(saved)
    expect(mocks.pay).not.toHaveBeenCalled()
    expect(button(/Check existing bundle/).props.disabled).toBe(false)
  })

  it('retains a four-chain session ID through real browser storage, remount, funding, and recovery', async () => {
    const { scope, storage } = setupRealRelayrStorage()
    mocks.rows = [1, 10, 8453, 42161].map(chainId => chain(chainId as JBChainId, [5, 6]))
    await renderQueue()
    await click(/Execute 4 ready/)
    const published = loadRelayrPendingSession(scope)!
    expect(published.safeLifecycle).toMatchObject({ state: 'active', account: OWNER, bundleUuid: BUNDLE })
    vi.useFakeTimers()
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    vi.useRealTimers()
    expect(textOf(renderer.root)).not.toMatch(/another account or is unavailable/)
    expect(mocks.post).toHaveBeenCalledTimes(1)
    expect(mocks.pay).not.toHaveBeenCalled()
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
    const sessionId = published.safeLifecycle!.id
    const serialized = JSON.parse(storage.getItem(`jb-relayr-pending-v1:${scope}`)!) as RelayrPendingSession
    expect(serialized.safeLifecycle?.id).toBe(sessionId)

    await closeBatch()
    await act(async () => renderer.unmount())
    await renderQueue()
    await click(/Execute 4 ready/)
    expect(mocks.review).toHaveBeenLastCalledWith(expect.objectContaining({ confirmLabel: 'Use saved quote' }))
    expect(loadRelayrPendingSession(scope)?.safeLifecycle?.id).toBe(sessionId)
    await selectPayment(0)
    await click(/Pay once and execute 4/)
    expect(loadRelayrPendingSession(scope)).toMatchObject({ paymentStatus: 'sending', paymentChainId: 1 })
    expect(loadRelayrPendingSession(scope)?.safeLifecycle?.id).toBe(sessionId)
    await click(/Check existing bundle/)
    expect(loadRelayrPendingSession(scope)?.safeLifecycle?.id).toBe(sessionId)
    expect(mocks.post).toHaveBeenCalledTimes(1)
    expect(mocks.pay).toHaveBeenCalledTimes(1)
    expect(textOf(renderer.root)).not.toMatch(/another account or is unavailable/)
  })

  it.each([
    { account: TARGET, paymentStatus: 'confirmed' as const, legacy: true },
    { account: null, paymentStatus: 'confirmed' as const, legacy: true },
    { account: TARGET, paymentStatus: 'unpaid' as const, legacy: true },
    { account: TARGET, paymentStatus: 'confirmed' as const, legacy: false },
    { account: TARGET, paymentStatus: 'unpaid' as const, legacy: false },
  ])('checks a $paymentStatus bundle from saved account $account (legacy=$legacy) without paying from the current wallet', async ({ account, paymentStatus, legacy }) => {
    const { scope } = setupRealRelayrStorage()
    await renderQueue()
    await click(/Execute 2 ready/)
    const published = loadRelayrPendingSession(scope)!
    saveRelayrPendingSession(scope, {
      ...published, account, paymentStatus,
      safeLifecycle: legacy ? undefined : {
        ...published.safeLifecycle!, account: account as Address,
        paymentStatus: paymentStatus === 'unpaid' ? 'unfunded' : 'confirmed',
      },
      paymentHash: paymentStatus === 'confirmed' ? HASH : null,
    })
    await closeBatch()
    await act(async () => renderer.unmount())
    await renderQueue()
    if (legacy || paymentStatus === 'confirmed') await click(/View existing bundle/)
    else {
      await click(/Execute 2 ready/)
      await click(/Check existing bundle/)
    }
    expect(textOf(renderer.root)).not.toMatch(/another account or is unavailable/)
    expect(loadRelayrPendingSession(scope)?.bundleUuid).toBe(BUNDLE)
    expect(mocks.post).toHaveBeenCalledTimes(1)
    expect(mocks.pay).not.toHaveBeenCalled()
    expect(mocks.review).toHaveBeenCalledTimes(1)
    expect(() => button(/Pay once and execute 2/)).toThrow()
  })

  it('clears a previous action error when opening the saved bundle and checks it without another click', async () => {
    const { scope } = setupRealRelayrStorage()
    await renderQueue()
    await click(/Execute 2 ready/)
    const published = loadRelayrPendingSession(scope)!
    saveRelayrPendingSession(scope, {
      ...published, safeLifecycle: undefined, account: TARGET,
      paymentStatus: 'confirmed', paymentHash: HASH,
    })
    await closeBatch()
    await act(async () => renderer.unmount())
    await renderQueue()
    mocks.execute.mockRejectedValueOnce(new Error('Previous execution error.'))
    await click(/^Execute$/)
    expect(textOf(renderer.root)).toMatch(/Previous execution error/)
    const readsBeforeOpen = vi.mocked(globalThis.fetch).mock.calls.length
    await click(/View existing bundle/)
    expect(vi.mocked(globalThis.fetch).mock.calls.length).toBeGreaterThan(readsBeforeOpen)
    expect(textOf(renderer.root)).not.toMatch(/Previous execution error|another account or is unavailable/)
    expect(mocks.post).toHaveBeenCalledTimes(1)
    expect(mocks.pay).not.toHaveBeenCalled()
    expect(mocks.review).toHaveBeenCalledTimes(1)
  })

  it.each(['live', 'mixed', 'unavailable'] as const)(
    'explains %s Safe nonces automatically when the saved publication has no quote',
    async state => {
      mocks.request.mockImplementation(async (chainId: number) => {
        if (state === 'unavailable' && chainId === 10) throw new Error('RPC unavailable')
        return `0x${(state === 'mixed' && chainId === 1 ? '6' : '5').padStart(64, '0')}`
      })
      const scope = await publicationWithLostQuote()
      await click(/View existing bundle/)
      const text = textOf(renderer.root)
      expect(text).toMatch(state === 'unavailable' ? /Some Safe nonces could not be verified/
        : state === 'mixed' ? /Some saved Safe nonces have been used/
          : /saved Safe nonces are still unused/)
      expect(text).toMatch(/Still queued/)
      if (state === 'mixed') expect(text).toMatch(/Nonce already used/)
      if (state === 'unavailable') expect(text).toMatch(/Could not check nonce/)
      expect(loadRelayrPendingSession(scope)?.safeLifecycle?.state).toBe('publishing')
      expect(mocks.post).toHaveBeenCalledTimes(1)
      expect(mocks.review).toHaveBeenCalledTimes(1)
      expect(mocks.pay).not.toHaveBeenCalled()
      expect(button(/Check Safe nonces/).props.disabled).toBe(false)
    },
  )

  it('releases an unfunded quote-less publication only after every saved nonce is canonically consumed', async () => {
    mocks.request.mockResolvedValue(`0x${'6'.padStart(64, '0')}`)
    const scope = await publicationWithLostQuote()
    await click(/View existing bundle/)
    expect(loadRelayrPendingSession(scope)?.safeLifecycle).toMatchObject({
      state: 'released', paymentStatus: 'unfunded', releaseReason: 'safe-nonces-consumed',
    })
    expect(renderer.root.findAllByType('dialog')).toHaveLength(0)
    expect(textOf(renderer.root)).toMatch(/Every saved Safe nonce has been used/)
    expect(textOf(renderer.root)).not.toMatch(/Executed 2 Safe transactions/)
    expect(mocks.getBlock).toHaveBeenCalledWith({ blockTag: 'finalized' })
    expect(mocks.getBlock).toHaveBeenCalledWith({ blockNumber: 10n })
    expect(mocks.refetch).toHaveBeenCalledOnce()
    expect(mocks.post).toHaveBeenCalledTimes(1)
    expect(mocks.review).toHaveBeenCalledTimes(1)
    expect(mocks.pay).not.toHaveBeenCalled()
  })

  it('explains missing legacy execution proof without pretending its rows are checking', async () => {
    const scope = await publicationWithLostQuote()
    const saved = loadRelayrPendingSession(scope)!
    saveRelayrPendingSession(scope, {
      ...saved, safeLifecycle: undefined, expectedEntries: undefined,
      expectedTransactions: undefined, expectedSafeExecutions: undefined,
    })
    await click(/View existing bundle/)
    expect(textOf(renderer.root)).toMatch(/missing complete Safe transaction details/)
    expect(textOf(renderer.root)).toMatch(/Status unavailable/)
    expect(textOf(renderer.root)).not.toMatch(/Checking…/)
    expect(loadRelayrPendingSession(scope)?.bundleUuid).toBe(saved.bundleUuid)
    expect(mocks.request).not.toHaveBeenCalled()
    expect(mocks.post).toHaveBeenCalledTimes(1)
    expect(mocks.pay).not.toHaveBeenCalled()
  })

  it('refreshes an obsolete saved selection discovered during Execute all without requesting another quote', async () => {
    const scope = await publicationWithLostQuote()
    const saved = loadRelayrPendingSession(scope)!
    await act(async () => renderer.unmount())
    clearRelayrPendingSession(scope)
    await renderQueue()
    // Another tab restores a journal after this card rendered its ready queue.
    saveRelayrPendingSession(scope, saved)
    mocks.request.mockResolvedValue(`0x${'6'.padStart(64, '0')}`)
    await click(/Execute 2 ready/)
    expect(loadRelayrPendingSession(scope)?.safeLifecycle).toMatchObject({
      id: saved.safeLifecycle!.id, state: 'released', releaseReason: 'safe-nonces-consumed',
    })
    expect(renderer.root.findAllByType('dialog')).toHaveLength(0)
    expect(textOf(renderer.root)).toMatch(/Every saved Safe nonce has been used/)
    expect(mocks.refetch).toHaveBeenCalledOnce()
    expect(mocks.post).toHaveBeenCalledTimes(1)
    expect(mocks.review).toHaveBeenCalledTimes(1)
    expect(mocks.pay).not.toHaveBeenCalled()
  })

  it('shows the saved calls and nonces when Execute all discovers a partially overlapping publication', async () => {
    const scope = await publicationWithLostQuote()
    const saved = loadRelayrPendingSession(scope)!
    await act(async () => renderer.unmount())
    clearRelayrPendingSession(scope)
    mocks.rows = [chain(1, [5]), {
      ...chain(10, [20]), transactions: [{ ...queued(20), data: '0xabcd' as Hex }],
    }]
    await renderQueue()
    // Another tab restores the original nonce-5 selection after the new queue renders.
    saveRelayrPendingSession(scope, saved)
    mocks.request.mockImplementation(async (chainId: number) => `0x${(chainId === 10 ? '14' : '5').padStart(64, '0')}`)
    await click(/Execute 2 ready/)
    const dialog = renderer.root.findByType('dialog')
    const rows = dialog.findAllByType('ul')[0].findAllByType('li')
    expect(rows).toHaveLength(2)
    expect(textOf(rows[0])).toMatch(/Ethereum#5Still queued/)
    expect(textOf(rows[1])).toMatch(/Optimism#5Nonce already used/)
    for (const row of rows) expect(textOf(row)).toContain('0x1234')
    expect(textOf(dialog)).not.toMatch(/#20|0xabcd/)
    expect(textOf(dialog)).toMatch(/Some saved Safe nonces have been used/)
    expect(loadRelayrPendingSession(scope)?.safeLifecycle).toMatchObject({
      id: saved.safeLifecycle!.id, state: 'publishing',
    })
    expect(mocks.post).toHaveBeenCalledTimes(1)
    expect(mocks.review).toHaveBeenCalledTimes(1)
    expect(mocks.pay).not.toHaveBeenCalled()
    expect(button(/Check Safe nonces/).props.disabled).toBe(false)
  })

  it.each([
    { label: 'payment history object', malformed: { payments: {} } },
    { label: 'invalid payment history array', malformed: { payments: [{ hash: HASH }] } },
    { label: 'non-hex payment hash', malformed: { paymentHash: 'not-a-hash' } },
    { label: 'truncated payment hash', malformed: { paymentHash: '0x12' } },
    { label: 'payment chain string', malformed: { paymentChainId: '1' } },
    { label: 'negative payment chain', malformed: { paymentChainId: -1 } },
    { label: 'payment options object', malformed: { paymentOptions: {} } },
    { label: 'invalid payment options array', malformed: { paymentOptions: [{ chain: 1, amount: 1000, target: RELAYR_PAYMENT_ADDRESS, calldata: '0x' }] } },
  ])('keeps a legacy journal with $label intact before attempting recovery', async ({ malformed }) => {
    const { scope, storage } = setupRealRelayrStorage()
    const entries = [1, 10].map(chainId => safeExecRelayrEntry(chainId as JBChainId, SAFE, queued(5), [OWNER]))
    const quoted = quote(entries)
    const legacy: RelayrPendingSession = {
      bundleUuid: BUNDLE, paymentHash: null, paymentChainId: null, paymentStatus: 'unpaid',
      chainIds: [1, 10], expectedCount: 2, itemCount: 2, account: OWNER, createdAt: Date.now(),
      records: quoted.transactions, expectedEntries: entries, payments: [], paymentOptions: [],
      expectedSafeExecutions: entries.map((entry, index) => ({
        chainId: entry.chain, safe: SAFE, nonce: 5,
        safeTxHash: canonicalSafeTxHash(entry.chain, SAFE, queued(5)),
        txUuid: quoted.expectedTransactions[index].txUuid,
      })),
    }
    const raw = JSON.stringify({ ...legacy, ...malformed })
    const key = `jb-relayr-pending-v1:${scope}`
    storage.setItem(key, raw)
    mocks.request.mockResolvedValue(`0x${'6'.padStart(64, '0')}`)
    mocks.bundle = { bundle_uuid: BUNDLE, payment_received: false, transactions: quoted.transactions }
    await renderQueue()
    // Mount first exercises the tolerant display reader and its memory cache.
    await click(/View existing bundle/)
    expect(textOf(renderer.root)).toMatch(/unreadable funding information/)
    expect(storage.getItem(key)).toBe(raw)
    expect(mocks.request).not.toHaveBeenCalled()
    expect(mocks.getBlock).not.toHaveBeenCalled()
    expect(globalThis.fetch).not.toHaveBeenCalled()
    expect(mocks.review).not.toHaveBeenCalled()
    expect(mocks.post).not.toHaveBeenCalled()
    expect(mocks.pay).not.toHaveBeenCalled()
    expect(() => button(/Pay once and execute/)).toThrow()
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
