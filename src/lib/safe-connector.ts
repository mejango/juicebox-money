'use client'

import { useSyncExternalStore } from 'react'
import type { Address, Hex } from 'viem'
import type { Config } from 'wagmi'
import { getAccount, getPublicClient } from 'wagmi/actions'
import {
  isSafeWalletPeer,
  safeExecutionResult,
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
  swapDeadline,
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

/** What a Safe app flow says when it cannot confirm its proposal ran. */
export const SAFE_PROPOSAL_UNCONFIRMED =
  'Safe proposal submitted, but confirmation is unavailable. Check Safe before taking another action.'

/**
 * Throws unless the execution's receipt proves `safe` ran the proposal the
 * wallet returned and its call succeeded ({@link safeExecutionResult}):
 * `failure` when the Safe ran it and it failed, and SAFE_PROPOSAL_UNCONFIRMED
 * when the receipt does not show this proposal ran. `proposalHash` is the
 * safeTxHash, or, when Safe{Wallet} executed at once, the execution's own hash.
 */
export function requireSafeProposalSuccess(
  receipt: Parameters<typeof safeExecutionResult>[0],
  safe: Address,
  proposalHash: Hex,
  failure: string,
): void {
  const { status } = safeExecutionResult(receipt, safe, proposalHash)
  if (status === 'unproven') throw new Error(SAFE_PROPOSAL_UNCONFIRMED)
  if (status !== 'success') throw new Error(failure)
}

/**
 * The SDK's wait, reading the chain as well: Safe{Wallet} over WalletConnect
 * replies with the execution's own hash when the owner executes at once. An
 * explicit `client` wins.
 */
export function waitForSafeExecutionHash(
  chainId: number,
  safeTxHash: Hex,
  options: NonNullable<Parameters<typeof waitForExecution>[2]> = {},
): Promise<Hex> {
  const config = getWatchedConfig()
  return waitForExecution(chainId, safeTxHash, {
    ...options,
    client: options.client ?? (config && getPublicClient(config, { chainId })),
  })
}
