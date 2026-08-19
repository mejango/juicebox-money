import { describe, expect, it } from 'vitest'
import { mergeCrossChainGroups } from '@/components/ActivityList'
import type { BsActivityEvent } from '@/lib/bendystraw'

const base = (over: Partial<BsActivityEvent>): BsActivityEvent =>
  ({
    id: Math.random().toString(36).slice(2),
    chainId: 1,
    projectId: 4,
    timestamp: 1_000_000,
    from: '0xactor',
    txHash: '0x' + Math.random().toString(16).slice(2),
    payEvent: null,
    cashOutTokensEvent: null,
    ...over,
  }) as BsActivityEvent

describe('mergeCrossChainGroups', () => {
  it('folds the same action by the same actor on other chains into one item', () => {
    const groups = [1, 10, 8453, 42161].map(chainId => [
      base({ chainId, buybackPoolEvent: { terminalToken: '0x0', poolId: `pool-${chainId}`, caller: `0xc${chainId}`, from: '0xactor' } } as Partial<BsActivityEvent>),
    ])
    const merged = mergeCrossChainGroups(groups)
    expect(merged).toHaveLength(1)
    expect(merged[0].chains.map(c => c.chainId)).toEqual([1, 10, 8453, 42161])
  })

  it('keeps different substance apart even in the window', () => {
    const groups = [
      [base({ chainId: 1, autoIssueEvent: { beneficiary: '0xb', count: '100', stageId: '1', from: '0xactor' } } as Partial<BsActivityEvent>)],
      [base({ chainId: 10, autoIssueEvent: { beneficiary: '0xb', count: '200', stageId: '1', from: '0xactor' } } as Partial<BsActivityEvent>)],
    ]
    expect(mergeCrossChainGroups(groups)).toHaveLength(2)
  })

  it('never folds two actions from the same chain', () => {
    const groups = [
      [base({ chainId: 1, buybackPoolEvent: { terminalToken: '0x0', poolId: 'a', caller: '0xc', from: '0xactor' } } as Partial<BsActivityEvent>)],
      [base({ chainId: 1, buybackPoolEvent: { terminalToken: '0x0', poolId: 'b', caller: '0xc', from: '0xactor' } } as Partial<BsActivityEvent>)],
    ]
    expect(mergeCrossChainGroups(groups)).toHaveLength(2)
  })

  it('keeps repeats outside the relay window apart', () => {
    const groups = [
      [base({ chainId: 1, timestamp: 1_000_000, buybackPoolEvent: { terminalToken: '0x0', poolId: 'a', caller: '0xc', from: '0xactor' } } as Partial<BsActivityEvent>)],
      [base({ chainId: 10, timestamp: 1_000_000 - 7 * 3600, buybackPoolEvent: { terminalToken: '0x0', poolId: 'b', caller: '0xc', from: '0xactor' } } as Partial<BsActivityEvent>)],
    ]
    expect(mergeCrossChainGroups(groups)).toHaveLength(2)
  })
})
