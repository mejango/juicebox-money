// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectReviewScope } from '@/providers/ProjectRouteContext'
import type { TransactionReviewDialogProps } from '@/components/TransactionReviewProvider'
const mocks = vi.hoisted(() => ({ scope: null as ProjectReviewScope | null, blocked: false }))
vi.mock('wagmi', () => ({ useAccount: () => ({ address: undefined }) }))
vi.mock('@/providers/ProjectRouteContext', () => ({ useProjectReviewScope: () => mocks.scope }))
vi.mock('@/providers/ProjectRouteBlockedContext', () => ({ useProjectRouteBlocked: () => mocks.blocked }))
vi.mock('@/components/TransactionReviewDialog', () => ({ TransactionReviewDialog: ({ pending, onFinish }: TransactionReviewDialogProps) => <div>
  <p>{pending.kind === 'review' ? pending.request.title : 'Funding'}</p>
  <button onClick={() => onFinish(pending.kind === 'review' ? true : 8453)}>Approve</button>
  <button onClick={() => onFinish(null)}>Cancel</button>
</div> }))
import { TransactionReviewProvider } from '@/components/TransactionReviewProvider'
import { requireFundingChainSelection, requireTransactionReview } from '@/lib/transaction-review'
let root: Root
let host: HTMLDivElement
beforeEach(async () => {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  mocks.scope = { identity: 'base:7:operator', verify: vi.fn(async () => true) }
  mocks.blocked = false
  await act(async () => root.render(<TransactionReviewProvider>App</TransactionReviewProvider>))
})
afterEach(async () => { await act(async () => root.unmount()); host.remove() })
const click = async (text: string) => act(async () => { [...host.querySelectorAll('button')].find(button => button.textContent === text)!.click() })
async function request(title = 'Review') {
  let promise!: Promise<unknown>
  await act(async () => { promise = requireTransactionReview({ title, calls: [{ chainId: 8453, to: `0x${'12'.repeat(20)}`, data: '0x' }] }).then(() => true, error => error) })
  await act(async () => { await vi.dynamicImportSettled() })
  return { promise }
}

describe('project identity captured by the global review owner', () => {
  it('rejects late preparation during a blocked project instead of opening an unscoped review', async () => {
    mocks.scope = null
    mocks.blocked = true
    await act(async () => root.render(<TransactionReviewProvider>App</TransactionReviewProvider>))
    const { promise } = await request('Late old-project preparation')
    expect(await promise).toBeInstanceOf(Error)
    mocks.scope = { identity: 'base:8:operator', verify: vi.fn(async () => true) }
    mocks.blocked = false
    await act(async () => root.render(<TransactionReviewProvider>App</TransactionReviewProvider>))
    expect(host.textContent).not.toContain('Approve')
  })
  it('allows a slow review after awaiting an unchanged-identity check', async () => {
    vi.useFakeTimers()
    const { promise } = await request()
    await act(async () => vi.advanceTimersByTime(20_000))
    let resolve!: (same: boolean) => void
    vi.mocked(mocks.scope!.verify).mockImplementation(() => new Promise(finish => { resolve = finish }))
    await click('Approve')
    expect(host.textContent).toContain('Review')
    await act(async () => resolve(true))
    expect(await promise).toBe(true)
  })
  it('declines active and queued funding when binding changes during verification', async () => {
    const { promise } = await request()
    let funding!: Promise<unknown>
    await act(async () => { funding = requireFundingChainSelection([{ chainId: 8453, label: 'Base' }]).catch(error => error) })
    let resolve!: (same: boolean) => void
    vi.mocked(mocks.scope!.verify).mockImplementation(() => new Promise(finish => { resolve = finish }))
    await click('Approve')
    mocks.scope = { identity: 'base:8:operator', verify: vi.fn(async () => true) }
    await act(async () => root.render(<TransactionReviewProvider>App</TransactionReviewProvider>))
    await act(async () => resolve(true))
    expect(await promise).toMatchObject({ message: 'Review closed. Nothing was sent.' })
    expect(await funding).toBeInstanceOf(Error)
    expect(host.textContent).not.toContain('Approve')
  })
  it('cannot approve a canceled dialog or the next dialog when its late verification resolves', async () => {
    const first = await request('First')
    const second = await request('Second')
    let resolve!: (same: boolean) => void
    vi.mocked(mocks.scope!.verify).mockImplementation(() => new Promise(finish => { resolve = finish }))
    await click('Approve')
    await click('Cancel')
    expect(await first.promise).toBeInstanceOf(Error)
    await act(async () => resolve(true))
    expect(host.textContent).toContain('Second')
    await click('Cancel')
    expect(await second.promise).toBeInstanceOf(Error)
  })
})
