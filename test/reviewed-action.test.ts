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
import { openStepHold, payIntent, registerReviewHandler, ReviewLineError } from '@bananapus/nana-sdk-core/review'
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
let activeAccount: Address = ALICE
let acquireWallet: (() => Promise<typeof walletClient>) | undefined
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
  getAccount: () => ({ address: activeAccount, chainId: 10 }),
  getWalletClient: async () => {
    const wallet = acquireWallet ? await acquireWallet() : currentWallet
    return (await import('./support/viem-wallet')).viemWallet(tx => wallet.sendTransaction(tx as never), () => 10)
  },
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

import { liveStep, useReviewedAction } from '@/hooks/useReviewedAction'
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
  activeAccount = ALICE
  acquireWallet = undefined
  client.getTransactionReceipt.mockImplementation(async ({ hash }: { hash: Hex }) => receipt(hash))
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

  it.each(['account', 'expiry'])('actual SDK hook displays %s refusal after clearing its acquisition-time unsent hold', async drift => {
    confirmEveryReview()
    let entered!: () => void, release!: () => void
    const waiting = new Promise<void>(resolve => { entered = resolve })
    const blocked = new Promise<void>(resolve => { release = resolve })
    acquireWallet = async () => { entered(); await blocked; return currentWallet }
    const ref = createRef<Action>()
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => { renderer = TestRenderer.create(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(Harness, { ref }))) })
    let expired = false
    const intent = `acquisition-${crypto.randomUUID()}`
    const call = { chainId: 10, to: TERMINAL, data: baseline.pay.data as Hex, value: 10n ** 16n, intent }
    let pending!: ReturnType<Action['run']>
    await act(async () => { pending = ref.current!.run({ account: ALICE, calls: [call], assertWriteState: () => { if (expired) throw new ReviewLineError('The reviewed quote expired. Review again.') } }); await waiting })
    await act(async () => { if (drift === 'account') activeAccount = '0x2222222222222222222222222222222222222222'; else expired = true; release(); await pending })
    expect(ref.current!.error).toBe(drift === 'account' ? 'The connected account changed. Review again.' : 'The reviewed quote expired. Review again.')
    expect(ref.current!.phase).toBe('failed')
    expect(walletSends).toEqual([])
    expect(writeHolds.open({ chainId: 10, account: ALICE, safe: false, namespace: intent, call }).peek().status).toBe('clear')
    await act(async () => renderer.unmount())
  })

  it('keeps a send whose receipt is still confirming pending, and returns done once its hold verifies it', async () => {
    confirmEveryReview()
    const lagging = vi.fn(async (): Promise<ReturnType<typeof receipt>> => { throw new Error('lagging node') })
    client.getTransactionReceipt.mockImplementation(lagging)
    const ref = createRef<Action>()
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => { renderer = TestRenderer.create(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(Harness, { ref }))) })
    const built = REQUESTS.pay as Built
    const call = { chainId: 10, to: built.address, data: baseline.pay.data as Hex, value: built.value ?? 0n, intent: `lag-${crypto.randomUUID()}` }
    let ended: unknown = 'pending'
    await act(async () => { void ref.current!.run({ account: ALICE, calls: [call] }).then(value => { ended = value }) })
    await vi.waitFor(() => expect(ref.current!.phase).toBe('receipt'))
    expect(ended).toBe('pending')
    client.getTransactionReceipt.mockImplementation(async ({ hash }: { hash: Hex }) => receipt(hash))
    // The hold's next look, a few seconds on, verifies it.
    await act(async () => { await vi.waitFor(() => expect(ended).not.toBe('pending'), { timeout: 15_000, interval: 100 }) })
    expect(ended).toMatchObject({ status: 'done', hashes: [expect.any(String)] })
    expect(ref.current!.phase).toBe('done')
    expect(ref.current!.lastStepSent).toBe(true)
    await act(async () => renderer.unmount())
  }, 20_000)

  it('follows a last step whose receipt is unverified until its confirm closes, which keeps the step held', async () => {
    confirmEveryReview()
    client.getTransactionReceipt.mockImplementation(async () => { throw new Error('rpc outage') })
    const ref = createRef<Action>()
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => { renderer = TestRenderer.create(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(Harness, { ref }))) })
    const built = REQUESTS.pay as Built
    const call = { chainId: 10, to: built.address, data: baseline.pay.data as Hex, value: built.value ?? 0n, intent: `outage-${crypto.randomUUID()}` }
    let ended: unknown = 'pending'
    await act(async () => { void ref.current!.run({ account: ALICE, calls: [call], follow: { timeoutMs: 50 } }).then(value => { ended = value }) })
    await vi.waitFor(() => expect(ref.current!.following).toBe(true), { timeout: 15_000, interval: 50 })
    expect(ended).toBe('pending')

    await act(async () => { expect(ref.current!.dismiss()).toBe(true) })
    await vi.waitFor(() => expect(ended).toBeNull())
    // Core keeps following and showing a held last step until it settles.
    expect(ref.current!.following).toBe(true)
    // The hold keeps the sent step: it is never sent again from here.
    expect(openStepHold(writeHolds, ALICE, false, call).peek().status).not.toBe('clear')
    expect(walletSends).toHaveLength(1)
    await act(async () => renderer.unmount())
  }, 20_000)

  it('stops an approval run once its held receipt is dismissed: no later review for it, and a new action can start', async () => {
    let reviews = 0
    unregister.push(registerReviewHandler(async prompt => { reviews += 1; return prompt.confirmation }))
    const tag = crypto.randomUUID()
    const scope = `dismiss-${tag}`
    const calls = [
      { chainId: 10, to: TOKEN, data: '0x095ea7b3' as Hex, value: 0n, intent: `${scope}-approve` },
      { chainId: 10, to: TERMINAL, data: baseline.pay.data as Hex, value: 10n ** 16n, intent: `${scope}-pay`, dependsOnPrior: true },
    ]
    // The approval's receipt can't be read until its in-run follow times out: the hold has it.
    client.getTransactionReceipt.mockImplementation(async () => { throw new Error('lagging node') })
    const ref = createRef<Action>()
    let renderer!: TestRenderer.ReactTestRenderer
    const queries = new QueryClient()
    const invalidate = vi.spyOn(queries, 'invalidateQueries')
    await act(async () => { renderer = TestRenderer.create(createElement(QueryClientProvider, { client: queries }, createElement(Harness, { ref }))) })
    let ended: unknown = 'pending'
    await act(async () => { void ref.current!.run({ account: ALICE, calls, scope, follow: { timeoutMs: 50 } }).then(value => { ended = value }) })
    await vi.waitFor(() => expect(ref.current!.following).toBe(true), { timeout: 15_000, interval: 50 })
    // Two minutes on, the hold's look shows its pending line: the confirm can end on Done.
    const now = Date.now.bind(Date)
    const later = vi.spyOn(Date, 'now').mockImplementation(() => now() + 130_000)
    await vi.waitFor(() => expect(ref.current!.phase).toBe('held'), { timeout: 10_000, interval: 100 })
    later.mockRestore()
    expect(ref.current!.busy).toBe(false)
    expect(walletSends).toHaveLength(1)

    await act(async () => { expect(ref.current!.dismiss()).toBe(true) })
    await vi.waitFor(() => expect(ended).toBeNull())
    // The approval confirms: the dismissed run reviews nothing more.
    client.getTransactionReceipt.mockImplementation(async ({ hash }: { hash: Hex }) => receipt(hash))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 6_000)) })
    expect(reviews).toBe(1)
    // Its reads refresh once it settles, though nothing is left to show it.
    expect(invalidate).toHaveBeenCalled()
    expect(walletSends).toHaveLength(1)
    expect(ref.current!.phase).not.toBe('review')

    // A new action starts and is sent.
    let result: Awaited<ReturnType<Action['run']>> = null
    await act(async () => {
      result = await ref.current!.run({ account: ALICE, calls: [{ chainId: 10, to: TERMINAL, data: baseline.pay.data as Hex, value: 10n ** 16n + 1n, intent: `${scope}-new` }] })
    })
    expect(result).toMatchObject({ status: 'done' })
    expect(reviews).toBe(2)
    await act(async () => renderer.unmount())
  }, 40_000)

  // jbm's reset is refused while a run is in flight, so its page closing is the one way a run ends early.
  it('an unmount while the payment loads its wallet sends nothing more: one write', async () => {
    confirmEveryReview()
    let entered!: () => void, release!: () => void
    const waiting = new Promise<void>(resolve => { entered = resolve })
    const blocked = new Promise<void>(resolve => { release = resolve })
    // The approval is sent; the payment's wallet is still loading when the flow closes.
    acquireWallet = async () => { if (walletSends.length) { entered(); await blocked } return currentWallet }
    const ref = createRef<Action>()
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => { renderer = TestRenderer.create(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(Harness, { ref }))) })
    const scope = `close-${crypto.randomUUID()}`
    const calls = [
      { chainId: 10, to: TOKEN, data: '0x095ea7b3' as Hex, value: 0n, intent: `${scope}-approve` },
      { chainId: 10, to: TERMINAL, data: baseline.pay.data as Hex, value: 10n ** 16n, intent: `${scope}-pay` },
    ]
    let pending!: ReturnType<Action['run']>
    await act(async () => { pending = ref.current!.run({ account: ALICE, calls, scope }); await waiting })
    await act(async () => renderer.unmount())
    let result: unknown = 'pending'
    await act(async () => { release(); result = await pending })
    expect(result).toBeNull()
    expect(walletSends).toHaveLength(1)
  }, 20_000)

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
  it("follows core's step while the run is in flight, and the flow's own step otherwise", () => {
    expect(liveStep({ busy: true, step: 1 }, [1, 2], 0)).toBe(2)
    expect(liveStep({ busy: false, step: 1 }, [1, 2], 0)).toBe(0)
    expect(liveStep({ busy: true, step: 1 }, null, 0)).toBe(0)
    expect(liveStep({ busy: true, step: 5 }, [1, 2], 0)).toBe(0)
  })
})
