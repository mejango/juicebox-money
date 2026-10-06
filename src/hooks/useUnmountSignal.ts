'use client'

import { useCallback, useEffect, useRef } from 'react'

/**
 * The signal of the flows a component starts: it aborts when the component
 * unmounts, which ends whatever they still wait for, such as a Safe's
 * execution of a proposal. Read it when a flow starts. Each mount has its own,
 * so React's development remount leaves a live one.
 */
export function useUnmountSignal(): () => AbortSignal {
  const mounted = useRef<AbortController | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    mounted.current = controller
    return () => controller.abort()
  }, [])
  return useCallback(() => mounted.current?.signal ?? AbortSignal.abort(), [])
}
