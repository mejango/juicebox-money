import {
  createBrowserWriteRecovery,
  readBrowserWriteRecovery,
  readReviewedWriteNonce,
  type ReviewedWriteNonceEvidence,
  type ReviewedWriteRecoveryInput,
  type ReviewedWriteRecoveryScope,
} from '@bananapus/nana-sdk-core/review'
import type { Address, PublicClient } from 'viem'

type RecoveryStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

const tabMemory = new Map<string, string>()
const tabStorage: RecoveryStorage = {
  getItem: key => tabMemory.get(key) ?? null,
  setItem: (key, value) => { tabMemory.set(key, value) },
  removeItem: key => { tabMemory.delete(key) },
}

/**
 * Where a held wallet write is kept: the browser's storage, or this tab's
 * memory where the browser offers none (a sandboxed frame, some wallet
 * webviews). Without storage a hold lasts until reload instead of refusing.
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

/** Test seam: forget the writes held in this tab's memory. */
export function clearTabWriteRecovery(): void {
  tabMemory.clear()
}
