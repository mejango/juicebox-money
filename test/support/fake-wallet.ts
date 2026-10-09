import { useSyncExternalStore } from 'react'
import { encodeFunctionData, TransactionNotFoundError, type Abi, type Address, type Hex, type TransactionReceipt } from 'viem'
import { vi } from 'vitest'

type Receipt = TransactionReceipt
type SentRequest = { chainId: number; account: Address; address: Address; abi: Abi; functionName: string; args?: readonly unknown[]; value?: bigint }
type SentCall = { chainId: number; from: Address; to: Address; input: Hex; value: bigint }

const blockHash = (number: bigint): Hex => `0x${number.toString(16).padStart(64, '0')}`

/** The hash the fake wallet answers its `n`th write (from 1) with. */
export function sentHash(n: number): Hex {
  return `0x${n.toString(16).padStart(64, '0')}`
}

/**
 * The wallet, the chain's receipts and the app review under the real
 * useSafeTx and the SDK's reviewed write. Flow tests mock `wagmi`,
 * `@wagmi/core` and `@/hooks/useWallet` with the hooks below, so the engine
 * decides what reaches the wallet: `writeContract` records it.
 *
 * Switching the account re-renders every hook that reads it, as wagmi's
 * account subscription does.
 */
function createFakeWallet() {
  let account: Address | undefined
  const receipts = new Map<string, Receipt>()
  const sent = new Map<string, SentCall>()
  let currentChainId = 1
  let finalizedBlock = 0n
  /** Flows awaiting a receipt the chain has not reported yet. */
  const awaiting = new Map<string, ((receipt: Receipt) => void)[]>()
  const listeners = new Set<() => void>()
  const notify = () => listeners.forEach(listener => listener())
  const subscribe = (listener: () => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }
  let sentCount = 0
  const writeContract = vi.fn(async (request: SentRequest) => {
    const hash = sentHash((sentCount += 1))
    currentChainId = request.chainId
    sent.set(hash.toLowerCase(), {
      chainId: request.chainId, from: request.account, to: request.address,
      input: encodeFunctionData(request), value: request.value ?? 0n,
    })
    return hash
  })
  const requestReview = vi.fn(async () => true)
  const switchChain = vi.fn(async ({ chainId }: { chainId: number }) => { currentChainId = chainId })
  const transaction = async ({ hash }: { hash: Hex }) => {
    const call = sent.get(hash.toLowerCase())
    const receipt = receipts.get(hash.toLowerCase())
    if (!call || !receipt) throw new TransactionNotFoundError({ hash })
    return { ...call, hash, blockHash: receipt.blockHash, blockNumber: receipt.blockNumber, transactionIndex: receipt.transactionIndex }
  }
  const block = async ({ blockNumber }: { blockNumber?: bigint; blockTag?: string }) => {
    const number = blockNumber ?? finalizedBlock
    return { number, hash: blockHash(number), timestamp: 1n }
  }
  /** One RPC for every chain: simulations pass and receipts are what `confirm` set. */
  const client = {
    getChainId: vi.fn(async () => currentChainId),
    getBlock: vi.fn(block),
    simulateContract: vi.fn(async (request: Record<string, unknown>) => ({ request: { ...request } })),
    estimateContractGas: vi.fn(async () => 50_000n),
    getTransactionReceipt: vi.fn(async ({ hash }: { hash: Hex }) => receipts.get(hash.toLowerCase()) ?? null),
    /** Resolves once `confirm(hash)` reports it. */
    waitForTransactionReceipt: vi.fn(({ hash }: { hash: Hex }) => {
      const key = hash.toLowerCase()
      const found = receipts.get(key)
      if (found) return Promise.resolve(found)
      return new Promise<Receipt>(resolve => awaiting.set(key, [...(awaiting.get(key) ?? []), resolve]))
    }),
    getBalance: vi.fn(async () => 10n ** 30n),
    /** Only confirmed writes are mined transactions; Safe proposal replies stay unknown. */
    getTransaction: vi.fn(transaction),
    /** A flow's own reads; each test answers the ones its flow makes. */
    readContract: vi.fn(async (request: { functionName: string; args?: readonly unknown[] }): Promise<unknown> => {
      throw new Error(`Unexpected read ${request.functionName}`)
    }),
  }

  return {
    client,
    writeContract,
    requestReview,
    switchChain,
    get account() {
      return account
    },
    /** Connect `next`, as a wallet switching accounts does. */
    connect(next: Address | undefined) {
      account = next
      notify()
    },
    /** The chain reports `hash` as confirmed. */
    confirm(hash: Hex, blockNumber = 10n) {
      const key = hash.toLowerCase()
      const call = sent.get(key)
      if (!call) throw new Error(`Cannot confirm an unsent transaction ${hash}`)
      const receipt: Receipt = {
        status: 'success', blockNumber, blockHash: blockHash(blockNumber), transactionHash: hash,
        transactionIndex: 0, from: call.from, to: call.to, contractAddress: null,
        logs: [], logsBloom: `0x${'00'.repeat(256)}`, type: 'eip1559',
        cumulativeGasUsed: 50_000n, gasUsed: 50_000n, effectiveGasPrice: 1n,
      }
      if (blockNumber > finalizedBlock) finalizedBlock = blockNumber
      receipts.set(key, receipt)
      for (const resolve of awaiting.get(key) ?? []) resolve(receipt)
      awaiting.delete(key)
      notify()
    },
    /** Whether a flow is waiting on `hash`'s receipt. */
    awaits(hash: Hex) {
      return awaiting.has(hash.toLowerCase())
    },
    /** What reached the wallet: each write's function and sender. */
    writes() {
      return writeContract.mock.calls.map(call => {
        const request = (call as unknown[])[0] as { functionName: string; account: unknown }
        return { functionName: request.functionName, account: request.account }
      })
    },
    reset() {
      account = undefined
      sentCount = 0
      currentChainId = 1
      finalizedBlock = 0n
      sent.clear()
      receipts.clear()
      awaiting.clear()
      writeContract.mockClear()
      requestReview.mockClear()
      requestReview.mockImplementation(async () => true)
      switchChain.mockClear()
      client.getChainId.mockClear()
      client.getBlock.mockReset().mockImplementation(block)
      client.getTransaction.mockReset().mockImplementation(transaction)
      client.simulateContract.mockClear()
      client.getTransactionReceipt.mockClear()
      client.waitForTransactionReceipt.mockClear()
      client.readContract.mockReset()
      client.readContract.mockImplementation(async request => {
        throw new Error(`Unexpected read ${request.functionName}`)
      })
    },
    /** The connected account, re-rendering on a switch. */
    useAccount() {
      return useSyncExternalStore(subscribe, () => account)
    },
    useReceipt(hash: Hex | undefined) {
      return useSyncExternalStore(subscribe, () => (hash ? receipts.get(hash.toLowerCase()) : undefined))
    },
  }
}

export const wallet = createFakeWallet()

/** The engine's wagmi hooks, answered by the fake wallet. */
export const walletHooks = {
  usePublicClient: () => wallet.client,
  useWriteContract: () => ({ writeContractAsync: wallet.writeContract }),
  useSwitchChain: () => ({ switchChainAsync: wallet.switchChain }),
  useWaitForTransactionReceipt: ({ hash }: { hash?: Hex }) => ({
    data: wallet.useReceipt(hash),
    isError: false,
  }),
}

/** `useWallet`, connected as the fake wallet's account. */
export function useFakeWallet() {
  const address = wallet.useAccount()
  return {
    isConnected: !!address,
    address,
    isCenterWallet: false,
    openSignIn: () => {},
  }
}
