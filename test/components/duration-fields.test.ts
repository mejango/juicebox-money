import { describe, expect, it } from 'vitest'
import { durationFields, durationFieldsSeconds, stageDurationSeconds, type DurationFields } from '@/components/create/stage-draft'
import { FOREVER_SECONDS } from '@/lib/launch'

const custom = (customDuration: string, customUnit: DurationFields['customUnit']): DurationFields => ({ durationValue: 'custom', customDuration, customUnit })

describe('cycle length fields', () => {
  it('reads presets, flexible and forever as their seconds', () => {
    expect(durationFieldsSeconds({ durationValue: '0', customDuration: '', customUnit: 'days' })).toBe(0)
    expect(durationFieldsSeconds({ durationValue: '604800', customDuration: '9', customUnit: 'years' })).toBe(604_800)
    expect(durationFieldsSeconds({ durationValue: String(FOREVER_SECONDS), customDuration: '', customUnit: 'days' })).toBe(FOREVER_SECONDS)
  })
  it('reads a custom length in its unit and refuses one a ruleset cannot hold', () => {
    expect(durationFieldsSeconds(custom('1.5', 'hours'))).toBe(5_400)
    expect(durationFieldsSeconds(custom('2', 'weeks'))).toBe(1_209_600)
    expect(durationFieldsSeconds(custom('136', 'years'))).toBe(4_288_896_000)
    for (const bad of [custom('', 'days'), custom(' ', 'days'), custom('0', 'days'), custom('-1', 'days'), custom('abc', 'days'), custom('0.0001', 'hours'), custom('137', 'years')]) {
      expect(durationFieldsSeconds(bad)).toBeNull()
      // The create form reads an incomplete custom length as unset and blocks the stage on it.
      expect(stageDurationSeconds({ ...bad } as Parameters<typeof stageDurationSeconds>[0])).toBe(0)
    }
  })
  it('shows any length the protocol holds and reads the same seconds back', () => {
    expect(durationFields(0)).toMatchObject({ durationValue: '0' })
    expect(durationFields(30 * 86_400)).toMatchObject({ durationValue: String(30 * 86_400) })
    expect(durationFields(FOREVER_SECONDS)).toMatchObject({ durationValue: String(FOREVER_SECONDS) })
    expect(durationFields(2 * 31_536_000)).toEqual(custom('2', 'years'))
    expect(durationFields(5 * 604_800)).toEqual(custom('5', 'weeks'))
    expect(durationFields(10 * 86_400)).toEqual(custom('10', 'days'))
    expect(durationFields(5_400)).toEqual(custom('1.5', 'hours'))
    for (const seconds of [1, 59, 100, 3_601, 86_401, 4_294_967_294]) {
      expect(durationFieldsSeconds(durationFields(seconds)!)).toBe(seconds)
    }
  })
})
