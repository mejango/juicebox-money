'use client'

import { useModal } from '@getpara/react-sdk-lite'
import { useEffect, useRef } from 'react'
import type { Address } from 'viem'
import { useAccount, useConnect, useDisconnect } from 'wagmi'
import { paraClient } from '@/providers/Providers'

/**
 * Wallet state with wagmi as the single source of truth.
 *
 * - External wallets connect straight through wagmi connectors (see the
 *   `connectors` list — WalletButton renders them as options).
 * - Embedded (email/social) sign-in opens the Para modal; when the Para
 *   session appears, the bridge effect below connects wagmiConfig's `para`
 *   connector so the embedded wallet behaves like any other connection.
 */
export function useWallet() {
  const { address, isConnected } = useAccount()
  const { connectAsync, connectors } = useConnect()
  const { disconnect: wagmiDisconnect } = useDisconnect()
  const { isOpen, openModal } = useModal()
  const bridging = useRef(false)

  // Bridge Para embedded sessions into wagmi. Runs on mount (session persisted
  // from a previous visit) and whenever the Para modal closes (fresh login).
  useEffect(() => {
    if (isOpen || isConnected || bridging.current) return
    bridging.current = true
    ;(async () => {
      try {
        const loggedIn = await paraClient.isFullyLoggedIn()
        if (!loggedIn) return
        const para = connectors.find(c => c.id === 'para')
        if (para) await connectAsync({ connector: para })
      } catch {
        // No Para session, or the user's Para env is unreachable — external
        // wallets still work.
      } finally {
        bridging.current = false
      }
    })()
  }, [isOpen, isConnected, connectors, connectAsync])

  return {
    isConnected,
    address: address as Address | undefined,
    /** Wallet connectors the user can pick from (excludes the Para bridge).
     *  Configured connectors and EIP-6963 browser discovery can both surface
     *  the same wallet — dedupe by display name, keeping the first. */
    connectors: connectors
      .filter(c => c.id !== 'para')
      .filter((c, i, arr) => arr.findIndex(x => x.name === c.name) === i),
    /** Connect a specific external wallet connector. */
    connectWith: (connectorId: string) => {
      const connector = connectors.find(c => c.id === connectorId)
      if (connector) return connectAsync({ connector })
      return Promise.reject(new Error('Unknown wallet'))
    },
    /** Open the Para email/social sign-in modal. */
    openSignIn: () => openModal(),
    disconnect: () => {
      wagmiDisconnect()
      paraClient.logout().catch(() => {})
    },
  }
}
