import {
  createBrowserWriteRecovery,
  createHeldWriteStorage,
  readBrowserWriteRecovery,
  readReviewedWriteNonce,
  writeHeldMessage,
  type ReviewedWriteRecoveryInput,
  type ReviewedWriteRecoveryRecord,
} from '@bananapus/nana-sdk-core/review'
import { encodeFunctionData, type Address, type Hex, type PublicClient } from 'viem'
import type { TxRequest, TxSendOptions } from '@/hooks/useSafeTx'
import { writeHolds } from '@/lib/write-holds'

/** The SDK's held-write storage, shared with every write hold: the browser's, or this tab's memory. */
const storage = createHeldWriteStorage()
const openJournal = (input: ReviewedWriteRecoveryInput) => createBrowserWriteRecovery(input, { storage })

export type DefifaWriteAction = 'pay' | 'cash-out' | 'transfer'
export type DefifaRecoveryScope = { chainId: number; projectId: number; account: Address; action: DefifaWriteAction }
export const DEFIFA_RECOVERY_QUERY_PREFIX = ['defifa-write-recovery'] as const
export const DEFIFA_RECOVERY_CHANGE_EVENT = 'defifa-write-recovery'
export const notifyRecovery = () => { globalThis.dispatchEvent?.(new Event(DEFIFA_RECOVERY_CHANGE_EVENT)) }

/** Approval and mint are successive legs of one pay intent, never two journals. */
const defifaWriteNamespace = (scope: DefifaRecoveryScope) => `defifa:${scope.action}:${scope.projectId}`

export function readDefifaWriteRecovery(scope: DefifaRecoveryScope) {
  return readBrowserWriteRecovery({ chainId: scope.chainId, account: scope.account, namespace: defifaWriteNamespace(scope) }, { storage })
}

function reopenDefifaWriteRecovery(scope: DefifaRecoveryScope, record: ReviewedWriteRecoveryRecord) {
  return openJournal({ ...record, namespace: defifaWriteNamespace(scope) })
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
  const input: ReviewedWriteRecoveryInput = {
    chainId: scope.chainId, account: scope.account, safe, namespace: defifaWriteNamespace(scope),
    call: { to: request.address, data: encodeFunctionData(request), value: request.value ?? 0n },
  }
  const journal = openJournal(input)
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
      // A Safe follower's outcome reaches this journal's record, and the recovery card hears of it.
      heldBy: { hold: writeHolds.open(input), onChange: notifyRecovery },
      beforeWrite: async () => {
        const evidence = safe || !client ? undefined : await readReviewedWriteNonce(client, scope.account).catch(() => undefined)
        reserved = journal.reserve(undefined, evidence)
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

/** The SDK's write hold over a saved Defifa action: its state, its line and the user's exit. */
export function defifaWriteHold(scope: DefifaRecoveryScope, record: ReviewedWriteRecoveryRecord) {
  return writeHolds.open({ chainId: record.chainId, account: record.account, safe: record.safe, namespace: defifaWriteNamespace(scope), call: record.call })
}

/** Call only after the exact original write's success or finalized failure was authenticated. */
export async function clearDefifaWriteRecovery(scope: DefifaRecoveryScope, record: ReviewedWriteRecoveryRecord) {
  const journal = reopenDefifaWriteRecovery(scope, record)
  await journal.withLock(async () => {
    // The same attempt may carry chain evidence the write hold added since (its sent nonce).
    const current = journal.read()
    const latest = current?.id === record.id ? current : record
    // A wallet-returned identity can be retained by the SDK's volatile overlay after a failed durable update.
    const committed = latest.hash ? journal.submitted(latest.hash, latest) : latest
    journal.clear(committed)
  })
  notifyRecovery()
}
