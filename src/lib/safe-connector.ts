'use client'

import { useSyncExternalStore } from 'react'
import type { Hex } from 'viem'
import type { Config } from 'wagmi'
import { getAccount, getPublicClient } from 'wagmi/actions'
import {
  isSafeWalletPeer,
  waitForSafeExecutionHash as waitForExecution,
} from '@bananapus/nana-sdk-core/safe-service'
import {
  getWalletConnectPeerUrl,
  getWatchedConfig,
  subscribeWalletConnectPeer,
} from '@/lib/safe-wallet-peer'

export {
  SAFE_NONCE_GUIDANCE,
  SAFE_PREFIX,
  SAFE_PROPOSAL_AWAITING,
  SAFE_PROPOSAL_UNCONFIRMED,
  atOnceExecution,
  chainAnswer,
  findPendingSafeAppProposal,
  heldCall,
  lookAtSafeProposal,
  readSafeAppExecution,
  reportedSafeExecution,
  requireSafeProposalSuccess,
  stampedDeadline,
  swapDeadline,
  watchSafeProposal,
  type SafeAppCall,
} from '@bananapus/nana-sdk-core/safe-service'

/**
 * Whether the connected wallet proposes to a Safe rather than sending: the
 * Safe app, or Safe{Wallet} over WalletConnect, which answers the same way.
 */
export function isSafeConnection(config: Config): boolean {
  try {
    const id = getAccount(config).connector?.id
    return (
      id === 'safe' ||
      (id === 'walletConnect' && isSafeWalletPeer(getWalletConnectPeerUrl()))
    )
  } catch {
    return false
  }
}

/** isSafeConnection for rendering: it renders again once the WalletConnect peer is known. */
export function useSafeConnection(config: Config): boolean {
  return useSyncExternalStore(
    subscribeWalletConnectPeer,
    () => isSafeConnection(config),
    () => false,
  )
}

type SafeExecutionWait = Omit<NonNullable<Parameters<typeof waitForExecution>[2]>, 'signal'> & {
  /**
   * The flow's: the page or dialog that waits. When it aborts, the wait ends
   * at once with an AbortError and the proposal stays submitted, its
   * execution unknown. The SDK's wait has no end of its own while Safe's
   * service lists the proposal unexecuted, or while a node can't say whether
   * the chain knows it.
   */
  signal: AbortSignal
  /** Ends the wait after this long too, for a flow that looks once and says the proposal is still pending. */
  lookMs?: number
}

/**
 * The SDK's wait, reading the chain as well: Safe{Wallet} over WalletConnect
 * replies with the execution's own hash when the owner executes at once. An
 * explicit `client` wins.
 */
export async function waitForSafeExecutionHash(
  chainId: number,
  safeTxHash: Hex,
  { signal, lookMs, ...options }: SafeExecutionWait,
): Promise<Hex> {
  const config = getWatchedConfig()
  const client = options.client ?? (config && getPublicClient(config, { chainId }))
  if (lookMs === undefined) return waitForExecution(chainId, safeTxHash, { ...options, client, signal })
  // The look ends with the flow, or after lookMs, whichever is first.
  const look = new AbortController()
  const end = () => look.abort()
  const timer = setTimeout(end, lookMs)
  signal.addEventListener('abort', end, { once: true })
  if (signal.aborted) end()
  try {
    return await waitForExecution(chainId, safeTxHash, { ...options, client, signal: look.signal })
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', end)
  }
}
