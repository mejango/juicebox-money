'use client'

import { useCallback, useMemo, useState } from 'react'
import { decimalKey } from '@/lib/transaction-builders'

/**
 * Where a key input came from: `typed` (the user edited it), `policy:<name>`
 * (the user picked an option, such as Max, Fit or keep current) or `auto` (the
 * app seeded or adjusted it).
 */
type Provenance = 'typed' | 'auto' | `policy:${string}`

/**
 * A form value and its provenance. A write intent keys it by `key(typed)`:
 * the typed value, the policy's name, or `auto:<field>` for an untouched seed,
 * never a number the app filled in. So a retry after a balance, price or
 * holding moves is still the same action.
 */
type State<T> = { value: T; chosen: T; from: Provenance }

const bigintSafe = (_name: string, field: unknown) => (typeof field === 'bigint' ? `${field}n` : field)
/** The same content, field by field (a fresh but equal object is the same). */
const exact = (value: unknown) => JSON.stringify(value, bigintSafe)
/** A value as a key compares it: a typed decimal canonically ("1" is "1.0"), a record field by field. */
const canonical = (value: unknown) =>
  JSON.stringify(value, (name, field: unknown) => (typeof field === 'string' ? decimalKey(field) : bigintSafe(name, field)))
const sameState = <T,>(a: State<T>, b: State<T>) =>
  a.from === b.from && exact(a.value) === exact(b.value) && exact(a.chosen) === exact(b.chosen)

export function useChosen<T>(initial: T, field: string, initialPolicy?: string) {
  // `chosen` is what the user typed or picked; `value` is what is shown, which
  // the app may refill. A refill never changes the key.
  const [state, setState] = useState<State<T>>(() => ({
    value: initial,
    chosen: initial,
    // A seed that stands for an option, such as a position's current holding (keep current).
    from: initialPolicy ? `policy:${initialPolicy}` : 'auto',
  }))
  // The one update: an unchanged state is the current one, so React bails out
  // and an effect that sets the same value on every render settles.
  const update = useCallback((next: (current: State<T>) => State<T>) => {
    setState(current => {
      const proposed = next(current)
      return sameState(current, proposed) ? current : proposed
    })
  }, [])
  /**
   * The user edited it. Retyping what it already is ("100.0" for 100) keeps its
   * provenance and key: only a different value becomes typed.
   */
  const set = useCallback(
    (value: T) => update(current =>
      canonical(value) === canonical(current.value) ? { ...current, value } : { value, chosen: value, from: 'typed' }),
    [update],
  )
  /** The user picked an option that fills it. */
  const choose = useCallback(
    (policy: string, value: T) => update(() => ({ value, chosen: value, from: `policy:${policy}` })),
    [update],
  )
  /** The app adjusted what is shown: the user's choice, and so the key, stay as they were. */
  const fill = useCallback((value: T) => update(current => ({ ...current, value })), [update])
  /** The app seeded it afresh (a reset, a new position). */
  const seed = useCallback((value: T) => update(() => ({ value, chosen: value, from: 'auto' })), [update])
  const { value, chosen, from } = state
  /** The key: the user's typed value through `toKey`, the policy's name, or `auto:<field>`. */
  const key = useCallback(
    <K = T,>(toKey: (typed: T) => K = typed => typed as unknown as K): K | string =>
      from === 'typed' ? toKey(chosen) : from === 'auto' ? `auto:${field}` : from,
    [from, chosen, field],
  )
  return useMemo(() => ({ value, from, set, choose, fill, seed, key }), [value, from, set, choose, fill, seed, key])
}
