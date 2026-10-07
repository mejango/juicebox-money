'use client'

import { getAccount } from '@wagmi/core'
import { decodeFunctionData, isAddress, zeroAddress, type Address } from 'viem'
import type { JBChainId } from '@bananapus/nana-sdk-core'
import { SAFE_EXEC_ABI } from '@bananapus/nana-sdk-core/safe-service'
import { relayrRecordChain, type RelayrEntry, type RelayrTransactionBinding, type RelayrTransactionRecord } from '@bananapus/nana-sdk-core/review/relayr'
import {
  createSafeRelayrController,
  SafeRelayrRecoveryError,
  type SafeRelayrExecution,
  type SafeRelayrSession,
} from '@bananapus/nana-sdk-core/review/safe-relayr'
import { wagmiConfig } from '@/providers/Providers'
import { queuedSafeReviewCall } from '@/lib/safe-queue-review'
import { requireTransactionReview } from '@/lib/transaction-review'
import {
  hasRelayrPendingEvidence,
  loadRelayrPendingSession,
  relayrChainClient,
  relayrPay,
  saveRelayrPendingSessionDurably,
  withRelayrScopeLock,
  type RelayrPendingSession,
  type RelayrSafeExecutionProof,
} from '@/lib/relayr'

/** Old quotes paired IDs by position; their known per-chain records recover the exact binding. */
export function legacySafeRelayrBindings(entries: readonly RelayrEntry[], proofs: readonly RelayrSafeExecutionProof[], records: readonly RelayrTransactionRecord[]): RelayrTransactionBinding[] {
  const quotedIds = new Set(proofs.map(proof => proof.txUuid.toLowerCase()))
  return entries.map(entry => {
    const proof = proofs.find(item => item.chainId === entry.chain)
    if (!proof) throw new Error('The saved Safe execution proof is incomplete.')
    const matches = records.filter(record => relayrRecordChain(record) === entry.chain)
    if (matches.length > 1 || (matches.length && !quotedIds.has(String(matches[0].tx_uuid).toLowerCase()))) {
      throw new Error('Relayr returned an invalid Safe execution result.')
    }
    return { chain: entry.chain, entry, txUuid: matches.length ? String(matches[0].tx_uuid) : proof.txUuid }
  })
}

/** Keep the old Safe-scoped journal readable while the SDK owns every decision. */
export function safeRelayrSession(scope: string): SafeRelayrSession | null {
  const saved = loadRelayrPendingSession(scope, true)
  if (!saved) {
    if (typeof window !== 'undefined' && hasRelayrPendingEvidence(scope)) {
      throw new Error('The saved Safe bundle could not be read. Keep it pending and check its original receipt.')
    }
    return null
  }
  if (saved.safeLifecycle) {
    const session = saved.safeLifecycle
    if (typeof session.id !== 'string' || !session.id || !isAddress(session.account) ||
        !Array.isArray(session.executions) || !Array.isArray(session.payments) ||
        (session.records !== undefined && !Array.isArray(session.records)) ||
        (!session.executions.length && !session.reservationKeys?.length)) {
      throw new Error('The saved Safe bundle is incomplete. Keep it pending and check its original receipt.')
    }
    // Older writers kept evidence beside the shared journal. A stale nested
    // unpaid state must not hide a known hash, payment history or pending send.
    // A chain choice alone can remain after a definite wallet rejection.
    const fundingObserved = session.fundingObserved || (session.paymentStatus === 'unfunded' && (
      saved.paymentHash !== null || saved.paymentUnmatched === true || !!saved.payments?.length || saved.paymentStatus !== 'unpaid'
    ))
    const records = [...new Map([...(session.records ?? []), ...saved.records].map(record => [JSON.stringify(record), record])).values()]
    return { ...session, ...(fundingObserved ? { fundingObserved: true } : {}), records }
  }
  const executions = (saved.expectedEntries ?? []).flatMap(entry => {
    const proof = saved.expectedSafeExecutions?.find(item => item.chainId === entry.chain)
    return proof ? [{ entry, safe: proof.safe, nonce: proof.nonce, safeTxHash: proof.safeTxHash }] : []
  })
  if (!saved.chainIds.length) {
    throw new Error('The older Safe bundle has no chain information. Keep it pending and check its original receipt.')
  }
  const complete = executions.length === saved.expectedCount &&
    saved.chainIds.length === executions.length && new Set(saved.chainIds).size === executions.length &&
    saved.chainIds.every(chainId => executions.some(execution => execution.entry.chain === chainId))
  const unknownFunding = !saved.payments?.length && (saved.paymentHash !== null || saved.paymentChainId !== null)
  return {
    id: `legacy:${scope}:${saved.bundleUuid}`,
    account: (saved.account ?? zeroAddress) as Address,
    executions,
    bundleUuid: saved.bundleUuid,
    ...(executions.length === saved.expectedCount ? {
      quote: {
        bundle_uuid: saved.bundleUuid,
        payment_info: saved.paymentOptions ?? [],
        transactions: saved.records,
        expectedTransactions: legacySafeRelayrBindings(executions.map(item => item.entry), saved.expectedSafeExecutions ?? [], saved.records),
      },
    } : {}),
    paymentStatus: saved.paymentStatus === 'unpaid' ? unknownFunding ? 'sending' : 'unfunded' : saved.paymentStatus,
    payments: saved.payments ?? [],
    state: 'active',
    createdAt: saved.createdAt,
    records: saved.records,
    reservationKeys: saved.chainIds.map(chainId => {
      const execution = complete ? executions.find(item => item.entry.chain === chainId) : undefined
      return `${chainId}:${scope.slice('safe-queue:'.length)}:${execution?.nonce ?? '*'}`
    }),
    context: { legacy: true },
  }
}

export function createProjectSafeRelayr({ scope, revalidate, onSaved, afterVerified }: {
  scope: string
  revalidate: (execution: SafeRelayrExecution, account: Address) => Promise<void>
  onSaved: (session: RelayrPendingSession | null) => void
  afterVerified: (execution: SafeRelayrExecution) => Promise<void>
}) {
  let fundingChainId: number | undefined
  return createSafeRelayrController({
    store: {
      scope: 'single-session',
      list: async () => {
        const saved = safeRelayrSession(scope)
        return saved ? [saved] : []
      },
      withLock: (_account, run) => withRelayrScopeLock(scope, run),
      save: async session => {
        const existing = safeRelayrSession(scope)
        if (existing && existing.id !== session.id && existing.state !== 'complete' && existing.state !== 'released') {
          throw new SafeRelayrRecoveryError(existing, 'This Safe already has a saved bundle. Check its existing bundle before starting another one.')
        }
        const stored = loadRelayrPendingSession(scope)
        const previous = stored?.safeLifecycle?.id === session.id || session.id.startsWith('legacy:') ? stored : null
        const payment = session.payments.at(-1)
        const saved = saveRelayrPendingSessionDurably(scope, {
          safeLifecycle: session,
          bundleUuid: session.bundleUuid ?? session.quote?.bundle_uuid ?? `unpublished:${session.id}`,
          paymentHash: payment?.hash ?? previous?.paymentHash ?? null,
          paymentChainId: payment?.chainId ?? fundingChainId ?? previous?.paymentChainId ?? null,
          paymentStatus: session.paymentStatus === 'unfunded' || session.paymentStatus === 'expired' ? 'unpaid' : session.paymentStatus,
          chainIds: session.executions.length ? session.executions.map(item => item.entry.chain) : previous?.chainIds ?? [],
          expectedCount: session.executions.length || previous?.expectedCount || 0,
          itemCount: session.executions.length || previous?.itemCount || 0,
          account: session.account,
          createdAt: session.createdAt,
          records: session.records ?? session.quote?.transactions ?? previous?.records ?? [],
          expectedEntries: session.executions.length ? session.executions.map(item => item.entry) : previous?.expectedEntries,
          expectedTransactions: session.quote?.expectedTransactions,
          expectedSafeExecutions: session.quote?.expectedTransactions?.map(binding => {
            const execution = session.executions.find(item => item.entry.chain === binding.chain)!
            return { chainId: binding.chain, safe: execution.safe, nonce: execution.nonce, safeTxHash: execution.safeTxHash, txUuid: binding.txUuid }
          }) ?? previous?.expectedSafeExecutions,
          payments: session.payments,
          paymentOptions: session.quote?.payment_info,
        }, session.state !== 'publishing' && session.paymentStatus !== 'sending')
        onSaved(session.state === 'complete' || session.state === 'released' ? null : saved)
      },
    },
    clientFor: relayrChainClient,
    currentAccount: () => getAccount(wagmiConfig).address,
    revalidate,
    afterVerified,
    review: async (executions, { resumed }) => {
      await requireTransactionReview({
        title: `Review ${executions.length} Safe executions`,
        confirmLabel: resumed ? 'Use saved quote' : 'Agree & request Relayr quote',
        calls: executions.map(({ entry }) => {
          const decoded = decodeFunctionData({ abi: SAFE_EXEC_ABI, data: entry.data })
          if (decoded.functionName !== 'execTransaction') throw new Error('The saved call is not a Safe execution.')
          const [to, value, data, operation] = decoded.args
          return {
            chainId: entry.chain, to: entry.target, data: entry.data, value: BigInt(entry.value),
            abi: SAFE_EXEC_ABI, functionName: 'execTransaction', args: decoded.args, contractName: 'Safe',
            calls: [queuedSafeReviewCall(entry.chain as JBChainId, { to, value: String(value), data, operation })],
          }
        }),
      })
    },
    sendPayment: async ({ session, payment, beforeSend, onSending, onSent }) => {
      // The legacy wallet adapter reports the latest mined replacement. Preserve
      // every earlier hash in the SDK journal, including an unmined original.
      let history = [...session.payments]
      const remember: typeof onSent = async payments => {
        history = [...history, ...payments.filter(payment => !history.some(saved =>
          saved.chainId === payment.chainId && saved.hash.toLowerCase() === payment.hash.toLowerCase()))]
        await onSent(history)
      }
      const result = await relayrPay({
        payment, account: session.account, bundleUuid: session.quote!.bundle_uuid,
        destinationChainIds: session.executions.map(item => item.entry.chain),
        sent: session.payments, reverify: beforeSend, reverifyBeforeSendOnly: true,
        onSending: () => {
          fundingChainId = payment.chain
          return onSending()
        }, onSent: remember,
      })
      await remember(result.payments)
      return { hash: result.hash, payments: history }
    },
  })
}
