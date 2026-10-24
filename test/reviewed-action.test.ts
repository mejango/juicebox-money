/**
 * useReviewedAction, jbm's one reviewed-send hook over core's useReviewedRun,
 * sends exactly the bytes useSafeTx sent (the committed baseline in
 * test/fixtures/use-safe-tx-calldata.json) and keeps each write's intent and
 * legacy hold namespaces.
 */

import { createElement, createRef, forwardRef, useImperativeHandle } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { decodeFunctionData, numberToHex, type Abi, type Address, type Hex } from 'viem'
import { buildBorrowTx, buildCashOutTx, buildPayTx } from '@bananapus/nana-sdk-core/v6'
import { payIntent, registerReviewHandler } from '@bananapus/nana-sdk-core/review'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import baseline from './fixtures/use-safe-tx-calldata.json'

const ALICE = '0x1111111111111111111111111111111111111111' as Address
const TERMINAL = '0x2db6d704058e552defe415753465df8df0361846' as Address
const TOKEN = '0x000000000000000000000000000000000000EEEe' as Address

/** One chain whose sends are mined in the next block; eth_call always succeeds. */
const chain = vi.hoisted(() => {
  const state = { head: 100n, nonce: 7, mined: new Map<string, bigint>(), sent: new Map<string, { to: string; data: string; value: bigint; nonce: number }>() }
  return { state }
})

function receipt(hash: Hex) {
  return {
    transactionHash: hash,
    blockNumber: chain.state.mined.get(hash)!,
    blockHash: numberToHex(chain.state.mined.get(hash)!, { size: 32 }),
    status: 'success',
    transactionIndex: 0,
    from: ALICE,
    to: chain.state.sent.get(hash)?.to,
    logs: [],
  }
}

const client = {
  chain: { id: 10, name: 'OP Mainnet' },
  request: vi.fn(async ({ method }: { method: string }) => {
    if (method === 'eth_call') return '0x'
    if (method === 'eth_getBlockByNumber') return { number: numberToHex(chain.state.head), hash: numberToHex(chain.state.head, { size: 32 }) }
    throw new Error(`unexpected ${method}`)
  }),
  estimateGas: vi.fn(async () => 21_000n),
  readContract: vi.fn(async () => { throw new Error('no token reads here') }),
  getChainId: vi.fn(async () => 10),
  getBlockNumber: vi.fn(async () => chain.state.head),
  getTransactionCount: vi.fn(async () => chain.state.nonce),
  getBlock: vi.fn(async ({ blockNumber }: { blockNumber?: bigint } = {}) => ({ number: blockNumber ?? chain.state.head, hash: numberToHex(blockNumber ?? chain.state.head, { size: 32 }), timestamp: 1_000n, transactions: [] })),
  getTransaction: vi.fn(async ({ hash }: { hash: Hex }) => {
    const tx = chain.state.sent.get(hash)
    if (!tx) throw Object.assign(new Error('not found'), { name: 'TransactionNotFoundError' })
    const block = chain.state.mined.get(hash)!
    return { hash, chainId: 10, from: ALICE, to: tx.to, input: tx.data, value: tx.value, nonce: tx.nonce, blockNumber: block, blockHash: numberToHex(block, { size: 32 }), transactionIndex: 0 }
  }),
  getTransactionReceipt: vi.fn(async ({ hash }: { hash: Hex }) => receipt(hash)),
  waitForTransactionReceipt: vi.fn(async ({ hash }: { hash: Hex }) => receipt(hash)),
}

/** What the wallet was asked to send, in order. */
const walletSends: { chainId: number; to: Address; data: Hex; value: bigint }[] = []
let currentWallet: typeof walletClient
const walletClient = {
  chain: { id: 10 },
  sendTransaction: vi.fn(async (tx: { chain: { id: number }; to: Address; data: Hex; value: bigint }) => {
    walletSends.push({ chainId: tx.chain.id, to: tx.to, data: tx.data, value: tx.value })
    const hash = `0x${walletSends.length.toString(16).padStart(64, '0')}` as Hex
    chain.state.sent.set(hash, { ...tx, nonce: chain.state.nonce })
    chain.state.head += 1n
    chain.state.nonce += 1
    chain.state.mined.set(hash, chain.state.head)
    return hash
  }),
}

currentWallet = walletClient

vi.mock('@wagmi/core', async importOriginal => ({
  ...(await importOriginal<typeof import('@wagmi/core')>()),
  getAccount: () => ({ address: '0x1111111111111111111111111111111111111111', chainId: 10 }),
  getWalletClient: async () => currentWallet,
  getPublicClient: () => client,
  switchChain: vi.fn(),
}))
vi.mock('wagmi', () => ({
  useAccount: () => ({ address: '0x1111111111111111111111111111111111111111', chainId: 10 }),
}))
vi.mock('@/hooks/useWallet', () => ({
  useWallet: () => ({ isConnected: true, address: '0x1111111111111111111111111111111111111111', isCenterWallet: false }),
}))
vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('@/lib/safe-connector', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/safe-connector')>()),
  isSafeConnection: () => false,
  useSafeConnection: () => false,
}))

import { liveStep, reachedLastStep, useReviewedAction } from '@/hooks/useReviewedAction'
import { writeHolds } from '@/lib/write-holds'

type Action = ReturnType<typeof useReviewedAction>
const Harness = forwardRef<Action>(function Harness(_, ref) {
  const value = useReviewedAction()
  useImperativeHandle(ref, () => value, [value])
  return null
})

const unregister: (() => void)[] = []
afterEach(() => {
  while (unregister.length) unregister.pop()!()
  walletSends.length = 0
  currentWallet = walletClient
})

/** The review UI confirms every prompt. */
function confirmEveryReview() {
  unregister.push(registerReviewHandler(async prompt => prompt.confirmation))
}

const REQUESTS = {
  pay: buildPayTx({ chainId: 10, terminal: TERMINAL, projectId: 4n, token: TOKEN, amount: 10n ** 16n, beneficiary: ALICE, minReturnedTokens: 7n, memo: 'gm', metadata: '0x' }),
  cashOut: buildCashOutTx({ chainId: 10, terminal: TERMINAL, holder: ALICE, projectId: 4n, cashOutCount: 10n ** 18n, tokenToReclaim: TOKEN, minTokensReclaimed: 5n, beneficiary: ALICE, metadata: '0x' }),
  loan: buildBorrowTx({ chainId: 10, revnetId: 4n, token: TOKEN, minBorrowAmount: 9n, collateralCount: 10n ** 18n, beneficiary: ALICE, prepaidFeePercent: 25n, holder: ALICE }),
} as const

type Built = { chainId: number; address: Address; abi: Abi; functionName: string; args: readonly unknown[]; value?: bigint }

async function runOnce(call: Parameters<Action['run']>[0]) {
  const ref = createRef<Action>()
  let renderer!: TestRenderer.ReactTestRenderer
  await act(async () => {
    renderer = TestRenderer.create(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(Harness, { ref })))
  })
  let result: Awaited<ReturnType<Action['run']>> = null
  await act(async () => {
    result = await ref.current!.run(call)
  })
  await act(async () => renderer.unmount())
  return result as Awaited<ReturnType<Action['run']>>
}

describe('useReviewedAction', () => {
  it('sends the same calldata as useSafeTx for pay, cashOut, loan', async () => {
    confirmEveryReview()
    for (const [name, built] of Object.entries(REQUESTS) as [keyof typeof REQUESTS, Built][]) {
      const data = baseline[name].data as Hex
      const decoded = decodeFunctionData({ abi: built.abi, data })
      const result = await runOnce({ account: ALICE,
        calls: [{ chainId: built.chainId, to: built.address, data, value: built.value ?? 0n, abi: built.abi, functionName: decoded.functionName, args: decoded.args ?? [] }],
      })
      expect(result?.status).toBe('done')
      const sent = walletSends.at(-1)!
      expect({ chainId: sent.chainId, to: sent.to.toLowerCase(), data: sent.data, value: String(sent.value) }).toEqual({
        chainId: baseline[name].chainId,
        to: baseline[name].to.toLowerCase(),
        data: baseline[name].data,
        value: baseline[name].value,
      })
    }
  })

  it('uses the current same-account wallet after awaited preparation', async () => {
    confirmEveryReview()
    const replacementSend = vi.fn(walletClient.sendTransaction.getMockImplementation()!)
    const built = REQUESTS.pay as Built
    const result = await runOnce({
      account: ALICE,
      calls: [{ chainId: 10, to: built.address, data: baseline.pay.data as Hex, value: built.value ?? 0n }],
      reverify: async () => {
        await Promise.resolve()
        currentWallet = { ...walletClient, sendTransaction: replacementSend }
      },
    })
    expect(result?.status).toBe('done')
    expect(replacementSend).toHaveBeenCalledOnce()
  })

  it('keeps intent and legacy hold namespaces', async () => {
    confirmEveryReview()
    const built = REQUESTS.pay as Built
    const data = baseline.pay.data as Hex
    const intent = payIntent({ chainId: 10, project: 4n, beneficiary: ALICE })
    const legacy = ['jbm-pay-legacy-key']
    const call = { chainId: 10, to: built.address, data, value: built.value ?? 0n, intent, legacy }
    expect((await runOnce({ account: ALICE, calls: [call] }))?.status).toBe('done')
    // The send was held under its intent: the same intent, with another call, sees its settlement.
    const byIntent = writeHolds.open(
      { chainId: 10, account: ALICE, safe: false, namespace: intent, call: { to: built.address, data: '0x', value: 0n } },
      { legacy },
    )
    const state = byIntent.peek()
    expect(state.status === 'clear' ? state.settled?.result : state.status).toBe('success')
  })
})

describe('a run step as a flow shows it', () => {
  it('counts a done run, and a run ended on its last step with a Safe, as its last step reached', () => {
    const hash = `0x${'01'.repeat(32)}` as Hex
    // A resumed run reports no onSubmitted for the step that went through while away: only the result says so.
    expect(reachedLastStep({ status: 'done', hashes: [hash], receipts: [] }, 2)).toBe(true)
    expect(reachedLastStep({ status: 'proposed', step: 1, safeTxHash: hash }, 2)).toBe(true)
    expect(reachedLastStep({ status: 'proposed', step: 0, safeTxHash: hash }, 2)).toBe(false)
    expect(reachedLastStep(null, 2)).toBe(false)
  })

  it("follows core's step while the run is in flight, and the flow's own step otherwise", () => {
    expect(liveStep({ busy: true, step: 1 }, [1, 2], 0)).toBe(2)
    expect(liveStep({ busy: false, step: 1 }, [1, 2], 0)).toBe(0)
    expect(liveStep({ busy: true, step: 1 }, null, 0)).toBe(0)
    expect(liveStep({ busy: true, step: 5 }, [1, 2], 0)).toBe(0)
  })
})
