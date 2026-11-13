import { describe, expect, it } from 'vitest'
import { rulesChangeLine } from '@/components/project/RulesChangeNotice'

describe('rules change notice above the pay card', () => {
  it('counts down to a queued ruleset that differs from the current one', () => {
    expect(rulesChangeLine(10, { id: 11, start: 1_000 + 7_200 }, 1_000)).toMatch(/^Rules change in 2h \(/)
  })
  it('says the change waits for the cycle when the start has passed', () => {
    expect(rulesChangeLine(10, { id: 11, start: 900 }, 1_000)).toBe('Rules change when the queued cycle starts')
  })
  it('stays silent when nothing distinct is queued or a read is missing', () => {
    expect(rulesChangeLine(10, { id: 0, start: 5_000 }, 1_000)).toBeNull()
    expect(rulesChangeLine(10, { id: 10, start: 5_000 }, 1_000)).toBeNull()
    expect(rulesChangeLine(undefined, { id: 11, start: 5_000 }, 1_000)).toBeNull()
    expect(rulesChangeLine(10, undefined, 1_000)).toBeNull()
  })
})
