import { writeHeldMessage, type ReviewedWriteRecoveryRecord } from '@bananapus/nana-sdk-core/review'
import { encodeFunctionData, type Address, type Hex, type PublicClient } from 'viem'
import type { TxRequest, TxSendOptions } from '@/hooks/useSafeTx'
import { openWriteRecovery, readWriteRecovery, writeNonceEvidence } from '@/lib/write-recovery'

export type DefifaWriteAction = 'pay' | 'cash-out' | 'transfer'
export type DefifaRecoveryScope = { chainId: number; projectId: number; account: Address; action: DefifaWriteAction }
export const DEFIFA_RECOVERY_QUERY_PREFIX = ['defifa-write-recovery'] as const
export const DEFIFA_RECOVERY_CHANGE_EVENT = 'defifa-write-recovery'
const notifyRecovery = () => { globalThis.dispatchEvent?.(new Event(DEFIFA_RECOVERY_CHANGE_EVENT)) }

/** Approval and mint are successive legs of one pay intent, never two journals. */
const defifaWriteNamespace = (scope: DefifaRecoveryScope) => `defifa:${scope.action}:${scope.projectId}`

export function readDefifaWriteRecovery(scope: DefifaRecoveryScope) {
  return readWriteRecovery({ chainId: scope.chainId, account: scope.account, namespace: defifaWriteNamespace(scope) })
}

function reopenDefifaWriteRecovery(scope: DefifaRecoveryScope, record: ReviewedWriteRecoveryRecord) {
  return openWriteRecovery({ ...record, namespace: defifaWriteNamespace(scope) })
}

export class PendingDefifaWriteError extends Error {
  constructor(readonly record: ReviewedWriteRecoveryRecord) {
    super(writeHeldMessage('NFT action'))
  }
}

/** Delegate storage, locking, reservation and explicit rejection to the SDK owner. */
export async function sendRecoverableDefifaWrite({ scope, request, safe, send, options, onRecord, client }: {
  scope: DefifaRecoveryScope
  request: TxRequest
  safe: boolean
  send: (request: TxRequest, options: TxSendOptions) => Promise<Hex | null>
  options: TxSendOptions
  onRecord?: (record: ReviewedWriteRecoveryRecord | null) => void
  /** Reads the account's next nonce before the wallet opens, so the chain can later release the hold. */
  client?: Pick<PublicClient, 'getBlockNumber' | 'getTransactionCount'>
}) {
  if (request.chainId !== scope.chainId || options.reviewedAccount.toLowerCase() !== scope.account.toLowerCase()) {
    throw new Error('The recovery scope does not match the reviewed account and network.')
  }
  const journal = openWriteRecovery({
    chainId: scope.chainId, account: scope.account, safe, namespace: defifaWriteNamespace(scope),
    call: { to: request.address, data: encodeFunctionData(request), value: request.value ?? 0n },
  })
  return journal.withLock(async () => {
    const previous = journal.read()
    if (previous) {
      onRecord?.(previous)
      throw new PendingDefifaWriteError(previous)
    }
    let reserved: ReviewedWriteRecoveryRecord | undefined
    const releaseRejected = async (callback: TxSendOptions['onWriteRejected']) => {
      journal.rejected()
      reserved = undefined
      onRecord?.(null)
      notifyRecovery()
      await callback?.()
    }
    const hash = await send(request, {
      ...options,
      journaled: true,
      beforeWrite: async () => {
        reserved = journal.reserve(undefined, safe ? undefined : await writeNonceEvidence(client, scope.account))
        onRecord?.(reserved)
        notifyRecovery()
        try {
          await options.beforeWrite?.()
        } catch (error) {
          await releaseRejected(options.onBeforeWriteAborted)
          throw error
        }
      },
      onBeforeWriteAborted: () => releaseRejected(options.onBeforeWriteAborted),
      onWriteRejected: () => releaseRejected(options.onWriteRejected),
    })
    if (hash) {
      // An already authenticated matching Safe proposal can return without a new writer invocation.
      reserved ??= journal.reserve()
      try {
        reserved = journal.submitted(hash, reserved)
        onRecord?.(reserved)
        notifyRecovery()
      } catch (error) {
        onRecord?.(journal.read() ?? reserved)
        notifyRecovery()
        throw error
      }
    }
    return hash
  })
}

/**
 * The user checked their wallet: the saved action is released so a new one
 * can be reviewed. Only that exact record is released.
 */
export function abandonDefifaWriteRecovery(scope: DefifaRecoveryScope, record: ReviewedWriteRecoveryRecord) {
  reopenDefifaWriteRecovery(scope, record).abandon(record, { checkedWallet: true })
  notifyRecovery()
}

/**
 * Check a saved ordinary write against the chain: its hash once mined, or its
 * exact call at the nonce it was sent at. Null once nothing is held any more.
 */
export async function resolveDefifaWriteRecovery(
  scope: DefifaRecoveryScope,
  record: ReviewedWriteRecoveryRecord,
  client: Parameters<ReturnType<typeof openWriteRecovery>['resolve']>[0],
) {
  const journal = reopenDefifaWriteRecovery(scope, record)
  const check = await journal.withLock(() => journal.resolve(client), true)
  if (check && check.status !== 'pending') notifyRecovery()
  return check
}

/** Call only after the exact original write's success or finalized failure was authenticated. */
export async function clearDefifaWriteRecovery(scope: DefifaRecoveryScope, record: ReviewedWriteRecoveryRecord) {
  const journal = reopenDefifaWriteRecovery(scope, record)
  await journal.withLock(async () => {
    // A wallet-returned identity can be retained by the SDK's volatile overlay after a failed durable update.
    const committed = record.hash ? journal.submitted(record.hash, record) : record
    journal.clear(committed)
  })
  notifyRecovery()
}
