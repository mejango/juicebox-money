import { describe, expect, it } from 'vitest'
import {
  encodedAutoIssuances,
  launchFundsFact,
  newDraftStage,
  newSimpleProjectDraftStage,
  stageSummaryParts,
  type DraftStage,
} from '@/components/create/stage-draft'
import { newDraftSplit } from '@/components/create/SplitsEditor'

const ALICE = '0x1111111111111111111111111111111111111111'
const BOB = '0x2222222222222222222222222222222222222222'
const review = (hasOwner: boolean, chainIds = [1]) => ({ hasOwner, chainIds, fundsUnit: 'ETH' })
const parts = (stage: DraftStage, hasOwner: boolean, multiToken = false, flavor: 'project' | 'revnet' = 'project') =>
  stageSummaryParts(stage, 0, 'ETH', flavor, multiToken, review(hasOwner))
const row = (value: string, recipient = ALICE) => ({ ...newDraftSplit(), value, recipient })

describe('launch review of a project stage', () => {
  it('states what the Simple preset encodes, with and without an owner', () => {
    const preset = newSimpleProjectDraftStage()
    expect(parts(preset, false)).toEqual([
      'Starts at launch',
      'Lasts forever',
      'Issues 10,000 tokens per ETH',
      'Nobody can withdraw funds',
      'Cash outs off',
    ])
    expect(parts(preset, true)).toEqual([
      'Starts at launch',
      'Lasts until changed',
      'Issues 10,000 tokens per ETH',
      'Owner can withdraw all funds',
      'Cash outs off',
      'Owner can create tokens without payment',
      'Owner can change payment contracts, the contract that manages rules, where funds are held, the token, accepted tokens, price sources',
    ])
    expect(launchFundsFact([preset], 'project', false, false)).toBe("Nobody. Funds can't leave the project.")
    expect(launchFundsFact([preset], 'project', true, false)).toBe('The project owner')
  })

  it('names payout recipients and where a percent payout leftover goes', () => {
    const stage: DraftStage = { ...newDraftStage(true), payouts: 'routed', payoutSplits: [row('20')] }
    expect(parts(stage, true)).toContain('Payouts: 20% to 0x1111…1111, the rest to the project owner')
    // JBMultiTerminal sends the leftover to the owner, here the dead address.
    expect(parts(stage, false)).toContain("Payouts: 20% to 0x1111…1111, the rest to a dead address, where it's lost")
    expect(parts(stage, true)).toContain('Cash outs off, all funds can be paid out')
    expect(launchFundsFact([stage], 'project', false, false)).toBe("Payout recipients and anyone, to a dead address, where it's lost")
    expect(parts({ ...stage, payoutSplits: [row('100')] }, false)).toContain('Payouts: 100% to 0x1111…1111')
  })

  it('states fixed amounts per chain in the token they encode', () => {
    const stage: DraftStage = {
      ...newDraftStage(true),
      payouts: 'routed',
      routedMode: 'amounts',
      payoutSplits: [row('1'), row('2.5', BOB)],
      cashOuts: true,
      cashOutTax: 1000,
    }
    expect(stageSummaryParts(stage, 0, 'USD', 'project', false, review(true, [1, 10])))
      .toContain('Payouts: up to 3.5 ETH on each chain, 1 ETH to 0x1111…1111, 2.5 ETH to 0x2222…2222')
    expect(parts(stage, true)).toContain('0.1 cash out tax')
    expect(parts({ ...stage, payoutSplits: [] }, true)).toContain('Payouts: none set')
    expect(launchFundsFact([stage], 'project', true, false)).toBe('Payout recipients and token holders')
    expect(launchFundsFact([stage], 'project', true, false, true)).toBe('Payout recipients and shop item holders')
  })

  it('states each accepted token of a multi-token payout', () => {
    const stage: DraftStage = {
      ...newDraftStage(true),
      payouts: 'routed',
      payoutSplits: [row('100')],
      routedModeUsdc: 'amounts',
      payoutSplitsUsdc: [row('50', BOB)],
      routedSurplusOn: true,
      surplusCapOn: true,
      surplusAmount: '2',
    }
    const stated = parts(stage, true, true)
    expect(stated).toContain('ETH payouts: 100% to 0x1111…1111')
    expect(stated).toContain('USDC payouts: up to 50 USDC, 50 USDC to 0x2222…2222')
    expect(stated).toContain('Owner can withdraw up to 2 ETH and 2 USDC')
  })

  it('states reserved recipients, and leaves them out of the short card form', () => {
    const stage: DraftStage = { ...newDraftStage(true), reservedSplits: [row('6'), { ...newDraftSplit(), value: '4', kind: 'project', projectId: '#5', beneficiary: BOB }] }
    expect(parts(stage, true)).toContain('10% reserved: 6% to 0x1111…1111, 4% to Project #5 for 0x2222…2222')
    expect(stageSummaryParts(stage, 0, 'ETH')).toContain('10% reserved')
  })

  it('says funds cannot be touched only when no stage lets them out', () => {
    const stage = newDraftStage(true)
    expect(launchFundsFact([stage], 'project', true, false)).toBe('Nobody, until the owner changes the rules')
    expect(parts(stage, true)).toContain('No payouts or withdrawals')
  })
})

describe('launch review of a revnet stage', () => {
  it('states the chosen date, tax and the rows the launch mints', () => {
    const stage: DraftStage = {
      ...newDraftStage(true, 'revnet'),
      scheduleOn: true,
      schedule: '2030-01-01T12:00',
      autoIssuances: [
        { id: 'a', count: '1000', address: ALICE, chainId: 10, perChain: {} },
        { id: 'b', count: '', address: BOB, chainId: null, perChain: {} },
      ],
    }
    const stated = stageSummaryParts(stage, 0, 'ETH', 'revnet', false, review(true, [1, 10]))
    expect(stated[0]).toContain('Starts Jan 1, 2030')
    expect(stated).toContain('0.1 cash out tax')
    expect(stated.find(part => part.startsWith('Mints'))).toMatch(/^Mints 1,000 tokens to 0x1111…1111 on /)
    expect(encodedAutoIssuances(stage, [1, 10])).toEqual([{ count: '1000', beneficiary: ALICE, chainId: 10 }])
    expect(parts({ ...stage, scheduleOn: false, schedule: '' }, true, false, 'revnet')[0]).toBe('Starts about 10 minutes after launch')
  })
})
