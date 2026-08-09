const DATE_TIME_INPUT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/u

type DateTimeParts = {
  year: number
  month: number
  day: number
  hour: number
  minute: number
}

function inputParts(value: string): DateTimeParts | null {
  const match = DATE_TIME_INPUT.exec(value)
  if (!match) return null
  const [, year, month, day, hour, minute] = match
  return {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: Number(hour),
    minute: Number(minute),
  }
}

function partsAsUtc(parts: DateTimeParts): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute)
}

function zonedParts(timestampMs: number, timeZone: string): DateTimeParts | null {
  try {
    const values = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(timestampMs))
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      Number(values.find(value => value.type === type)?.value)
    const result = {
      year: part('year'),
      month: part('month'),
      day: part('day'),
      hour: part('hour'),
      minute: part('minute'),
    }
    return Object.values(result).every(Number.isFinite) ? result : null
  } catch {
    return null
  }
}

function inputFromParts(parts: DateTimeParts): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`
}

export function resolvedLocalTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

export function supportedTimeZones(): string[] {
  try {
    const supportedValuesOf = (
      Intl as typeof Intl & {
        supportedValuesOf?: (key: 'timeZone') => string[]
      }
    ).supportedValuesOf
    return supportedValuesOf ? supportedValuesOf('timeZone') : []
  } catch {
    return []
  }
}

/** Format an instant as the wall-clock value expected by datetime-local. */
export function timestampToZonedDateTimeInput(
  timestampMs: number,
  timeZone: string,
): string {
  const parts = zonedParts(timestampMs, timeZone)
  return parts ? inputFromParts(parts) : ''
}

/**
 * Interpret a datetime-local wall clock in an IANA timezone. Iterating the
 * formatted delta handles offsets with half-hours and daylight-saving changes.
 * Non-existent DST wall clocks are rejected instead of silently moving time.
 */
export function zonedDateTimeInputToTimestamp(
  value: string,
  timeZone: string,
): number | null {
  const desired = inputParts(value)
  if (!desired) return null
  const target = partsAsUtc(desired)
  let candidate = target

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = zonedParts(candidate, timeZone)
    if (!actual) return null
    const delta = target - partsAsUtc(actual)
    if (delta === 0) return candidate
    candidate += delta
  }

  const actual = zonedParts(candidate, timeZone)
  return actual && partsAsUtc(actual) === target ? candidate : null
}

export function localDateTimeInputToTimestamp(value: string): number | null {
  const timestamp = new Date(value).getTime()
  return Number.isFinite(timestamp) ? timestamp : null
}

export function timestampToLocalDateTimeInput(timestampMs: number): string {
  const date = new Date(timestampMs)
  if (!Number.isFinite(date.getTime())) return ''
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}
