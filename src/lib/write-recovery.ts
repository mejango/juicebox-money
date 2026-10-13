import {
  createBrowserWriteRecovery,
  readBrowserWriteRecovery,
  readReviewedWriteNonce,
  verifyReviewedWriteReceipt,
  type ReviewedWriteNonceEvidence,
  type ReviewedWriteReceiptClient,
  type ReviewedWriteRecoveryInput,
  type ReviewedWriteRecoveryRecord,
  type ReviewedWriteRecoveryScope,
} from '@bananapus/nana-sdk-core/review'
import { atCanonicalFinalizedBlock } from '@bananapus/nana-sdk-core/review/relayr'
import type { Address, PublicClient, TransactionReceipt } from 'viem'

type RecoveryStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

const tabMemory = new Map<string, string>()
const tabStorage: RecoveryStorage = {
  getItem: key => tabMemory.get(key) ?? null,
  setItem: (key, value) => { tabMemory.set(key, value) },
  removeItem: key => { tabMemory.delete(key) },
}

/** The review's line where held writes last only until reload. */
export const WRITE_RECOVERY_IN_TAB_LINE =
  "This browser can't remember pending transactions. Check your wallet before repeating one."

/**
 * Where a held wallet write is kept: the browser's storage, shared by its tabs
 * and kept across reloads, whenever it is available. Where it is refused
 * (private browsing, a sandboxed frame, some wallet webviews), this tab's
 * memory, so a hold lasts until reload instead of refusing every write; the
 * review then says so ({@link WRITE_RECOVERY_IN_TAB_LINE}).
 */
function writeRecoveryStorage(): RecoveryStorage {
  try {
    const storage = globalThis.localStorage
    if (storage && typeof storage.getItem === 'function') {
      storage.getItem('nana-sdk:reviewed-write:probe')
      return storage
    }
  } catch {
    // Access to storage was refused.
  }
  return tabStorage
}

/** Whether held writes are kept by the browser, rather than only in this tab. */
export function writeRecoveryIsDurable(): boolean {
  return writeRecoveryStorage() !== tabStorage
}

/** The SDK's write recovery for one write, kept in {@link writeRecoveryStorage}. */
export function openWriteRecovery(input: ReviewedWriteRecoveryInput) {
  return createBrowserWriteRecovery(input, { storage: writeRecoveryStorage() })
}

export type WriteRecovery = ReturnType<typeof openWriteRecovery>

/** A namespaced action's saved write, read from {@link writeRecoveryStorage}. */
export function readWriteRecovery(scope: ReviewedWriteRecoveryScope) {
  return readBrowserWriteRecovery(scope, { storage: writeRecoveryStorage() })
}

/**
 * The account's next nonce, read right before the wallet opens, so the chain
 * can later prove what happened to a write with no confirmed result. A node
 * that can't say leaves none: the user's exit then ends the hold.
 */
export async function writeNonceEvidence(
  client: Pick<PublicClient, 'getBlockNumber' | 'getTransactionCount'> | undefined,
  account: Address,
): Promise<ReviewedWriteNonceEvidence | undefined> {
  try {
    return client ? await readReviewedWriteNonce(client, account) : undefined
  } catch {
    return undefined
  }
}

/** A held write whose saved hash is still pending: no exit, the wallet ends it. */
export const WRITE_PENDING_LINE = 'Still pending in your wallet. Speed it up or cancel it there.'

/**
 * Whether a held write may be offered the user's exit: it has no known hash,
 * or its hash is proven dropped (the node doesn't know it, and a finalized
 * block shows the account's nonce used past the one it was sent at, by
 * another transaction). A hash in the mempool, or one whose receipt can't be
 * read yet, is `pending`: it is tracked, and the wallet speeds it up or
 * cancels it.
 */
export async function heldWriteState(
  client: Pick<PublicClient, 'getTransaction' | 'getTransactionCount' | 'getBlock'> | undefined,
  record: ReviewedWriteRecoveryRecord,
): Promise<'no-hash' | 'pending' | 'dropped'> {
  if (!record.hash) return 'no-hash'
  if (!client) return 'pending'
  const known = await client.getTransaction({ hash: record.hash }).then(
    () => true,
    (error: { name?: unknown } | null) => (error?.name === 'TransactionNotFoundError' ? false : null),
  ).catch(() => null)
  if (known !== false) return 'pending'
  const target = record.sentNonce ?? record.nonce
  if (target === undefined) return 'pending'
  const used = await atCanonicalFinalizedBlock(client as never, async finalized =>
    BigInt(await client.getTransactionCount({ address: record.account, blockNumber: finalized })) > BigInt(target),
  ).catch(() => null)
  return used?.value ? 'dropped' : 'pending'
}

/** A held write's receipt is rechecked this often until a finalized block includes it. */
const FINALITY_POLL_MS = 15_000
/** About an hour; after that the next send of the call checks the chain again. */
const FINALITY_ATTEMPTS = 240
const finalizing = new Map<string, ReturnType<typeof setTimeout> | undefined>()

/**
 * Release a held write once its receipt is authenticated (the SDK's
 * {@link verifyReviewedWriteReceipt}) and included at a canonical finalized
 * block. Until then the hold stays, so a reorg can't let the call be sent
 * twice. It runs outside any component: closing the flow doesn't stop it.
 */
export function releaseWhenFinal(
  journal: WriteRecovery,
  record: ReviewedWriteRecoveryRecord,
  client: ReviewedWriteReceiptClient,
  receipt: TransactionReceipt,
): void {
  if (finalizing.has(record.id)) return
  finalizing.set(record.id, undefined)
  let attempts = 0
  const check = async () => {
    try {
      await verifyReviewedWriteReceipt(client, record, receipt)
      const final = await atCanonicalFinalizedBlock(client, async finalized => {
        if (finalized < receipt.blockNumber) return false
        const block = await client.getBlock({ blockNumber: receipt.blockNumber })
        return block.hash?.toLowerCase() === receipt.blockHash.toLowerCase()
      })
      if (final?.value) {
        await journal.withLock(async () => {
          const saved = journal.read()
          if (saved?.id !== record.id) return
          // A hash kept only in memory after a failed save is committed before it is cleared.
          journal.clear(saved.hash ? journal.submitted(saved.hash, saved) : saved)
        }, true)
        finalizing.delete(record.id)
        return
      }
    } catch {
      // Not proven yet, or the node can't say: look again.
    }
    if (!finalizing.has(record.id)) return
    if ((attempts += 1) >= FINALITY_ATTEMPTS) {
      finalizing.delete(record.id)
      return
    }
    finalizing.set(record.id, setTimeout(() => void check(), FINALITY_POLL_MS))
  }
  void check()
}

/** Test seam: forget the writes held in this tab's memory, and stop every finality check. */
export function clearTabWriteRecovery(): void {
  tabMemory.clear()
  for (const timer of finalizing.values()) clearTimeout(timer)
  finalizing.clear()
}
