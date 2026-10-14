'use client'

import { useCallback, useState } from 'react'

/**
 * An amount field and how the user chose it: typed, or Max (all of it). A write
 * intent keys Max as `'max'`, never the number it filled, so a retry after the
 * balance moves is still the same action.
 */
export function useChosenAmount() {
  const [amount, setValue] = useState('')
  const [max, setMax] = useState(false)
  const setAmount = useCallback((value: string) => {
    setValue(value)
    setMax(false)
  }, [])
  const fillMax = useCallback((value: string) => {
    setValue(value)
    setMax(true)
  }, [])
  return { amount, setAmount, max, fillMax }
}

/** The amount a write intent keys: `'max'` when the user chose Max, else the typed amount. */
export const intentAmount = (max: boolean, amount: bigint): bigint | 'max' => (max ? 'max' : amount)
