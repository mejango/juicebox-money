import type { Address } from 'viem'
import { describe, expect, it } from 'vitest'

import { pctToBp, queueRulesetAuthority } from '@/components/project/QueueRulesetFlow'

const ALICE = '0x1111111111111111111111111111111111111111' as Address
const BOB = '0x2222222222222222222222222222222222222222' as Address
const SAFE = '0x4444444444444444444444444444444444444444' as Address

describe('pctToBp', () => {
  it('encodes a 0% reserved share — turning reserving off is a queueable rule', () => {
    expect(pctToBp('0')).toBe(0)
    expect(pctToBp('')).toBe(0)
  })

  it('rounds and clamps ordinary percents into basis points of 10000', () => {
    expect(pctToBp('12.34')).toBe(1234)
    expect(pctToBp('100')).toBe(10_000)
    expect(pctToBp('250')).toBe(10_000)
  })
})

describe('queueRulesetAuthority', () => {
  it('lets the owner queue as themselves', () => {
    expect(
      queueRulesetAuthority({
        address: ALICE,
        owner: ALICE.toUpperCase().replace('0X', '0x') as Address,
        safeSigners: undefined,
        hasQueuePermission: undefined,
      }),
    ).toEqual(ALICE.toUpperCase().replace('0X', '0x'))
  })

  it('lets a signer of the owning Safe queue THROUGH the Safe (authority = the Safe)', () => {
    expect(
      queueRulesetAuthority({
        address: ALICE,
        owner: SAFE,
        safeSigners: [BOB, ALICE],
        hasQueuePermission: undefined,
      }),
    ).toBe(SAFE)
  })

  it('lets a QUEUE_RULESETS operator queue as themselves', () => {
    expect(
      queueRulesetAuthority({
        address: ALICE,
        owner: BOB,
        safeSigners: [],
        hasQueuePermission: true,
      }),
    ).toBe(ALICE)
  })

  it('denies everyone else, including while reads are still pending', () => {
    expect(
      queueRulesetAuthority({
        address: ALICE,
        owner: BOB,
        safeSigners: [],
        hasQueuePermission: false,
      }),
    ).toBeNull()
    expect(
      queueRulesetAuthority({
        address: ALICE,
        owner: BOB,
        safeSigners: undefined,
        hasQueuePermission: undefined,
      }),
    ).toBeNull()
    expect(
      queueRulesetAuthority({
        address: undefined,
        owner: BOB,
        safeSigners: [ALICE],
        hasQueuePermission: true,
      }),
    ).toBeNull()
    expect(
      queueRulesetAuthority({
        address: ALICE,
        owner: undefined,
        safeSigners: [ALICE],
        hasQueuePermission: true,
      }),
    ).toBeNull()
  })
})

import { expandAfterwards, queueStageStarts } from '@/components/project/QueueRulesetFlow'
import { FOREVER_SECONDS } from '@/lib/launch'

const day = 86_400

// Ruleset #1 is queued on the live parent, so its start is the parent's next
// cycle boundary; a follower's "N cycles" counts from THAT start.
describe('queueStageStarts', () => {
  it('preserves a near-term explicit first date instead of moving it for a future preparation horizon', () => {
    const now = 2_000_000_000
    const requested = now + day + 300
    const timing = queueStageStarts({
      parent: { start: requested - 3 * day, duration: 3 * day, noticeSeconds: day },
      firstMust: requested,
      latestRulesetId: now - 1,
      stages: [{ duration: 3 * day, noticeSeconds: day }, { duration: 0 }],
      now,
    })
    expect(timing.musts[0]).toBe(requested)
    expect(timing.starts).toEqual([requested, requested + 3 * day])
    expect(timing.validUntil).toBe(now + 300)
  })

  it('keeps a replacement in its intended cycle when approval closes inside the preparation horizon', () => {
    const now = 2_000_000_000
    const targetStart = now + day + 300
    const timing = queueStageStarts({
      parent: { start: targetStart - 3 * day, duration: 3 * day, noticeSeconds: day },
      firstMust: targetStart,
      latestRulesetId: now - 1,
      stages: [{ duration: 3 * day, noticeSeconds: day }, { duration: 0 }],
      now,
      validUntil: now + 299,
    })
    expect(timing.musts[0]).toBe(targetStart)
    expect(timing.starts).toEqual([targetStart, targetStart + 3 * day])
    expect(timing.validUntil).toBe(now + 299)
  })

  it('refuses a replacement whose execution window has already closed', () => {
    const now = 2_000_000_000
    expect(() => queueStageStarts({
      parent: { start: now, duration: day },
      firstMust: now + day,
      stages: [{ duration: day }, { duration: 0 }],
      now,
      validUntil: now,
    })).toThrow(/expired|closed/i)
  })

  it('includes the live parent notice and monotonic queue IDs before snapping followers', () => {
    const now = 1_800_000_000
    const { starts } = queueStageStarts({
      parent: { start: now, duration: day, noticeSeconds: day },
      firstMust: 0,
      latestRulesetId: now,
      stages: [
        { duration: day, noticeSeconds: 3 * day },
        { duration: 4_294_967_295 },
      ],
      now,
    })
    expect(starts).toEqual([now + 2 * day, now + 4 * day])
  })

  it('anchors followers on the parent-snapped start of ruleset #1', () => {
    const now = 1_800_000_000
    const parent = { start: now - 3 * day - 1_000, duration: day }
    const { musts, starts } = queueStageStarts({
      parent,
      firstMust: 0,
      stages: [
        { duration: day },
        { duration: 0, startMode: 'cycles', startCycles: '3' },
      ],
      now,
    })
    expect(starts[0]).toBe(parent.start + 4 * day)
    expect(musts).toEqual([parent.start + 4 * day, parent.start + 4 * day + 3 * day])
    expect(starts[1]).toBe(parent.start + 7 * day)
  })
  it('pins one-cycle followers and snaps a date up to an explicit boundary', () => {
    const now = 1_800_000_000
    const parent = { start: now - 100, duration: day }
    const date = new Date((now + 2 * day + 500) * 1000).toISOString()
    const { musts, starts } = queueStageStarts({
      parent,
      firstMust: 0,
      stages: [
        { duration: day },
        { duration: day, startMode: 'cycles', startCycles: '1' },
        { duration: 0, startMode: 'date', startDate: date },
      ],
      now,
    })
    expect(musts[0]).toBe(starts[0])
    expect(musts[1]).toBe(parent.start + 2 * day)
    expect(starts[1]).toBe(parent.start + 2 * day)
    expect(musts[2]).toBe(parent.start + 3 * day)
    expect(starts[2]).toBe(parent.start + 3 * day)
  })

  it('pins every follower including a closing stage beyond its real predecessor', () => {
    const now = 1_800_000_000
    const { musts, starts } = queueStageStarts({
      parent: { start: now, duration: 3 * day },
      firstMust: 0,
      stages: [{ duration: 3 * day }, { duration: 3 * day }, { duration: 4_294_967_295 }],
      now,
    })
    expect(musts).toEqual(starts)
    expect(starts).toEqual([now + 3 * day, now + 6 * day, now + 9 * day])
    expect(musts[2]).toBeGreaterThanOrEqual(starts[1] + 3 * day)
  })

  it('refuses batched custom approval hooks instead of silently skipping stages', () => {
    expect(() => queueStageStarts({
      parent: { start: 1_800_000_000, duration: day },
      firstMust: 0,
      stages: [{ duration: day, noticeSeconds: null }, { duration: day }],
      now: 1_800_000_000,
    })).toThrow(/custom|approval/i)
  })

  it('keeps singleton custom-hook queueing on its existing path', () => {
    const now = 1_800_000_000
    expect(queueStageStarts({
      parent: { start: now, duration: day, noticeSeconds: null },
      firstMust: 0,
      stages: [{ duration: day, noticeSeconds: null }],
      now,
    })).toEqual({ musts: [0], starts: [now + day] })
  })
})

describe('expandAfterwards', () => {
  const rules = {
    duration: day,
    weight: '100',
    weightCutPct: '0',
    reservedPct: '0',
    cashOutTaxPct: '0',
    pausePay: false,
    pauseCreditTransfers: false,
    pause721Transfers: false,
    holdFees: false,
    ownerMustSendPayouts: false,
    allowOwnerMinting: false,
    allowSetTerminals: false,
    allowSetController: false,
    allowTerminalMigration: false,
    allowSetCustomToken: false,
    allowAddAccountingContext: false,
    allowAddPriceFeed: false,
    limits: [
      {
        token: '0x000000000000000000000000000000000000EEEe' as Address,
        symbol: 'ETH',
        decimals: 18,
        currency: 1,
        mode: 'unlimited' as const,
        amount: '',
        surplusAllowances: [],
      },
    ],
  }
  it('leaves a cycling or open-ended last ruleset alone', () => {
    expect(expandAfterwards([rules], 'cycle')).toHaveLength(1)
    expect(expandAfterwards([{ ...rules, duration: 0 }], 'wait')).toHaveLength(1)
  })
  it('appends a standby or a forever copy', () => {
    const wait = expandAfterwards([rules], 'wait')
    expect(wait[1]).toEqual(
      expect.objectContaining({ duration: 0, weight: '0', pausePay: true }),
    )
    expect(wait[1].limits[0].mode).toBe('none')
    expect(expandAfterwards([rules], 'terminal')[1].duration).toBe(FOREVER_SECONDS)
  })
})
