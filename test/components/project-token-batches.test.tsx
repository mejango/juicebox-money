import { createElement } from 'react'
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Address } from 'viem'

const mocks = vi.hoisted(() => ({
  account: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Address,
  saved: null as null | { id: string; status: string; account: Address; calls: unknown[] },
  claim: vi.fn(), auto: vi.fn(), allocation: vi.fn(), run: vi.fn(), reverifyClaim: vi.fn(), reverifyAuto: vi.fn(), invalidate: vi.fn(),
}))
vi.mock('@/hooks/useWallet', () => ({ useWallet: () => ({ address: mocks.account, openSignIn: vi.fn() }) }))
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: mocks.invalidate }) }))
vi.mock('@/components/ChainIcon', () => ({ ChainIcon: () => null }))
vi.mock('@/lib/authority', () => ({ toggleInSet: (set: Set<number>, value: number) => {
  const next = new Set(set); if (next.has(value)) next.delete(value); else next.add(value); return next
} }))
vi.mock('@/lib/project-batch', () => ({
  projectBatchScope: () => 'claim-test-scope', loadProjectBatch: () => mocks.saved, runProjectBatch: mocks.run,
}))
vi.mock('@/lib/project-token-batch', () => ({
  readClaimCalls: mocks.claim, readAutoIssueCalls: mocks.auto, readAutoIssueAllocationCall: mocks.allocation,
  reverifyClaimCall: mocks.reverifyClaim, reverifyAutoIssueCall: mocks.reverifyAuto,
}))

import { AutoIssueAcrossChains, AutoIssueAllocation, ClaimCreditsAcrossChains } from '@/components/project/ProjectTokenBatchFlow'

const ACCOUNT = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Address
const BENEFICIARY = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as Address
const OTHER = '0xcccccccccccccccccccccccccccccccccccccccc' as Address
const chains = [[1, 42], [10, 84]] as const
const call = (chainId: number, projectId: number, index = 1, auto = false) => ({
  id: `call-${chainId}-${index}`, chainId, projectId, authority: ACCOUNT, target: OTHER, data: '0x1234',
  label: auto ? 'Auto-issue allocation' : 'Claim credits',
  context: { kind: auto ? 'auto-issuance' : 'claim-credits', holder: ACCOUNT,
    amount: `${BigInt(index) * 10n ** 18n}`, token: OTHER, symbol: chainId === 1 ? 'ONE' : 'TWO',
    beneficiary: index === 1 ? BENEFICIARY : OTHER, stageId: String(index), stageStart: 500 },
})

function text(instance: ReactTestInstance): string {
  return instance.children.map(child => typeof child === 'object' ? text(child) : String(child)).join('')
}
const button = (renderer: TestRenderer.ReactTestRenderer, label: string) => renderer.root.findAllByType('button').find(item => text(item).includes(label))!
async function render(auto = false) {
  let renderer!: TestRenderer.ReactTestRenderer
  await act(async () => { renderer = TestRenderer.create(auto
    ? createElement(AutoIssueAcrossChains, { chains })
    : createElement(ClaimCreditsAcrossChains, { chains, holder: ACCOUNT })) })
  return renderer
}
async function click(renderer: TestRenderer.ReactTestRenderer, label: string) {
  await act(async () => { button(renderer, label).props.onClick() })
}

beforeEach(() => {
  mocks.account = ACCOUNT
  mocks.saved = null
  mocks.claim.mockResolvedValue([call(1, 42), call(10, 84, 2)])
  mocks.auto.mockResolvedValue([call(1, 42, 1, true), call(1, 42, 2, true), call(10, 84, 3, true)])
  mocks.allocation.mockResolvedValue(call(1, 42, 1, true))
  mocks.invalidate.mockResolvedValue(undefined)
  mocks.run.mockImplementation(async ({ calls }) => ({ id: 'batch-1', status: 'complete', account: ACCOUNT, calls: calls ?? mocks.saved!.calls }))
})

describe('aggregate token action reviews', () => {
  it('honors selected local project mappings and shows each claim amount before submission', async () => {
    const renderer = await render()
    await click(renderer, 'Claim credits as ERC-20')
    const checkboxes = renderer.root.findAllByType('input')
    await act(async () => { checkboxes[0].props.onChange() })
    mocks.claim.mockResolvedValueOnce([call(10, 84, 2)])
    await click(renderer, 'Review selected chains')
    expect(mocks.claim).toHaveBeenCalledWith([[10, 84]], ACCOUNT)
    expect(text(renderer.root)).toContain('Project 84')
    expect(text(renderer.root)).toContain('2 TWO')
    expect(mocks.run).not.toHaveBeenCalled()
    await click(renderer, 'Confirm claims')
    expect(mocks.run).toHaveBeenCalledWith(expect.objectContaining({
      action: 'claim-credits', account: ACCOUNT, calls: [call(10, 84, 2)], reverify: mocks.reverifyClaim,
    }))
    expect(text(renderer.root)).toContain('All selected credits are now ERC-20')
  })

  it('resumes persisted claims without rebuilding changed credit balances', async () => {
    mocks.saved = { id: 'batch-1', status: 'pending', account: ACCOUNT, calls: [call(1, 42), call(10, 84, 2)] }
    const renderer = await render()
    expect(text(renderer.root)).toContain('Confirm claims')
    await click(renderer, 'Resume original batch')
    expect(mocks.claim).not.toHaveBeenCalled()
    expect(mocks.run.mock.calls[0][0].calls).toEqual(mocks.saved.calls)
    expect(mocks.run.mock.calls[0][0].expectedBatchId).toBe('batch-1')
    expect(mocks.run.mock.calls[0][0].reverify).toBe(mocks.reverifyClaim)
  })

  it('does not label a still-pending batch complete', async () => {
    const renderer = await render()
    await click(renderer, 'Claim credits as ERC-20')
    await click(renderer, 'Review selected chains')
    mocks.run.mockImplementation(async ({ calls }) => ({ id: 'batch-1', status: 'pending', account: ACCOUNT, calls }))
    await click(renderer, 'Confirm claims')
    expect(text(renderer.root)).toContain('remaining calls')
    expect(text(renderer.root)).not.toContain('All selected credits are now ERC-20')
    expect(mocks.invalidate).not.toHaveBeenCalled()
  })

  it('shows a different batch saved by another tab before allowing its recovery', async () => {
    const renderer = await render()
    await click(renderer, 'Claim credits as ERC-20')
    await click(renderer, 'Review selected chains')
    mocks.saved = { id: 'batch-2', status: 'pending', account: ACCOUNT, calls: [call(10, 84, 9)] }
    await click(renderer, 'Confirm claims')
    expect(mocks.run).not.toHaveBeenCalled()
    expect(text(renderer.root)).toContain('9 TWO')
    expect(text(renderer.root)).toContain('different calls')
    await click(renderer, 'Resume original batch')
    expect(mocks.run).toHaveBeenCalledOnce()
    expect(mocks.run.mock.calls[0][0].calls).toEqual(mocks.saved.calls)
    expect(mocks.run.mock.calls[0][0].expectedBatchId).toBe('batch-2')
  })

  it('retains the displayed recovery ID if another tab completes that batch before submission', async () => {
    mocks.saved = { id: 'batch-1', status: 'pending', account: ACCOUNT, calls: [call(1, 42)] }
    const renderer = await render()
    mocks.saved = null
    mocks.run.mockRejectedValueOnce(new Error('The original batch already completed.'))
    await click(renderer, 'Resume original batch')
    expect(mocks.run.mock.calls[0][0].expectedBatchId).toBe('batch-1')
    expect(mocks.run.mock.calls[0][0].calls).toEqual([call(1, 42)])
    expect(text(renderer.root)).toContain('already completed')
    expect(mocks.claim).not.toHaveBeenCalled()
  })

  it('retains every same-chain beneficiary call in the auto-issuance review', async () => {
    const renderer = await render(true)
    await click(renderer, 'Distribute unlocked allocations')
    await click(renderer, 'Review selected chains')
    expect(mocks.auto).toHaveBeenCalledWith(chains, ACCOUNT)
    expect(text(renderer.root)).toContain(BENEFICIARY)
    expect(text(renderer.root)).toContain(OTHER)
    await click(renderer, 'Confirm & distribute')
    expect(mocks.run.mock.calls[0][0].calls).toHaveLength(3)
    expect(mocks.run.mock.calls[0][0].calls.map((item: { chainId: number }) => item.chainId)).toEqual([1, 1, 10])
    expect(mocks.run.mock.calls[0][0].reverify).toBe(mocks.reverifyAuto)
  })

  it('routes an individual row into its already-pending aggregate instead of writing around it', async () => {
    const original = [call(1, 42, 1, true), call(1, 42, 2, true), call(10, 84, 3, true)]
    mocks.saved = { id: 'aggregate', status: 'pending', account: ACCOUNT, calls: original }
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => { renderer = TestRenderer.create(createElement(AutoIssueAllocation,
      { chainId: 1, projectId: 42, stageId: '1', beneficiary: BENEFICIARY })) })
    expect(text(renderer.root)).not.toContain('Confirm auto issuance')
    await click(renderer, 'Resume saved batch')
    expect(text(renderer.root)).toContain('Project 84')
    await click(renderer, 'Resume original batch')
    expect(mocks.allocation).not.toHaveBeenCalled()
    expect(mocks.auto).not.toHaveBeenCalled()
    expect(mocks.run).toHaveBeenCalledWith(expect.objectContaining({
      action: 'auto-issuance', expectedBatchId: 'aggregate', calls: original,
    }))
  })

  it('clears an abandoned local review so live amounts can be prepared again', async () => {
    const renderer = await render()
    await click(renderer, 'Claim credits as ERC-20')
    await click(renderer, 'Review selected chains')
    mocks.run.mockRejectedValueOnce(new Error('Wallet rejected before submission.'))
    await click(renderer, 'Confirm claims')
    expect(text(renderer.root)).toContain('Review selected chains')
    expect(text(renderer.root)).not.toContain('Resume original batch')
    mocks.claim.mockResolvedValueOnce([call(1, 42, 8)])
    await click(renderer, 'Review selected chains')
    await click(renderer, 'Confirm claims')
    expect(mocks.run.mock.calls[1][0].calls).toEqual([call(1, 42, 8)])
    expect(mocks.run.mock.calls[1][0].expectedBatchId).toBeUndefined()
  })

  it('refuses recovery with a wallet different from the original batch account', async () => {
    mocks.saved = { id: 'batch-1', status: 'pending', account: OTHER, calls: [call(1, 42, 1, true)] }
    const renderer = await render(true)
    await click(renderer, 'Resume original batch')
    expect(mocks.run).not.toHaveBeenCalled()
    expect(text(renderer.root)).toContain('wallet that started')
  })
})
