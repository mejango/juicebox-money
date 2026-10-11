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
  rows: [] as Row[], error: null as Error | null, checking: false, loading: false, verificationError: null as Error | null,
  verifyFn: null as (() => Promise<Row[]>) | null,
  queryFn: null as ((context: { signal: AbortSignal }) => Promise<ReviewedPayment['payment'][]>) | null,
  /** The inventory query's own, which react-query aborts once no page shows it. */
  query: new AbortController(),
  names: [] as { chainId: number; projectId: number; version: number; name: string | null }[], namesFn: null as ((context: { signal: AbortSignal }) => Promise<unknown>) | null, projects: vi.fn(),
  openSignIn: vi.fn(), fetch: vi.fn(), review: vi.fn(), reverify: vi.fn(), reconcile: vi.fn(), outcome: vi.fn(),
  recheckBatch: vi.fn(), run: vi.fn(), draft: vi.fn(), load: vi.fn(), loadExact: vi.fn(), invalidate: vi.fn(), refetch: vi.fn(), discard: vi.fn(),
}))
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: mocks.invalidate }),
  useQuery: ({ queryKey, queryFn }: { queryKey: string[]; queryFn: (context: { signal: AbortSignal }) => Promise<unknown> }) => {
    if (queryKey[0] === 'pendingPaymentProjectNames') {
      mocks.namesFn = queryFn as unknown as typeof mocks.namesFn
      return { data: mocks.names }
    }
    if (queryKey[1] === 'verification') {
      mocks.verifyFn = queryFn as unknown as typeof mocks.verifyFn
      return { data: mocks.checking ? undefined : mocks.rows, error: mocks.verificationError }
    }
    mocks.queryFn = queryFn as typeof mocks.queryFn
    return { data: mocks.loading ? undefined : mocks.rows.map(item => item.payment), error: mocks.error, isPending: mocks.loading, refetch: mocks.refetch }
  },
}))
vi.mock('@/lib/bendystraw', () => ({ getProjectsByRefs: mocks.projects }))
vi.mock('@/lib/project-metadata-fill', () => ({ fillIndexedMetadata: async (rows: unknown) => rows }))
vi.mock('@/components/ui/LoadingText', () => ({ LoadingText: ({ text }: { text: string }) => text }))
vi.mock('@/hooks/useWallet', () => ({ useWallet: () => ({ address: mocks.address, isConnected: mocks.connected, openSignIn: mocks.openSignIn }) }))
vi.mock('@/components/ui/TxConfirmDialog', () => ({ TxConfirmDialog: (props: ComponentProps<typeof TxConfirmDialog>) => props.open ? createElement('review-dialog', props) : null }))
vi.mock('@/lib/pending-payments', () => ({
  PENDING_PAYMENT_ACTION: 'route-destination-payments',
  loadPendingPaymentBatch: mocks.load,
  fetchPendingPayments: mocks.fetch, reviewPendingPayment: mocks.review, reverifyPendingPayment: mocks.reverify,
  reconcilePendingPayment: mocks.reconcile, pendingPaymentOutcome: mocks.outcome,
  pendingPaymentId: (payment: ReviewedPayment['payment']) => `${payment.chainId}:${payment.gateway}:${payment.pendingCallId}`,
  pendingPaymentCall: (review: ReviewedPayment, account: Address) => ({
    id: `${review.payment.chainId}:${review.payment.gateway}:${review.payment.pendingCallId}`, chainId: review.payment.chainId,
    projectId: review.payment.projectId, authority: account, target: review.payment.gateway, value: 0n,
    data: '0x1234', label: 'Retry pending payment', context: review,
  }),
}))
vi.mock('@/lib/relayr', async original => ({ ...await original<typeof import('@/lib/relayr')>(), discardRelayrSession: mocks.discard }))
vi.mock('@/lib/project-batch', () => ({
  projectBatchScope: (action: string, chainId: number, projectId: number) => `${action}:${chainId}:${projectId}`,
  runProjectBatch: mocks.run,
  loadProjectBatch: mocks.loadExact,
  isProjectBatchDraft: mocks.draft,
  projectBatchRecoveryReason: () => 'A saved attempt needs recovery.',
  recheckProjectBatch: mocks.recheckBatch,
}))

import { PendingPayments } from '@/components/project/PendingPayments'
import { RelayrDiscard } from '@/components/RelayrDiscard'
import { RelayrDiscardError } from '@/lib/relayr'

function row(chainId: 1 | 10 = 1, ready = true): Row {
  const payment: ReviewedPayment['payment'] = { chainId, version: 6, gateway: '0x4a56aef5b6a5b9742abb02ca67c5a85ba183d901',
    pendingCallId: `0x${chainId.toString(16).padStart(64, '0')}`, projectId: chainId === 1 ? 17 : 42, sourceProjectId: 6,
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
  mocks.connected = true; mocks.rows = []; mocks.names = []; mocks.projects.mockResolvedValue([]); mocks.error = null; mocks.checking = false; mocks.loading = false; mocks.verificationError = null
  mocks.address = '0x1111111111111111111111111111111111111111'
  mocks.load.mockReturnValue(null)
  mocks.loadExact.mockReturnValue(null)
  mocks.invalidate.mockResolvedValue(undefined)
  mocks.reconcile.mockResolvedValue(null)
  mocks.outcome.mockReturnValue('pending')
})
afterEach(async () => { if (tree) await act(async () => tree!.unmount()); tree = null })

describe('pending payment review above activity', () => {
  it.each([
    ['pending', false], ['uncertain', false], ['pending', true], ['uncertain', true],
  ] as const)('resumes the exact saved batch after %s submission (replacement: %s)', async (outcome, replacement) => {
    mocks.rows = [row()]
    if (replacement) {
      mocks.load.mockReturnValue({ id: 'draft', scope: 'legacy', calls: [], completedIds: [] })
      mocks.draft.mockReturnValue(true)
    }
    await render()
    await act(async () => button('Retry').props.onClick())
    mocks.run.mockImplementationOnce(async options => {
      const saved = { id: 'submitted', scope: options.scope, action: options.action, account: mocks.address,
        calls: options.calls, completedIds: [], status: 'pending' } as unknown as ProjectBatch
      mocks.loadExact.mockReturnValue(saved)
      mocks.draft.mockReturnValue(false)
      // Destination inventory can discover another journal; recover this submitted scope.
      mocks.load.mockReturnValue({ ...saved, id: 'other', scope: 'other-scope' })
      if (outcome === 'uncertain') throw new Error('Payment was submitted; confirmation unavailable. Do not pay again.')
      return saved
    })
    await act(async () => dialog().onConfirm())
    expect(dialog().action).toBe('Resume saved batch')
    expect(dialog().complete).toBe(false)
    expect(dialog().actionDisabled).toBe(false)
    if (outcome === 'uncertain') expect(dialog().error).toContain('Do not pay again')
    mocks.run.mockResolvedValue({ status: 'complete' })
    await act(async () => dialog().onConfirm())
    expect(mocks.run.mock.calls[1][0]).toMatchObject({ scope: 'route-destination-payments:1:17', expectedBatchId: 'submitted' })
    expect(mocks.run.mock.calls[1][0].replaceDraft).toBeUndefined()
  })

  it('reviews the full live inventory instead of an untouched saved subset', async () => {
    mocks.rows = [row(), row(10)]
    const saved = { id: 'draft', scope: 'route-pending-payments:1:6', action: 'route-pending-payments',
      calls: [{ context: mocks.rows[0].review }], completedIds: [], account: mocks.address } as unknown as ProjectBatch
    mocks.load.mockReturnValue(saved)
    mocks.draft.mockReturnValue(true)
    await render()
    expect(button('Resume saved batch')).toBeUndefined()
    await act(async () => button('Retry').props.onClick())
    expect(dialog().steps).toHaveLength(2)
    expect(dialog().action).toBe('Retry')
    mocks.run.mockResolvedValue({ ...saved, status: 'complete' })
    await act(async () => dialog().onConfirm())
    expect(mocks.run).toHaveBeenCalledWith(expect.objectContaining({
      scope: 'route-destination-payments:1:17', action: 'route-destination-payments',
      expectedBatchId: undefined, replaceDraft: { id: 'draft', scope: saved.scope },
      calls: expect.arrayContaining([expect.objectContaining({ chainId: 1 }), expect.objectContaining({ chainId: 10 })]),
    }))
  })

  it('requires a new review after a replacement fails rather than resubmitting its consumed token', async () => {
    mocks.rows = [row()]
    mocks.load.mockReturnValue({ id: 'draft', scope: 'legacy', calls: [], completedIds: [] })
    mocks.draft.mockReturnValue(true)
    await render()
    await act(async () => button('Retry').props.onClick())
    mocks.run.mockRejectedValue(new Error('preflight failed'))
    await act(async () => dialog().onConfirm())
    expect(dialog().actionDisabled).toBe(true)
    expect(dialog().status).toContain('reopen pending payments')
    await act(async () => dialog().onConfirm())
    expect(mocks.run).toHaveBeenCalledTimes(1)
    await act(async () => dialog().onClose())
    mocks.load.mockReturnValue(null)
    await act(async () => button('Retry').props.onClick())
    expect(dialog().actionDisabled).toBe(false)
    await act(async () => dialog().onConfirm())
    expect(mocks.run.mock.calls[1][0].replaceDraft).toBeUndefined()
  })
  it('keeps the reviewed recovery identity despite live progress discovering another journal', async () => {
    mocks.rows = [row()]
    const saved = { id: 'original', scope: 'legacy', action: 'route-pending-payments', account: mocks.address,
      calls: [{ id: 'call', chainId: 1, context: mocks.rows[0].review }], completedIds: [], status: 'pending' }
    mocks.load.mockReturnValue(saved)
    await render()
    await act(async () => button('Resume saved batch').props.onClick())
    mocks.run.mockImplementation(async options => {
      mocks.load.mockReturnValue({ ...saved, id: 'different', scope: 'different' })
      options.onProgress({ message: 'checking' })
      throw new Error('wait again')
    })
    await act(async () => dialog().onConfirm())
    await act(async () => dialog().onConfirm())
    expect(mocks.run.mock.calls[1][0]).toMatchObject({ scope: 'legacy', expectedBatchId: 'original' })
  })
  it('rechecks saved recovery without starting a payment and then offers the full live batch', async () => {
    mocks.rows = [row(), row(10)]
    mocks.load.mockReturnValue({ id: 'saved', scope: 'legacy', calls: [], completedIds: [] })
    await render()
    mocks.recheckBatch.mockImplementation(async () => { mocks.load.mockReturnValue(null); return true })
    await act(async () => button('Re-check saved batch').props.onClick())
    expect(mocks.recheckBatch).toHaveBeenCalledWith('legacy', 'saved')
    expect(button('Retry')).toBeDefined()
    expect(mocks.run).not.toHaveBeenCalled()
  })
  it('keeps persisted pending rows out of server markup until hydration', async () => {
    mocks.rows = [row()]
    expect(renderToString(createElement(PendingPayments, { chainId: 1, projectId: 17, chains: [] }))).toBe('')
    await render()
    expect(text(tree!.root.findByType('summary'))).toBe('1 payment awaiting processing.')
    expect(tree!.root.findByType('details').props.open).toBeUndefined()
    expect(tree!.root.findAllByType('button').filter(item => text(item) === 'Retry')).toHaveLength(1)
  })

  it('keeps raw amounts hidden until token metadata is checked', async () => {
    mocks.rows = [row()]
    mocks.checking = true
    await render()
    expect(text(tree!.root)).toContain('Checking payment amount…')
    expect(text(tree!.root)).not.toContain(mocks.rows[0].payment.amount)
    expect(text(tree!.root)).not.toContain('base units')
    mocks.checking = false
    mocks.rows[0].review!.decimals = null
    await render()
    expect(text(tree!.root)).toContain('Amount unavailable')
    expect(text(tree!.root)).not.toContain('base units')
  })

  it('resolves exact source and destination names for live and saved reviews', async () => {
    mocks.rows = [row(), row(10)]
    mocks.names = [
      { chainId: 1, projectId: 6, version: 6, name: 'Source' },
      { chainId: 1, projectId: 17, version: 6, name: 'Destination' },
      { chainId: 10, projectId: 6, version: 5, name: 'Wrong version' },
      { chainId: 10, projectId: 42, version: 6, name: 'Other destination' },
    ]
    await render()
    expect(text(tree!.root)).toContain('To Destination on Ethereum')
    await mocks.namesFn!({ signal: new AbortController().signal })
    expect(mocks.projects).toHaveBeenCalledWith([
      { chainId: 1, projectId: 6, version: 6 }, { chainId: 1, projectId: 17, version: 6 },
      { chainId: 10, projectId: 6, version: 6 }, { chainId: 10, projectId: 42, version: 6 },
    ], { signal: expect.any(AbortSignal) })
    await act(async () => button('Retry').props.onClick())
    expect(dialog().rows?.filter(item => item.label === 'Source').map(item => item.value)).toEqual(['Source', 'Project 6'])
    expect(dialog().rows?.filter(item => item.label === 'To').map(item => item.value)).toEqual(['Destination', 'Other destination'])
    expect(dialog().rows?.filter(item => item.label === 'Action').map(item => item.value)).toEqual(['Retry payments', 'Retry payments'])
    expect(dialog().rows?.some(item => item.label === 'Gateway')).toBe(false)
  })

  it('hides an empty inventory and verifies every linked destination project independently', async () => {
    await render()
    expect(tree!.toJSON()).toBeNull()
    const first = row(), second = row(10)
    mocks.fetch.mockImplementation(async (chain: number) => [chain === 1 ? first.payment : second.payment])
    mocks.review.mockImplementation(async (payment: ReviewedPayment['payment']) => payment.chainId === 1 ? null : second.review)
    expect(await mocks.queryFn!({ signal: mocks.query.signal })).toEqual([first.payment, second.payment])
    mocks.rows = [first, second]
    await render()
    expect(await mocks.verifyFn!()).toEqual([{ ...first, review: null }, second])
    // Each chain's indexed read takes the query's signal.
    expect(mocks.fetch.mock.calls).toEqual([[1, 17, { signal: mocks.query.signal }], [10, 42, { signal: mocks.query.signal }]])
    expect(mocks.review).toHaveBeenCalledTimes(2)
    expect(mocks.run).not.toHaveBeenCalled()
  })

  it('shows the complete inventory while checking, separately from a saved three-payment selection', async () => {
    mocks.rows = Array.from({ length: 7 }, (_, index) => {
      const item = row()
      item.payment.pendingCallId = `0x${(index + 1).toString(16).padStart(64, '0')}`
      return item
    })
    mocks.checking = true
    mocks.load.mockReturnValue({ calls: [{}, {}, {}], completedIds: [], status: 'pending' })
    await render()
    expect(tree!.root.findAllByType('li')).toHaveLength(7)
    expect(text(tree!.root)).toContain('7 payments awaiting processing.')
    expect(text(tree!.root)).toContain('Saved batch: 0 of 3 attempts handled')
    expect(button('Resume saved batch').props.disabled).toBe(false)
    expect(tree!.root.findAllByType('li').flatMap(item => item.findAllByType('button')).every(item => item.props.disabled)).toBe(true)
    expect(text(tree!.root)).toContain('Checking payment status')
  })

  it('keeps discovered rows visible and prevents submitting when live verification fails', async () => {
    mocks.rows = [row(), row(10)]
    mocks.checking = true
    mocks.verificationError = new Error('RPC unavailable')
    await render()
    expect(tree!.root.findAllByType('li')).toHaveLength(2)
    expect(text(tree!.root)).toContain('Could not check this payment.')
    expect(text(tree!.root)).not.toContain('Checking payment status')
    expect(button('Retry').props.disabled).toBe(true)
    await act(async () => button('Retry checks').props.onClick())
    expect(mocks.invalidate).toHaveBeenCalledWith({ queryKey: ['pendingPayments'] })
    expect(mocks.run).not.toHaveBeenCalled()
  })

  it('shows loading before discovering any payments, including beside saved recovery', async () => {
    mocks.loading = true
    await render()
    expect(text(tree!.root)).toContain('Loading pending payments')
    mocks.load.mockReturnValue({ calls: [{}, {}, {}], completedIds: [], status: 'pending' })
    await render()
    expect(text(tree!.root)).toContain('Loading pending payments')
    expect(text(tree!.root)).not.toContain('0 payments awaiting routing')
  })

  it('finishes discovery independently and starts all live checks without waiting for responses', async () => {
    mocks.rows = Array.from({ length: 3 }, (_, index) => {
      const item = row()
      item.payment.pendingCallId = `0x${(index + 1).toString(16).padStart(64, '0')}`
      return item
    })
    mocks.checking = true
    mocks.fetch.mockResolvedValue(mocks.rows.map(item => item.payment))
    const releases: (() => void)[] = []
    mocks.review.mockImplementation((payment: ReviewedPayment['payment']) => new Promise(resolve => {
      releases.push(() => resolve({ ...row().review!, payment }))
    }))
    await render([])
    expect(await mocks.queryFn!({ signal: mocks.query.signal })).toHaveLength(3)
    expect(mocks.review).not.toHaveBeenCalled()
    const checking = mocks.verifyFn!()
    expect(mocks.review).toHaveBeenCalledTimes(3)
    expect(tree!.root.findAllByType('li')).toHaveLength(3)
    releases[0]()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(mocks.review).toHaveBeenCalledTimes(3)
    releases[1](); releases[2]()
    expect(await checking).toHaveLength(3)
    expect(mocks.run).not.toHaveBeenCalled()
  })

  it('rejects conflicting peer IDs before loading a partial inventory', async () => {
    await render([[1, 99]])
    await expect(mocks.queryFn!({ signal: mocks.query.signal })).rejects.toThrow('Conflicting project deployments')
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it('opens the standard transaction review for the complete batch and only submits on confirmation', async () => {
    mocks.rows = [row(), row(10)]
    await render()
    await act(async () => button('Retry').props.onClick())
    expect(mocks.run).not.toHaveBeenCalled()
    expect(dialog().title).toBe('Retry payments')
    expect(dialog().steps).toHaveLength(2)
    expect(dialog().stepsIntro).toContain('network fees only')
    expect(dialog().stepsIntro).toContain('may remain pending')
    expect(dialog().stepsIntro).toContain('return them to the source project')
    expect(dialog().rows?.filter(item => item.label === 'Source').map(item => item.value)).toEqual(['Project 6', 'Project 6'])
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
    expect(mocks.run.mock.calls[0][0]).toMatchObject({ action: 'route-destination-payments', scope: 'route-destination-payments:1:17' })
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
    expect(button('Retry').props.disabled).toBe(true)
    const retries = tree!.root.findAllByType('li').flatMap(item => item.findAllByType('button'))
    expect(retries.map(item => item.props.disabled)).toEqual([false, true])
    await act(async () => retries[0].props.onClick())
    expect(dialog().steps).toHaveLength(1)
    expect(dialog().rows?.find(item => item.label === 'Source')?.value).toBe('Project 6')
  })

  it.each(['nonzero', 'unknown'])('keeps a known Safe proposal when its commitment is %s', async state => {
    mocks.rows = [row()]
    if (state === 'nonzero') mocks.review.mockResolvedValue(row().review)
    else mocks.review.mockRejectedValue(new Error('Commitment unavailable'))
    await render()
    await act(async () => button('Retry').props.onClick())
    mocks.run.mockImplementation(async options => {
      expect(await options.reconcileObsoleteSafe(options.calls[0], { nonce: 3, safeTxHash: zeroHash })).toBe(false)
      return { status: 'pending', calls: options.calls, completedIds: [] }
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
    await act(async () => button('Retry').props.onClick())
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
    expect(button('Retry').props.disabled).toBe(false)
    const retries = tree!.root.findAllByType('li').flatMap(item => item.findAllByType('button'))
    expect(retries.map(item => item.props.disabled)).toEqual([false, true])
    await act(async () => button('Retry').props.onClick())
    expect(mocks.openSignIn).toHaveBeenCalledTimes(1)
    expect(tree!.root.findAllByType('review-dialog' as never)).toHaveLength(0)
    expect(mocks.run).not.toHaveBeenCalled()
  })

  it('shows the line and Discard in place of the error when its Relayr round can only be discarded', async () => {
    mocks.rows = [row(), row(10)]
    await render()
    await act(async () => button('Retry').props.onClick())
    mocks.run.mockRejectedValue(new RelayrDiscardError('project-batch:saved:0', 'changed'))
    await act(async () => dialog().onConfirm())
    expect(dialog().error).toBeNull()
    expect(dialog().actionDisabled).toBe(true)
    const discard = tree!.root.findByType(RelayrDiscard)
    expect(discard.props).toMatchObject({ scope: 'project-batch:saved:0', reason: 'changed' })
    expect(text(discard)).toContain('The project changed since this review.')
    mocks.discard.mockImplementation(async () => { mocks.load.mockReturnValue(null) })
    await act(async () => button('Discard').props.onClick())
    expect(mocks.discard).toHaveBeenCalledWith('project-batch:saved:0')
    expect(tree!.root.findAllByType(RelayrDiscard)).toHaveLength(0)
    // Discard abandons the saved batch and closes its review: a fresh one sends again (ruling R114 (f)).
    expect(tree!.root.findAllByType('review-dialog' as never)).toHaveLength(0)
  })

  it('drops the line with its review when the review closes, so it never shows without Discard', async () => {
    mocks.rows = [row(), row(10)]
    await render()
    await act(async () => button('Retry').props.onClick())
    mocks.run.mockRejectedValue(new RelayrDiscardError('project-batch:saved:0', 'ran'))
    await act(async () => dialog().onConfirm())
    expect(tree!.root.findAllByType(RelayrDiscard)).toHaveLength(1)
    await act(async () => dialog().onClose())
    expect(text(tree!.root)).not.toContain('may already have run')
  })

  it('resumes the immutable saved call set even when the refreshed inventory is empty', async () => {
    const reviewed = row().review!
    const calls = [{ id: 'saved-call', chainId: 1, projectId: 17, authority: mocks.address, target: reviewed.payment.gateway,
      value: 0n, data: '0x1234', context: reviewed }] as ProjectBatchCall[]
    const saved = { id: 'original-batch', scope: 'route-pending-payments:1:6', action: 'route-pending-payments', calls, account: mocks.address, completedIds: [], status: 'pending' } as unknown as ProjectBatch
    mocks.load.mockReturnValue(saved)
    mocks.names = [{ chainId: 1, projectId: 6, version: 6, name: 'Saved source' }, { chainId: 1, projectId: 17, version: 6, name: 'Saved destination' }]
    await render()
    expect(text(tree!.root.findByType('summary'))).toBe('Saved payment batch')
    await act(async () => button('Resume saved batch').props.onClick())
    await mocks.namesFn!({ signal: new AbortController().signal })
    expect(mocks.projects).toHaveBeenCalledWith([{ chainId: 1, projectId: 6, version: 6 }, { chainId: 1, projectId: 17, version: 6 }], { signal: expect.any(AbortSignal) })
    expect(dialog().rows?.find(item => item.label === 'Source')?.value).toBe('Saved source')
    expect(dialog().rows?.find(item => item.label === 'To')?.value).toBe('Saved destination')
    mocks.run.mockResolvedValue(saved)
    await act(async () => dialog().onConfirm())
    expect(mocks.run.mock.calls[0][0]).toMatchObject({ scope: 'route-pending-payments:1:6', action: 'route-pending-payments', expectedBatchId: 'original-batch', calls })
    expect(mocks.load).toHaveBeenCalledWith(expect.arrayContaining([[1, 17], [10, 42]]))
    expect(dialog().complete).toBe(false)
    expect(dialog().status).toContain('original action is saved')
  })
})
