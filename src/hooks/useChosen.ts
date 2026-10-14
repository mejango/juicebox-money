'use client'

import { useCallback, useMemo, useState } from 'react'

/**
 * Where a key input came from: `typed` (the user edited it), `policy:<name>`
 * (the user picked an option, such as Max, Fit or keep current) or `auto` (the
 * app seeded or adjusted it).
 */
export type Provenance = 'typed' | 'auto' | `policy:${string}`

/**
 * A form value and its provenance. A write intent keys it by `key(typed)`:
 * the typed value, the policy's name, or `auto:<field>` for an untouched seed,
 * never a number the app filled in. So a retry after a balance, price or
 * holding moves is still the same action.
 */
export function useChosen<T>(initial: T, field: string, initialPolicy?: string) {
  const [state, setState] = useState<{ value: T; from: Provenance }>(() => ({
    value: initial,
    // A seed that stands for an option, such as a position's current holding (keep current).
    from: initialPolicy ? `policy:${initialPolicy}` : 'auto',
  }))
  /** The user edited it. */
  const set = useCallback((value: T) => setState({ value, from: 'typed' }), [])
  /** The user picked an option that fills it. */
  const choose = useCallback((policy: string, value: T) => setState({ value, from: `policy:${policy}` }), [])
  /** The app adjusted it: a policy stays the user's, a typed value no longer is. */
  const fill = useCallback(
    (value: T) => setState(current => ({ value, from: current.from === 'typed' ? 'auto' : current.from })),
    [],
  )
  /** The app seeded it afresh (a reset, a new position). */
  const seed = useCallback((value: T) => setState({ value, from: 'auto' }), [])
  const { value, from } = state
  const key = useCallback(
    <K,>(typed: K): K | string => (from === 'typed' ? typed : from === 'auto' ? `auto:${field}` : from),
    [from, field],
  )
  return useMemo(() => ({ value, from, set, choose, fill, seed, key }), [value, from, set, choose, fill, seed, key])
}
