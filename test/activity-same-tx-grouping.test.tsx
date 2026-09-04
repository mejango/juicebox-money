import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  combinedActivityParts,
  groupSameTxEvents,
  projectFeedEvents,
} from '@/components/ActivityList'
import type { BsActivityEvent } from '@/lib/bendystraw'

vi.mock('@/hooks/useEnsName', () => ({
  useEnsName: () => ({ data: null }),
}))

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
    // One fragment per event in reading order, minus the zero-issuance pay's
    // "paid into the project" — the amount + "in" tag already say that.
    expect(parts.actions).toHaveLength(2)
    const sentence = renderToStaticMarkup(<>{parts.action}</>)
    expect(sentence).not.toContain('paid into the project')
    expect(sentence).toContain('via the buyback pool')
    // The remint is explained, not shown as a bare mint: 17,043/28,406 ≈ 60%
    // of the swap output kept, so the line names the 40% reserve.
    expect(sentence).toContain('received')
    expect(sentence).toContain('after the 40% reserve')
    expect(sentence).not.toContain('minted')
    expect(sentence.indexOf('via the buyback pool')).toBeLessThan(
      sentence.indexOf('after the 40% reserve'),
    )
  })

  it('pairs each remint with its own swap when one tx holds two buyback pays', () => {
    const swapOf = (id: string, projectTokenAmount: string) =>
      event({
        id,
        from: '0xbundler',
        swapEvent: { ...swap.swapEvent!, projectTokenAmount },
      } as Partial<BsActivityEvent>)
    const mintOf = (id: string, beneficiaryTokenCount: string) =>
      event({
        id,
        mintTokensEvent: { beneficiary: '0xpayer', beneficiaryTokenCount },
      } as Partial<BsActivityEvent>)
    // 100 → 62 and 200 → 124 are both a 38% reserve.
    const parts = combinedActivityParts(
      [
        swapOf('s1', '100000000000000000000'),
        mintOf('m1', '62000000000000000000'),
        swapOf('s2', '200000000000000000000'),
        mintOf('m2', '124000000000000000000'),
      ],
      'ART',
    )
    const sentence = renderToStaticMarkup(<>{parts.action}</>)
    expect(sentence.match(/after the 38% reserve/g)).toHaveLength(2)
    expect(sentence).not.toContain('minted')

    // The indexer returns a tx's events in no particular order: pairing goes
    // by amount rank, so a shuffled tx labels every remint the same way.
    const shuffled = combinedActivityParts(
      [
        mintOf('m1', '62000000000000000000'),
        swapOf('s2', '200000000000000000000'),
        mintOf('m2', '124000000000000000000'),
        swapOf('s1', '100000000000000000000'),
      ],
      'ART',
    )
    const shuffledSentence = renderToStaticMarkup(<>{shuffled.action}</>)
    expect(shuffledSentence.match(/after the 38% reserve/g)).toHaveLength(2)
    expect(shuffledSentence).not.toContain('minted')
  })

  it("reads a fan-out (two pays in one tx) as the payer's total and who got what", () => {
    const payOf = (id: string, beneficiary: string, amount: string) =>
      event({
        id,
        from: '0xpayer',
        payEvent: { ...pay.payEvent!, beneficiary, amount, amountUsd: null, newlyIssuedTokenCount: '0' },
      })
    const swapOf = (id: string, projectTokenAmount: string) =>
      event({
        id,
        from: '0xpayer',
        swapEvent: { ...swap.swapEvent!, from: '0xpayer', projectTokenAmount },
      } as Partial<BsActivityEvent>)
    const mintOf = (id: string, beneficiary: string, beneficiaryTokenCount: string) =>
      event({
        id,
        mintTokensEvent: { beneficiary, beneficiaryTokenCount },
      } as Partial<BsActivityEvent>)
    const parts = combinedActivityParts(
      [
        payOf('p1', '0xalice', '4000000000000000'),
        swapOf('s1', '100000000000000000000'),
        mintOf('m1', '0xalice', '62000000000000000000'),
        payOf('p2', '0xbob', '6000000000000000'),
        swapOf('s2', '200000000000000000000'),
        mintOf('m2', '0xbob', '124000000000000000000'),
      ],
      'ART',
    )
    // The row is the payment: the payer and the total, not the first payee and its share.
    expect(parts.actor).toBe('0xpayer')
    expect(parts.amountRaw).toBe('10000000000000000')
    const sentence = renderToStaticMarkup(<>{parts.action}</>)
    expect(sentence).toContain('0xalice')
    expect(sentence).toContain('0xbob')
    expect(sentence.match(/ got /g)).toHaveLength(2)
    expect(sentence.match(/after the 38% reserve/g)).toHaveLength(2)
    expect(sentence).not.toContain('bought')
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

// A reserved distribution: the total plus one receipt per split, all in one
// tx. The row leads with the total and lists the recipients, largest first.
describe('reserved distributions', () => {
  const distribution = event({
    id: 'r',
    txHash: '0xreserved',
    sendReservedTokensToSplitsEvent: {
      tokenCount: '3600000000000000000000000',
      from: '0xfrom',
    },
  })
  const toAddress = event({
    id: 's1',
    txHash: '0xreserved',
    sendReservedTokensToSplitEvent: {
      tokenCount: '600000000000000000000000',
      beneficiary: '0xsmall',
      splitProjectId: 0,
      from: '0xfrom',
    },
  })
  const toProject = event({
    id: 's2',
    txHash: '0xreserved',
    sendReservedTokensToSplitEvent: {
      tokenCount: '3000000000000000000000000',
      beneficiary: '0x0000000000000000000000000000000000000000',
      splitProjectId: 7,
      from: '0xfrom',
    },
  })

  it('renders one row: the total as headline, a bullet per recipient', () => {
    const groups = groupSameTxEvents([toAddress, distribution, toProject])
    expect(groups).toHaveLength(1)
    const parts = combinedActivityParts(groups[0], 'ART')
    expect(parts.headline).toEqual({ amount: '3.6m ART', tag: 'reserved distro' })
    expect(parts.actor).toBe('0xfrom')
    const bullets = parts.actions.map(action =>
      renderToStaticMarkup(<>{action}</>),
    )
    expect(bullets).toHaveLength(2)
    expect(bullets[0]).toContain('3m ART')
    expect(bullets[0]).toContain('to project #7')
    expect(bullets[1]).toContain('600k ART')
    expect(bullets[1]).toContain('title="0xsmall"')
    expect(bullets.join()).not.toContain('distributed reserved')
  })

  it('admits receipts to the project feed only alongside their distribution', () => {
    expect(projectFeedEvents([toAddress, toProject])).toEqual([])
    expect(projectFeedEvents([toAddress, distribution])).toHaveLength(2)
    const other = event({ ...toAddress, txHash: '0xother' })
    expect(projectFeedEvents([other, distribution])).toEqual([distribution])
  })

  it('keeps a receipt without its distribution as a "received" line', () => {
    const parts = combinedActivityParts([toAddress], 'ART')
    expect(parts.headline).toBeNull()
    expect(renderToStaticMarkup(<>{parts.action}</>)).toContain(
      'from a reserved split',
    )
  })
})
