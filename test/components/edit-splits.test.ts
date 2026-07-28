import { zeroAddress } from 'viem'
import { describe, expect, it } from 'vitest'
import {
  CLEARED_RESERVED_NOTE,
  assembleSplits,
  clearBlockReason,
  describeFallbackSplits,
} from '@/components/project/EditSplitsFlow'
import { newDraftSplit } from '@/components/create/SplitsEditor'
import type { RawSplit } from '@/lib/splits-types'

const RECIPIENT = '0x1111111111111111111111111111111111111111'

const lockedRow: RawSplit = {
  percent: 100_000_000,
  projectId: 0n,
  beneficiary: '0x2222222222222222222222222222222222222222',
  preferAddToBalance: false,
  lockedUntil: 4_102_444_800,
  hook: zeroAddress,
}

const fallbackRow: RawSplit = {
  percent: 500_000_000,
  projectId: 0n,
  beneficiary: '0x3333333333333333333333333333333333333333',
  preferAddToBalance: false,
  lockedUntil: 0,
  hook: zeroAddress,
}

const EMPTY_FALLBACK = { status: 'empty' } as const

function addressDraft(value: string) {
  return { ...newDraftSplit(), value, kind: 'address' as const, recipient: RECIPIENT }
}

describe('describeFallbackSplits', () => {
  it('an empty ruleset-0 group is a verified-empty fallback', () => {
    expect(describeFallbackSplits([])).toEqual({ status: 'empty' })
  })

  it('counts the recipients a non-empty ruleset-0 group would activate', () => {
    expect(describeFallbackSplits([fallbackRow, fallbackRow])).toEqual({
      status: 'nonEmpty',
      count: 2,
    })
  })

  it('an unread or failed fallback read stays unknown (fail closed)', () => {
    expect(describeFallbackSplits(undefined)).toEqual({ status: 'unknown' })
    expect(describeFallbackSplits(null)).toEqual({ status: 'unknown' })
  })
})

describe('clearBlockReason', () => {
  it('allows the clear only when the fallback is verified empty', () => {
    expect(clearBlockReason(EMPTY_FALLBACK)).toBeNull()
  })

  it('names how many default recipients would take over', () => {
    const reason = clearBlockReason({ status: 'nonEmpty', count: 3 })
    expect(reason).toContain('default splits')
    expect(reason).toContain('3 recipients')
    expect(reason).toContain('not send tokens to the owner')
  })

  it('uses the singular for a one-recipient fallback', () => {
    expect(clearBlockReason({ status: 'nonEmpty', count: 1 })).toContain(
      '1 recipient)',
    )
  })

  it('blocks while the fallback read is still in flight, without claiming it failed', () => {
    const reason = clearBlockReason({ status: 'checking' })
    expect(reason).toContain('Checking')
    expect(reason).not.toContain('try again')
    expect(reason).not.toContain('project owner')
  })

  it('blocks with a couldn’t-verify message when the fallback is unknown', () => {
    const reason = clearBlockReason({ status: 'unknown' })
    expect(reason).toContain('verify')
    expect(reason).not.toContain('project owner')
  })
})

describe('CLEARED_RESERVED_NOTE', () => {
  it('states the verified truth — no default splits exist, so the share accrues to the owner', () => {
    expect(CLEARED_RESERVED_NOTE).toContain('no default')
    expect(CLEARED_RESERVED_NOTE).toContain('accrues to the project owner')
  })
})

describe('assembleSplits', () => {
  it('an emptied group is a valid submission when the ruleset-0 fallback is verified empty', () => {
    expect(assembleSplits([], [], EMPTY_FALLBACK)).toEqual({ splits: [] })
  })

  it('blocks the empty save when a non-empty fallback would take over', () => {
    const result = assembleSplits([], [], { status: 'nonEmpty', count: 2 })
    expect(result).toEqual({ error: clearBlockReason({ status: 'nonEmpty', count: 2 }) })
    expect((result as { error: string }).error).toContain('2 recipients')
  })

  it('blocks the empty save when the fallback read failed', () => {
    const result = assembleSplits([], [], { status: 'unknown' })
    expect(result).toEqual({ error: clearBlockReason({ status: 'unknown' }) })
  })

  it('blocks the empty save while the fallback is still being checked', () => {
    expect(assembleSplits([], [], { status: 'checking' })).toEqual({
      error: clearBlockReason({ status: 'checking' }),
    })
  })

  it('re-submits locked rows verbatim even when every editable row was removed', () => {
    const result = assembleSplits([lockedRow], [], EMPTY_FALLBACK)
    expect(result).toEqual({
      splits: [
        {
          percent: lockedRow.percent,
          projectId: lockedRow.projectId,
          beneficiary: lockedRow.beneficiary,
          preferAddToBalance: lockedRow.preferAddToBalance,
          lockedUntil: lockedRow.lockedUntil,
          hook: lockedRow.hook,
        },
      ],
    })
  })

  it('a locked-row-only save is not a clear, so an unverified fallback does not block it', () => {
    const result = assembleSplits([lockedRow], [], { status: 'unknown' })
    expect(result).toHaveProperty('splits')
  })

  it('rebuilds editable drafts after the locked rows', () => {
    const result = assembleSplits([lockedRow], [addressDraft('25')], EMPTY_FALLBACK)
    if ('error' in result) throw new Error(result.error)
    expect(result.splits).toHaveLength(2)
    expect(result.splits[1]).toMatchObject({
      percent: 250_000_000,
      beneficiary: RECIPIENT,
      hook: zeroAddress,
    })
  })

  it('leaves non-empty submissions unaffected by a non-empty fallback', () => {
    const result = assembleSplits([], [addressDraft('25')], {
      status: 'nonEmpty',
      count: 4,
    })
    if ('error' in result) throw new Error(result.error)
    expect(result.splits).toHaveLength(1)
  })

  it('rejects a zero-share editable row instead of silently dropping it', () => {
    const result = assembleSplits([], [addressDraft('0')], EMPTY_FALLBACK)
    expect(result).toHaveProperty('error')
  })
})
