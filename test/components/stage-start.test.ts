import { describe, expect, it } from 'vitest'
import {
  newDraftStage,
  stageMustStartAtOrAfter,
  stageStartOk,
} from '@/components/create/StageRulesEditor'

// A later ruleset's start: 0 keeps today's "next cycle boundary" encoding,
// N > 1 cycles or a date becomes an absolute mustStartAtOrAfter.
describe('later stage start', () => {
  const day = 86_400
  it('encodes one cycle as 0 and N cycles as an absolute boundary', () => {
    const stage = newDraftStage(false)
    expect(stageMustStartAtOrAfter(stage, 1_000, day)).toBe(0)
    expect(
      stageMustStartAtOrAfter({ ...stage, startCycles: '3' }, 1_000, day),
    ).toBe(1_000 + 3 * day)
  })
  it('encodes a date as its unix seconds', () => {
    const stage = {
      ...newDraftStage(false),
      startMode: 'date' as const,
      startDate: '2027-01-05T12:00',
    }
    expect(stageMustStartAtOrAfter(stage, 1_000, day)).toBe(
      Math.floor(new Date('2027-01-05T12:00').getTime() / 1000),
    )
    expect(stageStartOk(stage)).toBe(true)
    expect(stageStartOk({ ...stage, startDate: '' })).toBe(false)
    expect(stageStartOk({ ...newDraftStage(false), startCycles: '0' })).toBe(false)
    expect(stageStartOk({ ...newDraftStage(false), startCycles: '2.5' })).toBe(false)
  })
})
