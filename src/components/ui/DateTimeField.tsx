'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  localDateTimeInputToTimestamp,
  resolvedLocalTimeZone,
  supportedTimeZones,
  timestampToLocalDateTimeInput,
  timestampToZonedDateTimeInput,
  zonedDateTimeInputToTimestamp,
} from '@/lib/time-zone'

const LOCAL = 'local'
const STORAGE_KEY = 'jb-time-zone'
const CHANGE_EVENT = 'jb-time-zone-change'

function validTimeZone(value: string): boolean {
  if (value === LOCAL) return true
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format()
    return true
  } catch {
    return false
  }
}

function usePreferredTimeZone() {
  const [timeZone, setTimeZoneState] = useState(LOCAL)
  const [localTimeZone, setLocalTimeZone] = useState('')

  useEffect(() => {
    setLocalTimeZone(resolvedLocalTimeZone())
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored && validTimeZone(stored)) setTimeZoneState(stored)
    } catch {
      // Storage unavailable: keep this browser's local timezone.
    }
    const sync = (event: Event) => {
      const value = (event as CustomEvent<string>).detail
      if (validTimeZone(value)) setTimeZoneState(value)
    }
    window.addEventListener(CHANGE_EVENT, sync)
    return () => window.removeEventListener(CHANGE_EVENT, sync)
  }, [])

  const setTimeZone = (value: string) => {
    if (!validTimeZone(value)) return
    setTimeZoneState(value)
    try {
      localStorage.setItem(STORAGE_KEY, value)
    } catch {
      // The in-memory selection still works when storage is unavailable.
    }
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: value }))
  }

  return { timeZone, localTimeZone, setTimeZone }
}

export function DateTimeField({
  value,
  onChange,
  min,
  disabled = false,
  inputClassName,
  wrapperClassName,
  ariaLabel,
}: {
  value: string
  onChange: (value: string) => void
  min?: string
  disabled?: boolean
  inputClassName: string
  wrapperClassName?: string
  ariaLabel: string
}) {
  const { timeZone, localTimeZone, setTimeZone } = usePreferredTimeZone()
  const effectiveTimeZone = timeZone === LOCAL ? localTimeZone : timeZone
  const zones = useMemo(() => supportedTimeZones(), [])

  const inSelectedZone = (localValue: string | undefined) => {
    if (!localValue || timeZone === LOCAL || !effectiveTimeZone) return localValue ?? ''
    const timestamp = localDateTimeInputToTimestamp(localValue)
    return timestamp === null
      ? ''
      : timestampToZonedDateTimeInput(timestamp, effectiveTimeZone)
  }

  return (
    <div className={wrapperClassName}>
      <input
        type="datetime-local"
        value={inSelectedZone(value)}
        min={inSelectedZone(min)}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={event => {
          if (timeZone === LOCAL || !effectiveTimeZone) {
            onChange(event.target.value)
            return
          }
          const timestamp = zonedDateTimeInputToTimestamp(
            event.target.value,
            effectiveTimeZone,
          )
          if (timestamp !== null) onChange(timestampToLocalDateTimeInput(timestamp))
        }}
        className={inputClassName}
      />
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-smoke-600">
        <span>Time shown in</span>
        <select
          value={timeZone}
          onChange={event => setTimeZone(event.target.value)}
          disabled={disabled}
          aria-label={`${ariaLabel} timezone`}
          className="select-caret min-h-[30px] max-w-full rounded-md border border-smoke-200 bg-white py-1 pl-2 pr-7 text-[11px] text-smoke-700 hover:border-smoke-400 disabled:opacity-60"
        >
          <option value={LOCAL}>
            {localTimeZone ? `${localTimeZone} (local)` : 'Local timezone'}
          </option>
          {localTimeZone !== 'UTC' ? <option value="UTC">UTC</option> : null}
          {zones
            .filter(zone => zone !== localTimeZone && zone !== 'UTC')
            .map(zone => (
              <option key={zone} value={zone}>
                {zone.replaceAll('_', ' ')}
              </option>
            ))}
        </select>
      </div>
    </div>
  )
}
