'use client'

import type { Address } from 'viem'
import { useAccount, useConnect, useDisconnect } from 'wagmi'
import { IS_DETERMINISTIC_BROWSER } from '@/providers/Providers'
import { offerableWallets } from '@/lib/wallet-list'
import { useParaAuth } from '@/providers/ParaAuthContext'
import { logoutParaSession, signOutOnce } from '@/providers/para-logout'

/**
 * Wallet state with wagmi as the single source of truth.
 *
 * - External wallets connect straight through wagmi connectors (see the
 *   `connectors` list — WalletButton renders them as options).
 * - Embedded (email/social) sign-in opens the Para modal; when the Para
 *   session appears, ParaSessionBridge connects wagmiConfig's `para`
 *   connector so the embedded wallet behaves like any other connection.
 */
export function useWallet() {
  const { address, isConnected } = useAccount()
  const { connectAsync, connectors } = useConnect()
  const { disconnectAsync: wagmiDisconnect } = useDisconnect()
  const { requestSignIn } = useParaAuth()

  return {
    isConnected,
    address: address as Address | undefined,
    /**
     * A Juicebox Center wallet, which pays through its own review and cannot
     * send these writes. Homerun and Sticky offer one; this app does not.
     */
    isCenterWallet: false,
    /** Wallet connectors the user can pick from (excludes the Para bridge,
     *  the redundant injected fallback, and duplicate names). */
    connectors: offerableWallets(connectors),
    /** Connect a specific external wallet connector. */
    connectWith: (connectorId: string) => {
      const connector = connectors.find(c => c.id === connectorId)
      if (connector) return connectAsync({ connector })
      return Promise.reject(new Error('Unknown wallet'))
    },
    /** Open the Para email/social sign-in modal. */
    openSignIn: () => {
      if (!IS_DETERMINISTIC_BROWSER) requestSignIn()
    },
    disconnect: () => signOutOnce(() => IS_DETERMINISTIC_BROWSER
      ? wagmiDisconnect()
      : logoutParaSession(wagmiDisconnect)),
  }
}
