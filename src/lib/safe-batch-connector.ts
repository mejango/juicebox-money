'use client'

import { getAccount } from '@wagmi/core'
import type { Abi, Address, Hex } from 'viem'
import type { JBChainId } from '@bananapus/nana-sdk-core'
import { writeHolds } from '@/lib/write-holds'
import { encodeMultiSend, MULTI_SEND_CALL_ONLY } from '@bananapus/nana-sdk-core/safe'
import { wagmiConfig } from '@/providers/Providers'
import type { BatchCall } from '@/lib/safe-batch'
import { SAFE_NONCE_GUIDANCE } from '@/lib/safe-connector'
import { loadReviewEngine } from '@/lib/preload-review'
import { reviewedSendDeps } from '@/lib/reviewed-send'
import { assertNoViewAs } from '@/lib/viewAs'
import { assertReviewedAccountConnected } from '@/lib/wallet-context'

const SAFE_CONNECTION_CHANGED = 'Safe connection changed. Review this batch again.'

/** One call of an ordered batch, with what the review needs to decode it. */
export type SequenceCall = BatchCall & {
  label: string
  /** Needs an earlier call's effect (an allowance, a hook), so it cannot simulate alone. */
  dependsOnPrior?: boolean
  abi?: Abi
  functionName?: string
  args?: readonly unknown[]
  contractName?: string
}

/**
 * The write hold over a Safe batch: by the user's intent, with the whole batch
 * (its MultiSendCallOnly call) as the hold's call, so another batch that only
 * shares a call is never held by it.
 */
export function safeBatchHold({ chainId, safe, intent, calls, legacy = [] }: {
  chainId: JBChainId; safe: Address; intent: string; calls: readonly BatchCall[]
  /** The namespaces the last release keyed this batch by (legacy-intents). */
  legacy?: readonly string[]
}) {
  return writeHolds.open({
    chainId, account: safe, safe: true, namespace: intent,
    call: { to: MULTI_SEND_CALL_ONLY, data: encodeMultiSend(calls), value: 0n },
  }, { legacy: [...legacy] })
}

/**
 * A Safe app connection's batch as one MultiSend proposal, through core: the
 * sequence is simulated and every call reviewed once. Resolves with the
 * safeTxHash once Safe has queued the proposal; a flow that needs its
 * execution waits for it.
 */
export async function proposeSafeBatch({
  chainId,
  safe,
  calls: given,
  title,
  intent,
  legacy = [],
}: {
  chainId: JBChainId
  safe: Address
  calls: readonly SequenceCall[]
  title: string
  /**
   * The write hold key of the user's intent (writeIntentKey): the batch is held
   * by it from just before the wallet opens until the hold settles it, so a
   * retry with regenerated deadlines or expirations waits for the exit.
   */
  intent: string
  /** The namespaces the last release keyed this batch by: an attempt it left unresolved still holds it. */
  legacy?: readonly string[]
}): Promise<Hex> {
  assertNoViewAs()
  // Each field read once: simulation, review, hold and proposal all use this copy, never the caller's array.
  const calls: readonly SequenceCall[] = Object.freeze(given.map(({ to, data, value, label, dependsOnPrior, abi, functionName, args, contractName }) =>
    Object.freeze({ to, data, value, label, dependsOnPrior, abi, functionName, args, contractName })))
  if (!calls.length) throw new Error('A batch needs at least one call.')
  // The batch was reviewed for this Safe: refuse before simulating or
  // reviewing it when the wallet is connected as another account.
  assertReviewedAccountConnected(safe, getAccount(wagmiConfig).address, SAFE_CONNECTION_CHANGED)
  // Core simulates the sequence, reviews every call once and proposes them as one MultiSend under this hold key.
  const { sendReviewed } = await loadReviewEngine()
  const result = await sendReviewed({
    account: safe,
    batch: true,
    title,
    description: `These ${calls.length} calls continue in Safe as one MultiSend proposal, in the displayed order. ${SAFE_NONCE_GUIDANCE}`,
    confirmLabel: 'Agree & propose to Safe',
    guard: assertNoViewAs,
    calls: calls.map((call, index) => ({
      chainId, to: call.to, data: call.data, value: call.value, label: call.label,
      abi: call.abi, functionName: call.functionName, args: call.args, contractName: call.contractName,
      dependsOnPrior: call.dependsOnPrior,
      ...(index === 0 ? { intent, legacy: [...legacy] } : {}),
    })),
  }, reviewedSendDeps)
  if (result.status !== 'proposed') throw new Error('Check this proposal in your Safe before sending it again.')
  return result.safeTxHash
}
