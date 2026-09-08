import { describe, expect, it } from 'vitest'
import { describeTransferSchedule } from '@/lib/transfer-schedule'

const stages = (...paused: boolean[]) =>
  paused.map((value, index) => ({ stage: index + 1, paused: value }))

describe('describeTransferSchedule', () => {
  it('has nothing to say without a stage schedule', () => {
    // Non-revnet projects pass null: their stages are not settled, so the caller
    // falls back to describing the current ruleset.
    expect(describeTransferSchedule(null)).toBeNull()
    expect(describeTransferSchedule([])).toBeNull()
  })

  it('states the settled answer when every stage agrees', () => {
    expect(describeTransferSchedule(stages(false, false))).toBe(
      'Transfers allowed in every stage',
    )
    expect(describeTransferSchedule(stages(true, true))).toBe(
      'Transfers paused in every stage',
    )
  })

  it('reads the final stage as open-ended', () => {
    expect(describeTransferSchedule(stages(true, false))).toBe(
      'Paused in stage 1, allowed from stage 2',
    )
    expect(describeTransferSchedule(stages(true, true, false))).toBe(
      'Paused in stages 1–2, allowed from stage 3',
    )
  })

  it('keeps every alternation rather than collapsing to the current stage', () => {
    expect(describeTransferSchedule(stages(false, true, false))).toBe(
      'Allowed in stage 1, paused in stage 2, allowed from stage 3',
    )
  })
})
