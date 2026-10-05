'use client'

import { useSyncExternalStore } from 'react'
import { decodeFunctionData, isAddressEqual, type Address, type Hex } from 'viem'
import type { Config } from 'wagmi'
import { getAccount, getPublicClient } from 'wagmi/actions'
import { multiSendCallsOf } from '@bananapus/nana-sdk-core/safe'
import {
  isSafeWalletPeer,
  SAFE_EXEC_ABI,
  safeExecutionResult,
  type SafeExecutionResult,
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

/** What a Safe app flow says while its proposal waits for the Safe's other signers. */
export const SAFE_PROPOSAL_AWAITING =
  'Proposed to your Safe. Its other signers can approve it there.'

/** A call a Safe app proposal was reviewed to run. */
export type SafeAppCall = { to: Address; data: Hex; value?: bigint }

type SafeAppExecution = {
  /** Reads the execution's transaction, which only an execution returned at once needs. */
  client: { getTransaction(args: { hash: Hex }): Promise<{ to?: Address | null; input: Hex }> }
  receipt: Parameters<typeof safeExecutionResult>[0]
  safe: Address
  /** What the wallet returned: the safeTxHash, or the execution's own hash when Safe{Wallet} executed at once. */
  proposalHash: Hex
  /** What the proposal was reviewed to run: one call, or a batch in order. */
  calls: readonly SafeAppCall[]
}

/**
 * Whether `transaction` is `safe`'s execTransaction of exactly `calls`: the
 * one call as a CALL, or every call in order through MultiSendCallOnly.
 */
function runsCalls(
  transaction: { to?: Address | null; input: Hex },
  safe: Address,
  calls: readonly SafeAppCall[],
): boolean {
  if (!transaction.to || !isAddressEqual(transaction.to, safe)) return false
  let decoded: ReturnType<typeof decodeFunctionData<typeof SAFE_EXEC_ABI>>
  try {
    decoded = decodeFunctionData({ abi: SAFE_EXEC_ABI, data: transaction.input })
  } catch {
    return false
  }
  if (decoded.functionName !== 'execTransaction') return false
  const [to, value, data, operation] = decoded.args
  const ran =
    operation === 0
      ? [{ to, value, data }]
      : value === 0n
        ? multiSendCallsOf({ to, data, operation })
        : null
  return (
    !!ran &&
    ran.length === calls.length &&
    ran.every(
      (call, index) =>
        isAddressEqual(call.to, calls[index].to) &&
        call.value === (calls[index].value ?? 0n) &&
        call.data.toLowerCase() === calls[index].data.toLowerCase(),
    )
  )
}

/**
 * What the execution's receipt proves about the proposal a Safe app returned
 * ({@link safeExecutionResult}). When Safe{Wallet} executed it at once, the
 * reply is the execution's own hash and the SDK takes the Safe's one
 * execution event in that receipt whatever its safeTxHash, so the execution
 * must also be the Safe's execTransaction of exactly the reviewed calls, or
 * the result is unproven.
 */
export async function readSafeAppExecution({
  client,
  receipt,
  safe,
  proposalHash,
  calls,
}: SafeAppExecution): Promise<SafeExecutionResult> {
  const result = safeExecutionResult(receipt, safe, proposalHash)
  const atOnce =
    typeof receipt.transactionHash === 'string' &&
    receipt.transactionHash.toLowerCase() === proposalHash.toLowerCase()
  if (!atOnce || (result.status !== 'success' && result.status !== 'failed')) {
    return result
  }
  const transaction = await client.getTransaction({ hash: proposalHash }).catch(() => null)
  return transaction && runsCalls(transaction, safe, calls)
    ? result
    : {
        status: 'unproven',
        reason: `Transaction ${proposalHash} is not Safe ${safe}'s execution of the reviewed call.`,
      }
}

/**
 * Throws unless the execution proves the Safe ran the reviewed proposal and
 * its call succeeded ({@link readSafeAppExecution}): `failure` when the Safe
 * ran it and it failed, and SAFE_PROPOSAL_UNCONFIRMED when it does not show
 * this proposal ran.
 */
export async function requireSafeProposalSuccess(
  execution: SafeAppExecution,
  failure: string,
): Promise<void> {
  const { status } = await readSafeAppExecution(execution)
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
