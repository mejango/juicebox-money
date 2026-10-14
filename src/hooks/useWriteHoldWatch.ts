'use client'

import { useCallback, useEffect, useRef } from 'react'
import type { WriteHoldClient, WriteHoldHandle, WriteHoldState } from '@bananapus/nana-sdk-core/review'

/** How often a shown hold is asked again, so an exit that becomes due with time appears. */
const HOLD_RECHECK_MS = 60_000

/**
 * Keep a shown write hold current: every state it reports (this tab's,
 * another tab's, its own follow's) reaches `onState`, and it is asked again
 * every minute while `hold` is given, so an exit that becomes due with time
 * appears. An exit is offered only from a fresh look at the chain: the SDK
 * replays and reports other tabs' changes without one. `checkNow` also asks
 * once at once. Returns a recheck for after a manual check.
 */
export function useWriteHoldWatch(
  hold: WriteHoldHandle | undefined,
  client: WriteHoldClient | undefined,
  onState: (state: WriteHoldState) => void,
  { checkNow = false }: { checkNow?: boolean } = {},
): () => void {
  const onStateRef = useRef(onState)
  const clientRef = useRef(client)
  useEffect(() => {
    onStateRef.current = onState
    clientRef.current = client
  })
  const recheckRef = useRef<() => void>(() => {})
  useEffect(() => {
    if (!hold) return
    let live = true
    const stop = hold.subscribe(state => onStateRef.current(state))
    const check = () => {
      const current = clientRef.current
      if (!current) return
      void hold.state(current).then(state => { if (live) onStateRef.current(state) }, () => {})
    }
    recheckRef.current = check
    if (checkNow) check()
    const timer = setInterval(check, HOLD_RECHECK_MS)
    return () => {
      live = false
      stop()
      clearInterval(timer)
      recheckRef.current = () => {}
    }
  }, [hold, checkNow])
  return useCallback(() => recheckRef.current(), [])
}
