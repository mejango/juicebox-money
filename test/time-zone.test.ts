import {
  timestampToZonedDateTimeInput,
  zonedDateTimeInputToTimestamp,
} from '@/lib/time-zone'
import { describe, expect, it } from 'vitest'

describe('timezone-aware datetime inputs', () => {
  it('formats an instant in the selected timezone', () => {
    const timestamp = Date.parse('2026-08-08T12:30:00Z')
    expect(timestampToZonedDateTimeInput(timestamp, 'America/New_York')).toBe(
      '2026-08-08T08:30',
    )
    expect(timestampToZonedDateTimeInput(timestamp, 'Asia/Kolkata')).toBe(
      '2026-08-08T18:00',
    )
  })

  it('turns a selected-zone wall clock back into the same instant', () => {
    expect(
      zonedDateTimeInputToTimestamp(
        '2026-08-08T08:30',
        'America/New_York',
      ),
    ).toBe(Date.parse('2026-08-08T12:30:00Z'))
    expect(
      zonedDateTimeInputToTimestamp('2026-08-08T18:00', 'Asia/Kolkata'),
    ).toBe(Date.parse('2026-08-08T12:30:00Z'))
  })

  it('rejects a wall clock skipped by daylight saving time', () => {
    expect(
      zonedDateTimeInputToTimestamp(
        '2026-03-08T02:30',
        'America/New_York',
      ),
    ).toBeNull()
  })
})
