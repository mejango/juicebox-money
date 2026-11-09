'use client'

import { useEffect, useRef } from 'react'
import { useAccount, useConnect } from 'wagmi'
import { markParaSession, useParaAuth } from './ParaAuthContext'
import { signOutGeneration } from './para-logout'

/**
 * Bridges a newly settled Para modal into wagmi's `para` connector, once for
 * the app. The dynamic import is gated by sessionVersion so anonymous visits
 * never initialize Para's worker or session API.
 */
export function ParaSessionBridge() {
  const { isConnected } = useAccount()
  const { connectAsync, connectors } = useConnect()
  const { modalOpen, sessionVersion } = useParaAuth()
  const bridging = useRef(false)

  useEffect(() => {
    if (sessionVersion === 0) return
    const generation = signOutGeneration()
    if (modalOpen || isConnected || bridging.current || generation < 0) return
    bridging.current = true
    ;(async () => {
      try {
        const { getParaClient } = await import('./para-config')
        const loggedIn = await getParaClient().isFullyLoggedIn()
        // A sign-out that started during the check makes its answer stale.
        if (!loggedIn || signOutGeneration() !== generation) return
        const para = connectors.find(c => c.id === 'para')
        if (para) {
          await connectAsync({ connector: para })
          markParaSession(true)
        }
      } catch {
        // No Para session, or the user's Para env is unreachable: external
        // wallets still work.
      } finally {
        bridging.current = false
      }
    })()
  }, [modalOpen, sessionVersion, isConnected, connectors, connectAsync])

  return null
}
