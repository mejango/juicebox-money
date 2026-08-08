import { zeroAddress } from 'viem'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  CLEARED_RESERVED_NOTE,
  assembleSplits,
  clearBlockReason,
  describeFallbackSplits,
  splitToDraft,
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

describe('lock round trip', () => {
  // The lock field is a `datetime-local` input: local wall clock in both
  // directions. Pin a west-of-UTC zone, where a UTC-emitting draft would
  // re-encode a just-expired lock as still-locked (7-8h into the future).
  const originalTz = process.env.TZ
  beforeAll(() => {
    process.env.TZ = 'America/Los_Angeles'
  })
  afterAll(() => {
    process.env.TZ = originalTz
  })

  // 2025-08-06T17:06:00Z — minute-aligned, since the input is minute-precise.
  const LOCKED_UNTIL = 1_754_499_960
  const expiredLock: RawSplit = {
    percent: 100_000_000,
    projectId: 0n,
    beneficiary: RECIPIENT,
    preferAddToBalance: false,
    lockedUntil: LOCKED_UNTIL,
    hook: zeroAddress,
  }

  it('renders the lock as local wall clock, not UTC', () => {
    expect(splitToDraft(expiredLock).lockedUntil).toBe('2025-08-06T10:06')
  })

  it('re-encodes an untouched lock to the same timestamp', () => {
    const result = assembleSplits([], [splitToDraft(expiredLock)], EMPTY_FALLBACK, 8453)
    if ('error' in result) throw new Error(result.error)
    expect(result.splits[0].lockedUntil).toBe(LOCKED_UNTIL)
  })

  it('leaves an unlocked split unlocked', () => {
    expect(splitToDraft(fallbackRow).lockedUntil).toBe('')
    const result = assembleSplits([], [splitToDraft(fallbackRow)], EMPTY_FALLBACK, 8453)
    if ('error' in result) throw new Error(result.error)
    expect(result.splits[0].lockedUntil).toBe(0)
  })
})

describe('assembleSplits', () => {
  it('an emptied group is a valid submission when the ruleset-0 fallback is verified empty', () => {
    expect(assembleSplits([], [], EMPTY_FALLBACK, 8453)).toEqual({ splits: [] })
  })

  it('blocks the empty save when a non-empty fallback would take over', () => {
    const result = assembleSplits([], [], { status: 'nonEmpty', count: 2 }, 8453)
    expect(result).toEqual({ error: clearBlockReason({ status: 'nonEmpty', count: 2 }) })
    expect((result as { error: string }).error).toContain('2 recipients')
  })

  it('blocks the empty save when the fallback read failed', () => {
    const result = assembleSplits([], [], { status: 'unknown' }, 8453)
    expect(result).toEqual({ error: clearBlockReason({ status: 'unknown' }) })
  })

  it('blocks the empty save while the fallback is still being checked', () => {
    expect(assembleSplits([], [], { status: 'checking' }, 8453)).toEqual({
      error: clearBlockReason({ status: 'checking' }),
    })
  })

  it('re-submits locked rows verbatim even when every editable row was removed', () => {
    const result = assembleSplits([lockedRow], [], EMPTY_FALLBACK, 8453)
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
    const result = assembleSplits([lockedRow], [], { status: 'unknown' }, 8453)
    expect(result).toHaveProperty('splits')
  })

  it('rebuilds editable drafts after the locked rows', () => {
    const result = assembleSplits([lockedRow], [addressDraft('25')], EMPTY_FALLBACK, 8453)
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
    }, 8453)
    if ('error' in result) throw new Error(result.error)
    expect(result.splits).toHaveLength(1)
  })

  it('rejects a zero-share editable row instead of silently dropping it', () => {
    const result = assembleSplits([], [addressDraft('0')], EMPTY_FALLBACK, 8453)
    expect(result).toHaveProperty('error')
  })
})
