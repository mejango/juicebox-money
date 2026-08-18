import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  combinedActivityParts,
  groupSameTxEvents,
} from '@/components/ActivityList'
import type { BsActivityEvent } from '@/lib/bendystraw'

function event(overrides: Partial<BsActivityEvent>): BsActivityEvent {
  return {
    id: 'e',
    chainId: 8453,
    projectId: 6,
    timestamp: 1,
    from: '0xfrom',
    txHash: '0xtx',
    payEvent: null,
    cashOutTokensEvent: null,
    ...overrides,
  } as BsActivityEvent
}

// The buyback shape: one tx carrying a pay (no issuance), the pool swap, and
// the reserved-rate remint. It must render as ONE line item attributed to the
// payer, not three rows with the swap pinned on the bundler EOA.
const pay = event({
  id: 'a',
  payEvent: {
    amount: '20000000',
    amountUsd: '19999360000000000000',
    beneficiary: '0xpayer',
    memo: 'Funding Human Creativity',
    newlyIssuedTokenCount: '0',
  },
})
const swap = event({
  id: 'b',
  from: '0xbundler',
  swapEvent: {
    direction: 'buy',
    from: '0xbundler',
    caller: '0xpool',
    projectTokenAmount: '28406000000000000000000',
    terminalTokenAmount: '20000000',
  },
} as Partial<BsActivityEvent>)
const mint = event({
  id: 'c',
  mintTokensEvent: {
    beneficiary: '0xpayer',
    beneficiaryTokenCount: '17043000000000000000000',
  },
} as Partial<BsActivityEvent>)

describe('groupSameTxEvents', () => {
  it('folds events sharing one tx and keeps other txs separate', () => {
    const other = event({ id: 'd', txHash: '0xother', payEvent: pay.payEvent })
    const groups = groupSameTxEvents([pay, swap, mint, other])
    expect(groups.map(group => group.length)).toEqual([3, 1])
  })

  it('keeps same-tx events apart across projects and chains', () => {
    const otherProject = event({ id: 'd', projectId: 1, payEvent: pay.payEvent })
    const otherChain = event({ id: 'e', chainId: 1, payEvent: pay.payEvent })
    expect(groupSameTxEvents([pay, otherProject, otherChain])).toHaveLength(3)
  })
})

describe('combinedActivityParts', () => {
  it('attributes the row to the pay beneficiary and joins every action', () => {
    const parts = combinedActivityParts([swap, mint, pay], 'ART')
    expect(parts.actor).toBe('0xpayer')
    expect(parts.direction).toBe('in')
    expect(parts.memo).toBe('Funding Human Creativity')
    expect(parts.amountRaw).toBe('20000000')
    // One fragment per event, in reading order — the project feed bullets these.
    expect(parts.actions).toHaveLength(3)
    const sentence = renderToStaticMarkup(<>{parts.action}</>)
    expect(sentence).toContain('paid into the project')
    expect(sentence).toContain('via the buyback pool')
    // The remint is explained, not shown as a bare mint: 17,043/28,406 ≈ 60%
    // of the swap output kept, so the line names the 40% reserve.
    expect(sentence).toContain('received')
    expect(sentence).toContain('after the 40% reserve')
    expect(sentence).not.toContain('minted')
    expect(sentence.indexOf('paid into the project')).toBeLessThan(
      sentence.indexOf('via the buyback pool'),
    )
  })

  it('drops the mint record when the pay itself issued the tokens', () => {
    // An issuance-route pay: its mintTokensEvent is the same issuance
    // double-reported, so only the pay fragment renders — worded like the
    // buyback fragment: "bought <amount> <token> <source>".
    const issuancePay = event({
      id: 'a',
      payEvent: {
        ...pay.payEvent!,
        newlyIssuedTokenCount: '207700000000000000000000',
      },
    })
    const parts = combinedActivityParts([issuancePay, mint], 'ART')
    expect(parts.actions).toHaveLength(1)
    const sentence = renderToStaticMarkup(<>{parts.actions[0]}</>)
    expect(sentence).toContain('bought')
    expect(sentence).toContain('from issuance')
    expect(sentence).not.toContain('minted')
  })

  it('leaves a lone event untouched', () => {
    const parts = combinedActivityParts([pay], 'ART')
    expect(renderToStaticMarkup(<>{parts.action}</>)).toBe(
      'paid into the project',
    )
  })
})
