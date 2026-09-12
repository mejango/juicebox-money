import { createElement, type ComponentProps } from 'react'
import { renderToString } from 'react-dom/server'
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer'
import { zeroHash, type Address } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReviewedPayment } from '@/lib/pending-payments'
import type { ProjectBatch, ProjectBatchCall } from '@/lib/project-batch'
import type { TxConfirmDialog } from '@/components/ui/TxConfirmDialog'

type Row = { payment: ReviewedPayment['payment']; review: ReviewedPayment | null; error: string | null }
const mocks = vi.hoisted(() => ({
  connected: true, address: '0x1111111111111111111111111111111111111111' as Address,
  rows: [] as Row[], error: null as Error | null,
  queryFn: null as (() => Promise<Row[]>) | null,
  openSignIn: vi.fn(), fetch: vi.fn(), review: vi.fn(), reverify: vi.fn(), reconcile: vi.fn(), outcome: vi.fn(),
  run: vi.fn(), load: vi.fn(), invalidate: vi.fn(), refetch: vi.fn(),
}))
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: mocks.invalidate }),
  useQuery: ({ queryFn }: { queryFn: () => Promise<Row[]> }) => {
    mocks.queryFn = queryFn
    return { data: mocks.rows, error: mocks.error, refetch: mocks.refetch }
  },
}))
vi.mock('@/hooks/useWallet', () => ({ useWallet: () => ({ address: mocks.address, isConnected: mocks.connected, openSignIn: mocks.openSignIn }) }))
vi.mock('@/components/ui/TxConfirmDialog', () => ({ TxConfirmDialog: (props: ComponentProps<typeof TxConfirmDialog>) => props.open ? createElement('review-dialog', props) : null }))
vi.mock('@/lib/pending-payments', () => ({
  fetchPendingPayments: mocks.fetch, reviewPendingPayment: mocks.review, reverifyPendingPayment: mocks.reverify,
  reconcilePendingPayment: mocks.reconcile, pendingPaymentOutcome: mocks.outcome,
  pendingPaymentId: (payment: ReviewedPayment['payment']) => `${payment.chainId}:${payment.gateway}:${payment.pendingCallId}`,
  pendingPaymentCall: (review: ReviewedPayment, account: Address) => ({
    id: `${review.payment.chainId}:${review.payment.gateway}:${review.payment.pendingCallId}`, chainId: review.payment.chainId,
    projectId: review.payment.sourceProjectId, authority: account, target: review.payment.gateway, value: 0n,
    data: '0x1234', label: 'Retry pending payment', context: review,
  }),
}))
vi.mock('@/lib/project-batch', () => ({
  projectBatchScope: (action: string, chainId: number, projectId: number) => `${action}:${chainId}:${projectId}`,
  loadProjectBatch: mocks.load, runProjectBatch: mocks.run,
}))

import { PendingPayments } from '@/components/project/PendingPayments'

function row(chainId: 1 | 10 = 1, ready = true): Row {
  const payment: ReviewedPayment['payment'] = { chainId, version: 6, gateway: '0x4a56aef5b6a5b9742abb02ca67c5a85ba183d901',
    pendingCallId: `0x${chainId.toString(16).padStart(64, '0')}`, projectId: 1, sourceProjectId: chainId === 1 ? 17 : 42,
    token: '0x000000000000000000000000000000000000EEEe', amount: '25000000000000000', retainedAmount: '25000000000000000',
    preferAddToBalance: false, shouldReturnHeldFees: false, beneficiary: mocks.address, refundTo: mocks.address,
    memo: '', metadata: '0x', callCommitment: zeroHash, status: 'queued' }
  return { payment, error: null, review: { payment, functionName: 'processPendingCall', ready, readyAt: ready ? 0n : 106_400n,
    failure: { count: 0, errorHash: zeroHash, lastFailureAt: 0, highestGasLimit: 0n }, decimals: 18, symbol: 'ETH', gas: 16_777_216n } }
}
let tree: TestRenderer.ReactTestRenderer | null
async function render(chains: [number, number][] = [[1, 17], [10, 42]]) {
  await act(async () => { tree = TestRenderer.create(createElement(PendingPayments, { chainId: 1, projectId: 17, chains })) })
  return tree!
}
const text = (node: ReactTestInstance): string => node.children.map(child => typeof child === 'string' ? child : text(child)).join('')
const button = (label: string) => tree!.root.findAllByType('button').find(item => text(item) === label)!
const dialog = () => tree!.root.findByType('review-dialog' as never).props as ComponentProps<typeof TxConfirmDialog>

beforeEach(() => {
  vi.resetAllMocks()
  mocks.connected = true; mocks.rows = []; mocks.error = null
  mocks.address = '0x1111111111111111111111111111111111111111'
  mocks.load.mockReturnValue(null)
  mocks.invalidate.mockResolvedValue(undefined)
  mocks.reconcile.mockResolvedValue(null)
  mocks.outcome.mockReturnValue('pending')
})
afterEach(async () => { if (tree) await act(async () => tree!.unmount()); tree = null })

describe('pending payment review above activity', () => {
  it('keeps persisted pending rows out of server markup until hydration', async () => {
    mocks.rows = [row()]
    expect(renderToString(createElement(PendingPayments, { chainId: 1, projectId: 17, chains: [] }))).toBe('')
    await render()
    expect(tree!.root.findByType('h2').children).toEqual(['Payments awaiting routing'])
  })

  it('hides an empty inventory and verifies every linked source project independently', async () => {
    await render()
    expect(tree!.toJSON()).toBeNull()
    const first = row(), second = row(10)
    mocks.fetch.mockImplementation(async (chain: number) => [chain === 1 ? first.payment : second.payment])
    mocks.review.mockImplementation(async (payment: ReviewedPayment['payment']) => payment.chainId === 1 ? null : second.review)
    expect(await mocks.queryFn!()).toEqual([second])
    expect(mocks.fetch.mock.calls).toEqual([[1, 17], [10, 42]])
    expect(mocks.review).toHaveBeenCalledTimes(2)
    expect(mocks.run).not.toHaveBeenCalled()
  })

  it('rejects conflicting peer IDs before loading a partial inventory', async () => {
    await render([[1, 99]])
    await expect(mocks.queryFn!()).rejects.toThrow('Conflicting project deployments')
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it('opens the standard transaction review for the complete batch and only submits on confirmation', async () => {
    mocks.rows = [row(), row(10)]
    await render()
    await act(async () => button('Batch all pending').props.onClick())
    expect(mocks.run).not.toHaveBeenCalled()
    expect(dialog().title).toBe('Review pending payments')
    expect(dialog().steps).toHaveLength(2)
    expect(dialog().stepsIntro).toContain('does not make them atomic')
    expect(dialog().rows?.filter(item => item.label === 'From project').map(item => item.value)).toEqual(['#17', '#42'])
    mocks.run.mockImplementation(async options => {
      expect(options.reverify).toBe(mocks.reverify)
      expect(options.calls).toHaveLength(2)
      for (const call of options.calls) {
        expect(await options.reconcileUnsubmitted(call)).toBe(false)
        await options.verifyCompletion(call, { status: 'success', logs: [] })
      }
      return { status: 'complete' }
    })
    await act(async () => dialog().onConfirm())
    expect(mocks.run).toHaveBeenCalledTimes(1)
    expect(dialog().complete).toBe(true)
    expect(dialog().rows?.filter(item => item.label === 'Outcome').map(item => item.value)).toEqual([
      'Attempt confirmed; payment is still awaiting routing.', 'Attempt confirmed; payment is still awaiting routing.',
    ])
    expect(mocks.invalidate).toHaveBeenCalledWith({ queryKey: ['pendingPayments'] })
  })

  it('allows an individual available payment while refusing an unverified batch', async () => {
    const failed = row(10)
    mocks.rows = [row(), { ...failed, review: null, error: 'Commitment could not be verified' }]
    await render()
    expect(button('Batch 1 available').props.disabled).toBe(true)
    const retries = tree!.root.findAllByType('button').filter(item => text(item) === 'Retry payment')
    expect(retries.map(item => item.props.disabled)).toEqual([false, true])
    await act(async () => retries[0].props.onClick())
    expect(dialog().steps).toHaveLength(1)
    expect(dialog().rows?.find(item => item.label === 'From project')?.value).toBe('#17')
  })

  it.each(['nonzero', 'unknown'])('keeps a known Safe proposal when its commitment is %s', async state => {
    mocks.rows = [row()]
    if (state === 'nonzero') mocks.review.mockResolvedValue(row().review)
    else mocks.review.mockRejectedValue(new Error('Commitment unavailable'))
    await render()
    await act(async () => button('Batch all pending').props.onClick())
    mocks.run.mockImplementation(async options => {
      expect(await options.reconcileObsoleteSafe(options.calls[0], { nonce: 3, safeTxHash: zeroHash })).toBe(false)
      return { status: 'pending' }
    })
    await act(async () => dialog().onConfirm())
    expect(dialog().complete).toBe(false)
    expect(dialog().rows?.some(item => item.label === 'Outcome')).toBe(false)
    if (state === 'unknown') expect(dialog().error).toBe('Commitment unavailable')
  })

  it('identifies an obsolete Safe proposal only after live resolution and retains cancellation guidance', async () => {
    mocks.rows = [row()]
    mocks.review.mockResolvedValue(null)
    await render()
    await act(async () => button('Batch all pending').props.onClick())
    mocks.run.mockImplementation(async options => {
      expect(await options.reconcileObsoleteSafe(options.calls[0], { nonce: 3, safeTxHash: zeroHash })).toBe(true)
      return { status: 'complete' }
    })
    await act(async () => dialog().onConfirm())
    expect(dialog().rows?.find(item => item.label === 'Outcome')?.value).toContain(`obsolete, not executed. Cancel nonce 3 in Safe`)
    expect(dialog().rows?.find(item => item.label === 'Outcome')?.value).toContain(zeroHash)
    expect(mocks.outcome).not.toHaveBeenCalled()
  })

  it('excludes cooling payments from the available batch and signs in before reviewing', async () => {
    mocks.rows = [row(), row(10, false)]
    mocks.connected = false
    await render()
    expect(button('Batch 1 available').props.disabled).toBe(false)
    const retries = tree!.root.findAllByType('button').filter(item => text(item) === 'Retry payment')
    expect(retries.map(item => item.props.disabled)).toEqual([false, true])
    await act(async () => button('Batch 1 available').props.onClick())
    expect(mocks.openSignIn).toHaveBeenCalledTimes(1)
    expect(tree!.root.findAllByType('review-dialog' as never)).toHaveLength(0)
    expect(mocks.run).not.toHaveBeenCalled()
  })

  it('resumes the immutable saved call set even when the refreshed inventory is empty', async () => {
    const reviewed = row().review!
    const calls = [{ id: 'saved-call', chainId: 1, projectId: 17, authority: mocks.address, target: reviewed.payment.gateway,
      value: 0n, data: '0x1234', context: reviewed }] as ProjectBatchCall[]
    const saved = { id: 'original-batch', calls, account: mocks.address, completedIds: [], status: 'pending' } as unknown as ProjectBatch
    mocks.load.mockReturnValue(saved)
    await render()
    await act(async () => button('Resume saved attempts').props.onClick())
    mocks.run.mockResolvedValue(saved)
    await act(async () => dialog().onConfirm())
    expect(mocks.run.mock.calls[0][0]).toMatchObject({ expectedBatchId: 'original-batch', calls })
    expect(dialog().complete).toBe(false)
    expect(dialog().status).toContain('original action is saved')
  })
})
