'use client'

import type { Config } from 'wagmi'
import { getAccount } from 'wagmi/actions'
import type { Address, Hex } from 'viem'

const SAFE_PREFIX: Partial<Record<number, string>> = {
  1: 'eth',
  10: 'oeth',
  8453: 'base',
  42161: 'arb1',
  11155111: 'sep',
  11155420: 'opsepolia',
  84532: 'basesep',
  421614: 'arb1-sep',
}

export const SAFE_NONCE_GUIDANCE =
  'On Safe’s confirmation screen, Nonce defaults to the next available value. Open its dropdown to see queued nonces and replace one if desired.'

export function isSafeConnection(config: Config): boolean {
  try {
    const connector = getAccount(config).connector
    return `${connector?.id ?? ''} ${connector?.name ?? ''}`
      .toLowerCase()
      .includes('safe')
  } catch {
    return false
  }
}

/** Swap/mint execution deadline seconds: 20 minutes for an EOA, whose review
 *  and signature are one sitting. */
export const SWAP_DEADLINE_SECONDS = 20 * 60
/** Safe deadline seconds: co-signer collection routinely outlives 20 minutes,
 *  so match the 30-day Permit2 approval windows. The longer window widens MEV
 *  exposure only within the swap's already-frozen slippage floor. */
export const SAFE_SWAP_DEADLINE_SECONDS = 30 * 24 * 60 * 60

/** The unix deadline for a swap/liquidity transaction proposed now. */
export function swapDeadline(isSafe: boolean, nowMs: number = Date.now()): bigint {
  return BigInt(
    Math.floor(nowMs / 1000) +
      (isSafe ? SAFE_SWAP_DEADLINE_SECONDS : SWAP_DEADLINE_SECONDS),
  )
}

export function safeQueueUrl(chainId: number, safe: Address): string | null {
  const prefix = SAFE_PREFIX[chainId]
  return prefix
    ? `https://app.safe.global/transactions/queue?safe=${prefix}:${safe}`
    : null
}

/**
 * Resolve a Safe proposal identifier to its actual onchain execution hash.
 * A safeTxHash is not a transaction hash and must never be receipt-polled.
 */
export async function waitForSafeExecutionHash(
  chainId: number,
  safeTxHash: Hex,
  options: { pollingIntervalMs?: number; signal?: AbortSignal } = {},
): Promise<Hex> {
  const prefix = SAFE_PREFIX[chainId]
  if (!prefix) throw new Error(`Safe transaction tracking is unavailable on chain ${chainId}.`)
  const interval = options.pollingIntervalMs ?? 5_000
  const endpoint =
    `https://api.safe.global/tx-service/${prefix}/api/v1/multisig-transactions/${safeTxHash}/`

  for (;;) {
    if (options.signal?.aborted) {
      throw new DOMException('Safe execution wait aborted', 'AbortError')
    }
    try {
      const response = await fetch(endpoint)
      if (response.ok) {
        const transaction = (await response.json()) as {
          isExecuted?: boolean
          isSuccessful?: boolean | null
          transactionHash?: Hex | null
        }
        if (transaction.isExecuted && transaction.isSuccessful === false) {
          throw new Error('Safe executed the proposal, but the onchain transaction failed.')
        }
        if (transaction.isExecuted && transaction.transactionHash) {
          return transaction.transactionHash
        }
      }
    } catch (error) {
      if (
        error instanceof Error &&
        /executed the proposal.*failed/i.test(error.message)
      ) {
        throw error
      }
      // Service/network failures are transient. Keep the already-created
      // proposal pending instead of inviting a duplicate submission.
    }
    await new Promise<void>((resolve, reject) => {
      function onAbort() {
        window.clearTimeout(timer)
        reject(new DOMException('Safe execution wait aborted', 'AbortError'))
      }
      const timer = window.setTimeout(() => {
        options.signal?.removeEventListener('abort', onAbort)
        resolve()
      }, interval)
      options.signal?.addEventListener('abort', onAbort, { once: true })
      if (options.signal?.aborted) onAbort()
    })
  }
}
