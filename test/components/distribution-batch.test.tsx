import { JBCoreContracts, USDC_ADDRESSES, jbContractAddress, type JBChainId } from '@bananapus/nana-sdk-core'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { zeroAddress, type Address } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  wallet: { address: '0x1111111111111111111111111111111111111111', isConnected: true, openSignIn: vi.fn() },
  load: vi.fn(), run: vi.fn(), payout: vi.fn(), reserved: vi.fn(), reverify: vi.fn(), options: [] as unknown[], invalidate: vi.fn(),
}))
vi.mock('@/hooks/useWallet', () => ({ useWallet: () => mocks.wallet }))
vi.mock('@tanstack/react-query', () => ({ useQuery: () => ({ data: mocks.options, isLoading: false }), useQueryClient: () => ({ invalidateQueries: mocks.invalidate }) }))
vi.mock('@/lib/project-batch', () => ({ loadProjectBatch: mocks.load, runProjectBatch: mocks.run, projectBatchScope: (action: string, chain: number, project: number) => `${action}:${chain}:${project}` }))
vi.mock('@/lib/project-distributions', async original => ({ ...await original<typeof import('@/lib/project-distributions')>(), reviewPayout: mocks.payout, reviewReserved: mocks.reserved, reverifyDistribution: mocks.reverify }))
vi.mock('@/components/ui/TxConfirmDialog', () => ({ TxConfirmDialog: (props: { title: string; rows: { label: string; value: string }[]; error: string | null; onConfirm: () => void }) => <div><span>{props.title}</span>{props.rows.map((row, index) => <p key={index}>{row.label}: {row.value}</p>)}{props.error}<button onClick={props.onConfirm}>Confirm test distributions</button></div> }))

import { DistributionBatchFlow, distributionBatchCalls } from '@/components/project/DistributionBatchFlow'
import type { Distribution, PayoutDistribution, ReservedDistribution } from '@/lib/project-distributions'

const ACCOUNT = mocks.wallet.address as Address
const OTHER = '0x2222222222222222222222222222222222222222' as Address
const CHAINS = [[1, 17], [8453, 303]] as const
const renderers: ReactTestRenderer[] = []
function reserved(chain: JBChainId): ReservedDistribution {
  return { kind: 'reserved', chainId: chain, projectId: chain === 1 ? 17 : 303, owner: ACCOUNT, authority: ACCOUNT,
    controller: jbContractAddress['6'][JBCoreContracts.JBController][chain], symbol: chain === 1 ? 'AAA' : 'BBB',
    current: { ruleset: { id: chain === 1 ? 51 : 79 }, metadata: {} } as ReservedDistribution['current'],
    pending: BigInt(chain === 1 ? 100 : 200) * 10n ** 18n,
    splits: [{ percent: 500_000_000, projectId: 0n, beneficiary: OTHER, lockedUntil: 0, hook: zeroAddress, preferAddToBalance: false }] }
}
function payout(chain: JBChainId): PayoutDistribution {
  return { ...reserved(chain), kind: 'payouts', terminal: jbContractAddress['6'][JBCoreContracts.JBMultiTerminal][chain], symbol: 'USDC',
    context: { token: USDC_ADDRESSES[chain], decimals: 6, currency: 2, symbol: 'USDC', balance: 50_000_000n, limits: [{ amount: 100_000_000n, currency: 2, used: 0n, remaining: 100_000_000n }] },
    amount: 12_000_000n, currency: 2, quote: 12_000_000n, min: 12_000_000n, hookFeeless: {} }
}
const text = (renderer: ReactTestRenderer) => JSON.stringify(renderer.toJSON())
async function mount(kind: 'payouts' | 'reserved') {
  mocks.options = mocks.options.map(value => {
    const option = value as { payout: unknown; reserved: unknown }
    return { ...option, payout: kind === 'payouts' ? option.payout : null, reserved: kind === 'reserved' ? option.reserved : null }
  })
  let renderer!: ReactTestRenderer
  await act(async () => { renderer = create(<DistributionBatchFlow kind={kind} chainId={1} projectId={17} chains={CHAINS} homeToken={USDC_ADDRESSES[1]} />) })
  renderers.push(renderer)
  return renderer
}
async function click(renderer: ReactTestRenderer, label: string) {
  const button = renderer.root.findAllByType('button').find(item => item.children.join('') === label)
  expect(button, label).toBeDefined()
  await act(async () => { await button!.props.onClick() })
}
beforeEach(() => {
  mocks.wallet.address = ACCOUNT
  mocks.load.mockReturnValue(null)
  mocks.run.mockResolvedValue({ status: 'complete', calls: [], completedIds: [] })
  mocks.reverify.mockResolvedValue(undefined)
  mocks.reserved.mockImplementation(async ({ chainId }) => reserved(chainId))
  mocks.payout.mockImplementation(async ({ chainId }, _token, amount) => ({ ...payout(chainId), amount }))
  mocks.options = CHAINS.map(([chainId, projectId]) => ({ project: { chainId, projectId }, payout: { chainId, projectId, terminal: payout(chainId).terminal, contexts: [payout(chainId).context] }, reserved: reserved(chainId), error: null }))
})
afterEach(async () => { for (const renderer of renderers.splice(0)) await act(async () => renderer.unmount()) })

describe('distribution batch reviews and recovery', () => {
  it('rejects excess token precision instead of rounding the reviewed payout', async () => {
    const renderer = await mount('payouts')
    await click(renderer, 'Distribute payouts')
    await act(async () => renderer.root.findByProps({ 'aria-label': 'Payout amount on Ethereum' }).props.onChange({ target: { value: '1.0000009' } }))
    await click(renderer, 'Review selected distributions')
    expect(text(renderer)).toContain('at most 6 decimal places')
    expect(mocks.payout).not.toHaveBeenCalled()
    expect(mocks.run).not.toHaveBeenCalled()
  })

  it('allows an unavailable home destination to be deselected so a funded peer can run alone', async () => {
    mocks.options[0] = { project: { chainId: 1, projectId: 17 }, payout: null, reserved: null, error: 'No pending tokens' }
    const renderer = await mount('reserved')
    await click(renderer, 'Distribute reserved tokens')
    const boxes = renderer.root.findAllByType('input').filter(item => item.props.type === 'checkbox')
    expect(boxes[0].props.disabled).toBe(false)
    await act(async () => boxes[0].props.onChange())
    await act(async () => boxes[1].props.onChange())
    await click(renderer, 'Review selected distributions')
    expect(mocks.reserved).toHaveBeenCalledExactlyOnceWith({ chainId: 8453, projectId: 303 }, ACCOUNT)
  })

  it('collects each selected payout amount in that accounting token’s decimals and freezes perchain calls', async () => {
    const renderer = await mount('payouts')
    await click(renderer, 'Distribute payouts')
    await act(async () => renderer.root.findAllByType('input').filter(item => item.props.type === 'checkbox')[1].props.onChange())
    for (const [label, value] of [['Payout amount on Ethereum', '12.34'], ['Payout amount on Base', '7.89']]) {
      await act(async () => renderer.root.findByProps({ 'aria-label': label }).props.onChange({ target: { value } }))
    }
    await click(renderer, 'Review selected distributions')
    expect(mocks.payout).toHaveBeenCalledWith({ chainId: 1, projectId: 17 }, USDC_ADDRESSES[1], 12_340_000n, 2, ACCOUNT)
    expect(mocks.payout).toHaveBeenCalledWith({ chainId: 8453, projectId: 303 }, USDC_ADDRESSES[8453], 7_890_000n, 2, ACCOUNT)
    await click(renderer, 'Confirm test distributions')
    const sent = mocks.run.mock.calls[0][0].calls
    expect(sent.map((call: { projectId: number }) => call.projectId)).toEqual([17, 303])
    expect(sent.map((call: { context: PayoutDistribution }) => call.context.amount)).toEqual([12_340_000n, 7_890_000n])
  })

  it('reviews selected reserved balances/recipients and rejects a wallet swap before any submission', async () => {
    const renderer = await mount('reserved')
    await click(renderer, 'Distribute reserved tokens')
    await act(async () => renderer.root.findAllByType('input')[1].props.onChange())
    await click(renderer, 'Review selected distributions')
    expect(text(renderer)).toContain('AAA')
    expect(text(renderer)).toContain('BBB')
    mocks.wallet.address = OTHER
    await act(async () => renderer.update(<DistributionBatchFlow kind="reserved" chainId={1} projectId={17} chains={CHAINS} />))
    await click(renderer, 'Confirm test distributions')
    expect(mocks.run).not.toHaveBeenCalled()
    expect(text(renderer)).toContain('connected wallet changed')
  })

  it('restores a pending review without rebuilding already executed destination balances', async () => {
    const calls = distributionBatchCalls([reserved(1), reserved(8453)])
    mocks.load.mockReturnValue({ id: 'original-review', status: 'pending', account: ACCOUNT, calls, completedIds: [calls[0].id] })
    mocks.reserved.mockRejectedValue(new Error('A completed chain now has zero pending'))
    const renderer = await mount('reserved')
    expect(text(renderer)).toContain('Resume saved distributions')
    await click(renderer, 'Confirm test distributions')
    expect(mocks.run).toHaveBeenCalledWith(expect.objectContaining({ calls, expectedBatchId: 'original-review' }))
    expect(mocks.reserved).not.toHaveBeenCalled()
    expect(text(renderer)).toContain('Distributions confirmed')
  })

  it('restores original context for unpaid revalidation and keeps the review when its source has drifted', async () => {
    const calls = distributionBatchCalls([reserved(1), reserved(8453)])
    const saved = { id: 'unpaid-review', status: 'pending', account: ACCOUNT, calls, completedIds: [] }
    mocks.load.mockReturnValue(saved)
    mocks.reverify.mockRejectedValue(new Error('The pending amount changed. Review again.'))
    mocks.run.mockImplementation(async ({ reverify }) => { await reverify(calls[1]); return saved })
    const renderer = await mount('reserved')
    await click(renderer, 'Confirm test distributions')
    expect(mocks.reverify).toHaveBeenCalledWith(calls[1].context as Distribution, ACCOUNT)
    expect(mocks.reserved).not.toHaveBeenCalled()
    expect(text(renderer)).toContain('pending amount changed')
    expect(text(renderer)).toContain('BBB')
  })

  it('returns to a fresh review if the runner abandons an unsubmitted stale recovery', async () => {
    const calls = distributionBatchCalls([reserved(1)])
    mocks.load.mockReturnValue({ id: 'stale-unsubmitted-review', status: 'pending', account: ACCOUNT, calls, completedIds: [] })
    mocks.run.mockImplementation(async () => { mocks.load.mockReturnValue(null); throw new Error('The pending amount changed. Review again.') })
    const renderer = await mount('reserved')
    await click(renderer, 'Confirm test distributions')
    expect(text(renderer)).toContain('pending amount changed')
    expect(text(renderer)).toContain('Review selected distributions')
    expect(text(renderer)).not.toContain('Resume saved distributions')
  })
})
