import { NATIVE_TOKEN } from '@bananapus/nana-sdk-core'
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, keccak256, parseAbiParameters, zeroHash, type Address, type Hex, type TransactionReceipt } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  bendystraw: vi.fn(), clientFor: vi.fn(), symbol: vi.fn(),
  client: { getBlock: vi.fn(), readContract: vi.fn() },
}))
vi.mock('@/lib/bendystraw', () => ({ bendystraw: mocks.bendystraw }))
vi.mock('@/lib/authority', () => ({ clientFor: mocks.clientFor }))
vi.mock('@/lib/token-symbol', () => ({ tokenSymbol: mocks.symbol }))

import { fetchPendingPayments, paymentCommitment, pendingPaymentCall, pendingPaymentId, pendingPaymentOutcome, reconcilePendingPayment, reviewPendingPayment, reverifyPendingPayment, type PendingPayment } from '@/lib/pending-payments'
import { routerGatewayAbi } from '@/lib/router-gateway-abi'

const ACCOUNT = '0x1111111111111111111111111111111111111111' as Address
const OTHER = '0x2222222222222222222222222222222222222222' as Address
const GATEWAY = '0x4a56aef5b6a5b9742abb02ca67c5a85ba183d901' as Address
const ERROR = `0x${'ab'.repeat(32)}` as Hex
const tuple = (payment: PendingPayment) => ({ amount: BigInt(payment.amount), preferAddToBalance: payment.preferAddToBalance,
  shouldReturnHeldFees: payment.shouldReturnHeldFees, beneficiary: payment.beneficiary, projectId: BigInt(payment.projectId),
  refundTo: payment.refundTo, sourceProjectId: BigInt(payment.sourceProjectId), token: payment.token })
const commitment = (payment: PendingPayment) => keccak256(encodeAbiParameters(
  parseAbiParameters('(uint256 amount, bool preferAddToBalance, bool shouldReturnHeldFees, address beneficiary, uint256 projectId, address refundTo, uint256 sourceProjectId, address token), string, bytes'),
  [tuple(payment), payment.memo, payment.metadata],
))
function payment(index = 1, overrides: Partial<PendingPayment> = {}): PendingPayment {
  const row: PendingPayment = { chainId: 1, version: 6, gateway: GATEWAY, pendingCallId: `0x${index.toString(16).padStart(64, '0')}`,
    projectId: 1, sourceProjectId: 17, token: NATIVE_TOKEN, amount: '25000000000000000', retainedAmount: '25000000000000000',
    preferAddToBalance: false, shouldReturnHeldFees: false, beneficiary: ACCOUNT, refundTo: OTHER,
    memo: 'Fee from project #17', metadata: '0x1234', callCommitment: zeroHash, status: 'queued', ...overrides }
  return { ...row, callCommitment: commitment(row) }
}
const page = (items: PendingPayment[], totalCount = items.length) => ({ routerPendingCalls: { items, totalCount } })
let live: { commitment: Hex; failure: { errorHash: Hex; count: number; lastFailureAt: number; highestGasLimit: bigint }; timestamp: bigint; gasLimit: bigint }

function eventLog(name: string, row: PendingPayment, overrides: Record<string, unknown> = {}): TransactionReceipt['logs'][number] {
  const event = routerGatewayAbi.find(item => item.type === 'event' && item.name === name)
  if (!event || event.type !== 'event') throw new Error(`Missing event ${name}`)
  const args = { id: row.pendingCallId, call: tuple(row), beneficiaryTokenCount: 42n, caller: ACCOUNT,
    errorHash: ERROR, count: 1, nextAttemptAt: 90_000n, ...overrides }
  const inputs = event.inputs.filter(input => !input.indexed)
  return { address: row.gateway, topics: encodeEventTopics({ abi: [event], eventName: event.name, args }),
    data: encodeAbiParameters(inputs, inputs.map(input => args[input.name as keyof typeof args])) } as TransactionReceipt['logs'][number]
}

beforeEach(() => {
  vi.resetAllMocks()
  live = { commitment: payment().callCommitment, failure: { errorHash: zeroHash, count: 0, lastFailureAt: 0, highestGasLimit: 0n }, timestamp: 100_000n, gasLimit: 30_000_000n }
  mocks.clientFor.mockReturnValue(mocks.client)
  mocks.symbol.mockResolvedValue('ETH')
  mocks.client.getBlock.mockImplementation(async () => ({ number: 123n, timestamp: live.timestamp, gasLimit: live.gasLimit }))
  mocks.client.readContract.mockImplementation(async ({ functionName }: { functionName: string }) => {
    if (functionName === 'pendingCallCommitmentOf') return live.commitment
    if (functionName === 'pendingCallFailureOf') return { ...live.failure }
    if (functionName === 'RETRY_DELAY') return 86_400n
    if (functionName === 'FINALIZATION_FAILURE_COUNT') return 3n
    if (functionName === 'decimals') return 6
    throw new Error(`Unexpected read ${functionName}`)
  })
})

describe('complete authenticated pending payment inventory', () => {
  it('loads every page by source project, chain and v6 with a live policy', async () => {
    const rows = Array.from({ length: 101 }, (_, index) => payment(index + 1))
    mocks.bendystraw.mockResolvedValueOnce(page(rows.slice(0, 100), 101)).mockResolvedValueOnce(page(rows.slice(100), 101))
    expect(await fetchPendingPayments(1, 17)).toEqual(rows)
    expect(mocks.bendystraw.mock.calls.map(([, variables, options]) => ({ variables, options }))).toEqual([
      { variables: { chainId: 1, sourceProjectId: 17, gateway: GATEWAY, limit: 100, offset: 0 }, options: { policy: 'live' } },
      { variables: { chainId: 1, sourceProjectId: 17, gateway: GATEWAY, limit: 100, offset: 100 }, options: { policy: 'live' } },
    ])
    expect(mocks.bendystraw.mock.calls[0][0]).toContain('{ version: 6 }')
    expect(mocks.client.readContract).not.toHaveBeenCalled()
  })

  it('accepts a verified empty inventory without inventing an active count', async () => {
    mocks.bendystraw.mockResolvedValue(page([]))
    await expect(fetchPendingPayments(1, 17)).resolves.toEqual([])
  })

  it.each([
    ['a truncated next page', [page([payment()], 2), page([], 2)]],
    ['a changing total count', [page([payment()], 2), page([payment(2)], 3)]],
    ['a duplicate across pages', [page([payment()], 2), page([payment()], 2)]],
    ['a false total count', [page([payment(), payment(2)], 1)]],
    ['an oversized page', [page(Array.from({ length: 101 }, (_, index) => payment(index + 1)), 101)]],
  ])('rejects %s instead of batching a partial list', async (_name, pages) => {
    for (const result of pages) mocks.bendystraw.mockResolvedValueOnce(result)
    await expect(fetchPendingPayments(1, 17)).rejects.toThrow(/incomplete|changed|duplicate|inconsistent/iu)
  })

  it.each([
    ['another chain', { chainId: 10 }], ['another source project', { sourceProjectId: 18 }],
    ['another protocol version', { version: 5 }], ['an unknown gateway', { gateway: OTHER }],
    ['a resolved status', { status: 'settled' }], ['a partially retained amount', { retainedAmount: '1' }],
  ])('rejects a valid commitment for %s', async (_name, changes) => {
    mocks.bendystraw.mockResolvedValue(page([payment(1, changes as Partial<PendingPayment>)]))
    await expect(fetchPendingPayments(1, 17)).rejects.toThrow('could not be verified')
  })

  it.each([
    { amount: '25000000000000001', retainedAmount: '25000000000000001' }, { beneficiary: OTHER },
    { refundTo: ACCOUNT }, { projectId: 2 }, { token: OTHER }, { memo: 'Different memo' },
    { metadata: '0xabcd' as Hex }, { preferAddToBalance: true }, { shouldReturnHeldFees: true },
  ])('rejects indexed tuple, memo or metadata mutation: %j', async changes => {
    mocks.bendystraw.mockResolvedValue(page([{ ...payment(), ...changes }]))
    await expect(fetchPendingPayments(1, 17)).rejects.toThrow('could not be verified')
  })
})

describe('live custody and permissionless retry review', () => {
  it('uses one block for custody and policy, preserves the entire call and spends no principal', async () => {
    const row = payment()
    const review = (await reviewPendingPayment(row))!
    expect(paymentCommitment(row)).toBe(row.callCommitment)
    expect(review).toMatchObject({ ready: true, readyAt: 0n, functionName: 'processPendingCall', decimals: 18, gas: 16_777_216n })
    expect(mocks.client.readContract.mock.calls).toHaveLength(4)
    for (const [request] of mocks.client.readContract.mock.calls) expect(request).toMatchObject({ address: GATEWAY, blockNumber: 123n })
    const call = pendingPaymentCall(review, ACCOUNT)
    expect(call).toMatchObject({ authority: ACCOUNT, target: GATEWAY, value: 0n, relayr: false, projectId: 17, id: pendingPaymentId(row) })
    const decoded = decodeFunctionData({ abi: routerGatewayAbi, data: call.data })
    expect(decoded).toEqual({ functionName: 'processPendingCall', args: [row.pendingCallId, tuple(row), row.memo, row.metadata] })
  })

  it('hides an indexed pending payment after its live commitment has cleared', async () => {
    live.commitment = zeroHash
    await expect(reviewPendingPayment(payment())).resolves.toBeNull()
    expect(mocks.symbol).not.toHaveBeenCalled()
  })

  it('rejects a live commitment that does not match the original call', async () => {
    live.commitment = ERROR
    await expect(reviewPendingPayment(payment())).rejects.toThrow('gateway commitment differs')
  })

  it('ends the cooldown at the chain timestamp, including the finalization threshold', async () => {
    live.failure = { errorHash: ERROR, count: 3, lastFailureAt: 20_000, highestGasLimit: 12_000_000n }
    live.timestamp = 106_399n
    const cooling = (await reviewPendingPayment(payment()))!
    expect(cooling).toMatchObject({ functionName: 'finalizePendingCall', readyAt: 106_400n, ready: false })
    expect(() => pendingPaymentCall(cooling, ACCOUNT)).toThrow('next retry time')
    live.timestamp = 106_400n
    const ready = (await reviewPendingPayment(payment()))!
    expect(ready.ready).toBe(true)
    expect(decodeFunctionData({ abi: routerGatewayAbi, data: pendingPaymentCall(ready, ACCOUNT).data }).functionName).toBe('finalizePendingCall')
  })

  it('uses retry below the failure threshold and respects the current block gas ceiling', async () => {
    live.failure = { errorHash: ERROR, count: 2, lastFailureAt: 1, highestGasLimit: 9_000_000n }
    live.gasLimit = 15_000_000n
    expect(await reviewPendingPayment(payment())).toMatchObject({ functionName: 'processPendingCall', ready: true, gas: 15_000_000n })
  })

  it('keeps unknown ERC20 precision unknown instead of assuming 18 decimals', async () => {
    const row = payment(1, { token: OTHER })
    live.commitment = row.callCommitment
    const read = mocks.client.readContract.getMockImplementation()!
    mocks.client.readContract.mockImplementation(async request => {
      if (request.functionName === 'decimals') throw new Error('Unknown token metadata')
      return read(request)
    })
    expect(await reviewPendingPayment(row)).toMatchObject({ decimals: null })
  })

  it.each([
    { errorHash: ERROR }, { count: 1 }, { lastFailureAt: 1 }, { highestGasLimit: 3_000_000n },
  ])('requires another review after live failure state changes: %o', async changes => {
    const call = pendingPaymentCall((await reviewPendingPayment(payment()))!, ACCOUNT)
    await expect(reverifyPendingPayment(call)).resolves.toBeUndefined()
    live.failure = { ...live.failure, ...changes }
    await expect(reverifyPendingPayment(call)).rejects.toThrow('changed since review')
  })

  it('rejects a resolved payment or a modified reviewed destination before submission', async () => {
    const call = pendingPaymentCall((await reviewPendingPayment(payment()))!, ACCOUNT)
    await expect(reverifyPendingPayment({ ...call, target: OTHER })).rejects.toThrow('changed since review')
    live.commitment = zeroHash
    await expect(reverifyPendingPayment(call)).rejects.toThrow('already resolved')
  })

  it('reconciles only demonstrably changed or resolved unsent attempts', async () => {
    const call = pendingPaymentCall((await reviewPendingPayment(payment()))!, ACCOUNT)
    await expect(reconcilePendingPayment(call)).resolves.toBeNull()
    live.failure = { ...live.failure, count: 1, errorHash: ERROR }
    await expect(reconcilePendingPayment(call)).resolves.toContain('Another attempt changed')
    live.commitment = zeroHash
    await expect(reconcilePendingPayment(call)).resolves.toContain('resolved through another transaction')
    live.commitment = ERROR
    await expect(reconcilePendingPayment(call)).rejects.toThrow('gateway commitment differs')
  })
})

describe('receipt proof of each pending payment outcome', () => {
  it.each([
    ['JBRouterTerminalGateway_ProcessPendingCall', 'routed'],
    ['JBRouterTerminalGateway_RefundPendingCall', 'returned'],
    ['JBRouterTerminalGateway_RecordTerminalCallFailure', 'pending'],
  ] as const)('recognizes %s without treating every confirmed attempt as settlement', async (name, outcome) => {
    const row = payment()
    const call = pendingPaymentCall((await reviewPendingPayment(row))!, ACCOUNT)
    const log = eventLog(name, row)
    expect(pendingPaymentOutcome(call, { logs: [log] })).toBe(outcome)
    expect(() => pendingPaymentOutcome(call, { logs: [{ ...log, address: OTHER }] })).toThrow('does not prove')
    expect(() => pendingPaymentOutcome(call, { logs: [eventLog(name, payment(2))] })).toThrow('does not prove')
  })

  it.each(['JBRouterTerminalGateway_ProcessPendingCall', 'JBRouterTerminalGateway_RefundPendingCall'])('rejects %s with the right ID but another call tuple', async name => {
    const row = payment()
    const call = pendingPaymentCall((await reviewPendingPayment(row))!, ACCOUNT)
    for (const changes of [{ amount: 1n }, { beneficiary: OTHER }, { refundTo: ACCOUNT }, { projectId: 2n }, { sourceProjectId: 18n }, { token: OTHER }]) {
      expect(() => pendingPaymentOutcome(call, { logs: [eventLog(name, row, { call: { ...tuple(row), ...changes } })] })).toThrow('does not prove')
    }
  })

  it('does not mistake an outer successful receipt or unrelated log for payment settlement', async () => {
    const call = pendingPaymentCall((await reviewPendingPayment(payment()))!, ACCOUNT)
    const receipt = { status: 'success', logs: [] as TransactionReceipt['logs'] }
    expect(() => pendingPaymentOutcome(call, receipt)).toThrow('does not prove')
    const unrelated = { ...eventLog('JBRouterTerminalGateway_ProcessPendingCall', payment()), topics: [ERROR] as [Hex], data: '0x' as Hex }
    expect(() => pendingPaymentOutcome(call, { logs: [unrelated] })).toThrow('does not prove')
  })
})
