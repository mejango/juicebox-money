import { useSyncExternalStore } from 'react'
import { decodeFunctionData, encodeFunctionData, erc20Abi, erc721Abi, parseAbi, toFunctionSelector, TransactionNotFoundError, TransactionReceiptNotFoundError, WaitForTransactionReceiptTimeoutError, type Abi, type AbiFunction, type Address, type Hex } from 'viem'
import * as core from '@bananapus/nana-sdk-core'
import * as v6 from '@bananapus/nana-sdk-core/v6'
import { registerReviewHandler } from '@bananapus/nana-sdk-core/review'
import { vi } from 'vitest'

type Receipt = {
  status: 'success' | 'reverted'
  blockNumber: bigint
  transactionHash: Hex
  blockHash: Hex
  transactionIndex: number
  from: Address
  to: Address | null
  logs: never[]
}

/** The canonical block every confirmed write is mined in. */
const MINED_BLOCK = `0x${'5b'.repeat(32)}` as Hex

/** The hash the fake wallet answers its `n`th write (from 1) with. */
export function sentHash(n: number): Hex {
  return `0x${n.toString(16).padStart(64, '0')}`
}

/**
 * The wallet, the chain's receipts and the app review under the real
 * reviewed run. Flow tests mock `wagmi`, `@wagmi/core` and
 * `@/hooks/useWallet` with the hooks and actions below, so the engine decides
 * what reaches the wallet: `writeContract` records each send.
 *
 * Switching the account re-renders every hook that reads it, as wagmi's
 * account subscription does.
 */
function createFakeWallet() {
  let account: Address | undefined
  const receipts = new Map<string, Receipt>()
  /** Flows awaiting a receipt the chain has not reported yet. */
  const awaiting = new Map<string, { resolve: (receipt: Receipt) => void; reject: (error: Error) => void }[]>()
  const listeners = new Set<() => void>()
  const notify = () => listeners.forEach(listener => listener())
  const subscribe = (listener: () => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }
  let sentCount = 0
  /** What each answered write sent, by its hash: the chain shows it as that call once confirmed. */
  const sent = new Map<string, { to: Address; data: Hex; value: bigint }>()
  const writeContract = vi.fn(async (request?: { address?: Address; abi?: Abi; functionName?: string; args?: readonly unknown[]; value?: bigint; data?: Hex; account?: Address }) => {
    const hash = sentHash((sentCount += 1))
    if (request?.address && (request.data || (request.abi && request.functionName))) {
      sent.set(hash.toLowerCase(), { to: request.address, value: request.value ?? 0n,
        data: request.data ?? encodeFunctionData({ abi: request.abi!, functionName: request.functionName!, args: request.args ?? [] } as never) })
    }
    return hash
  })
  /** The wallet core's reviewed run sends through: each send is recorded as a write of the function its bytes call. */
  const walletClient = {
    chain: { id: 1 },
    sendTransaction: vi.fn(async (tx: { to: Address; data: Hex; value?: bigint }) =>
      writeContract({ address: tx.to, data: tx.data, value: tx.value ?? 0n, ...decoded(tx.data), account }),
    ),
  }
  /** The app's review: true confirms it. Core's reviewed run asks it through the registered handler. */
  const requestReview = vi.fn(async (..._args: unknown[]) => true)
  const switchChain = vi.fn(async (_args?: { chainId: number }) => undefined)
  /** One RPC for every chain: simulations pass and receipts are what `confirm` set. */
  const client = {
    simulateContract: vi.fn(async (request: Record<string, unknown>) => ({ request: { ...request } })),
    estimateContractGas: vi.fn(async () => 50_000n),
    getTransactionReceipt: vi.fn(async ({ hash }: { hash: Hex }) => {
      const receipt = receipts.get(hash.toLowerCase())
      if (!receipt) throw new TransactionReceiptNotFoundError({ hash })
      return receipt
    }),
    /** Resolves once `confirm(hash)` reports it, and rejects on `giveUp()`. */
    waitForTransactionReceipt: vi.fn(({ hash }: { hash: Hex }) => {
      const key = hash.toLowerCase()
      const found = receipts.get(key)
      if (found) return Promise.resolve(found)
      return new Promise<Receipt>((resolve, reject) => awaiting.set(key, [...(awaiting.get(key) ?? []), { resolve, reject }]))
    }),
    getBalance: vi.fn(async () => 10n ** 30n),
    /**
     * Core simulates with a raw eth_call: it is answered as `simulateContract`
     * (which a test can hold or make revert), with one zero word (a Safe's
     * nonce reads 0).
     */
    request: vi.fn(answerRequest),
    estimateGas: vi.fn(async () => 50_000n),
    getChainId: vi.fn(async () => 1),
    /** The account's next nonce, read before each wallet send. */
    getBlockNumber: vi.fn(async () => 100n),
    getTransactionCount: vi.fn(async () => 0),
    /**
     * A confirmed write is a transaction the chain shows, mined where its receipt
     * says; any other hash (a Safe app's proposal hash) is none.
     */
    getTransaction: vi.fn(async ({ hash }: { hash: Hex }) => {
      const receipt = receipts.get(hash.toLowerCase())
      if (!receipt) throw new TransactionNotFoundError({ hash })
      const call = sent.get(hash.toLowerCase())
      return { hash, chainId: 1, from: receipt.from, to: call?.to ?? receipt.to, input: call?.data ?? ('0x' as Hex), value: call?.value ?? 0n, nonce: 0,
        blockHash: receipt.blockHash, blockNumber: receipt.blockNumber, transactionIndex: receipt.transactionIndex }
    }),
    getBlock: vi.fn(async (args: { blockTag?: string; blockNumber?: bigint } = {}) =>
      args.blockTag === 'finalized'
        ? { number: 1_000n, hash: `0x${'4f'.repeat(32)}` as Hex, timestamp: 1n }
        : { number: args.blockNumber ?? 1_000n, hash: MINED_BLOCK, timestamp: 1_000n, transactions: [] }),
    /** A flow's own reads; each test answers the ones its flow makes. */
    readContract: vi.fn(async (request: { functionName: string; args?: readonly unknown[] }): Promise<unknown> => {
      throw new Error(`Unexpected read ${request.functionName}`)
    }),
  }

  async function answerRequest({ method, params }: { method: string; params?: unknown[] }): Promise<unknown> {
    if (method !== 'eth_call') throw new Error(`unexpected ${method}`)
    const [call, block] = (params ?? []) as [{ from?: Address; to: Address; data: Hex; value?: Hex }, string | undefined]
    await client.simulateContract({
      address: call.to, data: call.data, account: call.from, ...decoded(call.data),
      ...(block && block !== 'latest' ? { blockNumber: BigInt(block) } : {}),
    })
    return `0x${'0'.repeat(64)}`
  }

  return {
    client,
    walletClient,
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
    /** The chain reports `hash` as confirmed, or as mined and reverted. */
    confirm(hash: Hex, blockNumber = 10n, status: Receipt['status'] = 'success') {
      const key = hash.toLowerCase()
      const receipt: Receipt = { status, blockNumber, transactionHash: hash, blockHash: MINED_BLOCK,
        transactionIndex: 0, from: account ?? ('0x0000000000000000000000000000000000000000' as Address), to: sent.get(key)?.to ?? null, logs: [] }
      receipts.set(key, receipt)
      for (const { resolve } of awaiting.get(key) ?? []) resolve(receipt)
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
    /** Every receipt watch still waiting times out, as viem's does. */
    giveUp() {
      for (const [hash, waiters] of awaiting) {
        for (const { reject } of waiters) reject(new WaitForTransactionReceiptTimeoutError({ hash: hash as Hex }))
      }
      awaiting.clear()
    },
    reset() {
      account = undefined
      sentCount = 0
      sent.clear()
      receipts.clear()
      awaiting.clear()
      writeContract.mockClear()
      requestReview.mockClear()
      requestReview.mockImplementation(async () => true)
      switchChain.mockClear()
      client.simulateContract.mockReset()
      client.simulateContract.mockImplementation(async request => ({ request: { ...request } }))
      client.request.mockReset()
      client.request.mockImplementation(answerRequest)
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

/** Every function the app's contracts expose, by selector, to read what a send calls. */
const functions = new Map<string, AbiFunction>()
/** Permit2's and the PositionManager's writes, which the app builds from its own ABIs. */
const UNISWAP = parseAbi([
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
  'function modifyLiquidities(bytes unlockData, uint256 deadline) payable',
])
for (const abi of [erc20Abi, erc721Abi, UNISWAP, ...Object.values(core), ...Object.values(v6)].filter(Array.isArray) as readonly unknown[][]) {
  for (const item of abi as AbiFunction[]) {
    if (item?.type === 'function') functions.set(toFunctionSelector(item), item)
  }
}
/** A send's function and arguments, when its selector is one of the app's. */
function decoded(data: Hex): { functionName?: string; args?: readonly unknown[] } {
  const item = functions.get(data.slice(0, 10).toLowerCase())
  if (!item) return {}
  const { functionName, args } = decodeFunctionData({ abi: [item], data })
  return { functionName, args: args ?? [] }
}

export const wallet = createFakeWallet()

registerReviewHandler(async prompt => (await wallet.requestReview(prompt.model)) ? prompt.confirmation : null)

/** The `@wagmi/core` actions core's reviewed run calls, answered by the fake wallet. */
export const walletActions = {
  getAccount: () => ({ address: wallet.account, chainId: 1 }),
  getWalletClient: async () => wallet.walletClient,
  getPublicClient: () => wallet.client,
  switchChain: (_config: unknown, args: { chainId: number }) => wallet.switchChain(args),
}

/** The engine's wagmi hooks, answered by the fake wallet. */
export const walletHooks = {
  usePublicClient: () => wallet.client,
  useWriteContract: () => ({ writeContractAsync: wallet.writeContract }),
  useSwitchChain: () => ({ switchChainAsync: wallet.switchChain }),
  useWaitForTransactionReceipt: ({ hash }: { hash?: Hex }) => {
    const data = wallet.useReceipt(hash)
    return { data, isError: false }
  },
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
