import { vi } from 'vitest'
import type { Address, Hex } from 'viem'

/** A log as a test writes it; the node binds it to its receipt. */
type TestLog = { address: Address; topics: Hex[]; data: Hex }
/** A receipt as a test writes it; the node mines it in its canonical block. */
type TestReceipt = { transactionHash: Hex; status: string; logs: TestLog[] }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Answer = { mockImplementation(fn: (...args: any[]) => unknown): unknown }

/** The parts of a public client a write hold reads, as vi.fn mocks. */
type NodeClient = {
  getTransaction: (args: { hash: Hex }) => Promise<unknown>
  getTransactionReceipt: Answer
  waitForTransactionReceipt?: Answer
  getBlock: Answer
  getBlockNumber?: { mockResolvedValue(value: bigint): unknown }
}

/**
 * A real node's answers on one client mock, so the SDK's write hold can
 * verify what a test sends:
 * - its chain id, the latest block and the account's nonce;
 * - one canonical block (`blockHash`, number `blockNumber`) where every
 *   transaction is mined, and a finalized block past it;
 * - receipts in that block, with their logs bound to them (`receiptsAre`).
 * The client's own getTransaction stays the test's; make it return mined
 * transactions with `minedAt`.
 */
export function modelNode(client: NodeClient, {
  chainId,
  blockHash,
  blockNumber = 1n,
  latest = 100n,
}: { chainId: () => number; blockHash: Hex; blockNumber?: bigint; latest?: bigint }) {
  const at = { blockHash, blockNumber, transactionIndex: 0 }
  client.getBlock.mockImplementation(async ({ blockTag, blockNumber: asked }: { blockTag?: string; blockNumber?: bigint } = {}) =>
    blockTag === 'finalized'
      ? { number: latest, hash: `0x${'f1'.repeat(32)}` as Hex, timestamp: 1n }
      : { number: asked ?? latest, hash: asked === undefined || asked === blockNumber ? blockHash : (`0x${'f2'.repeat(32)}` as Hex) })
  client.getBlockNumber?.mockResolvedValue(latest)
  Object.assign(client, { getTransactionCount: vi.fn(async () => 3), getChainId: vi.fn(async () => chainId()) })
  return {
    /** Where every transaction is mined: spread into a test's transaction. */
    minedAt: at,
    /** Receipts as `make` writes them, mined in the canonical block, from whoever sent the transaction. */
    receiptsAre(make: (hash: Hex) => TestReceipt) {
      const shown = async (hash: Hex) => {
        const receipt = make(hash)
        const sent = await client.getTransaction({ hash }).catch(() => null) as { from?: Address; to?: Address } | null
        return {
          ...receipt, ...at, from: sent?.from, to: sent?.to,
          logs: receipt.logs.map(log => ({ ...log, ...at, removed: false, transactionHash: hash })),
        }
      }
      client.waitForTransactionReceipt?.mockImplementation(async ({ hash }: { hash: Hex }) => shown(hash))
      client.getTransactionReceipt.mockImplementation(async ({ hash }: { hash: Hex }) => shown(hash))
      return shown
    },
  }
}
