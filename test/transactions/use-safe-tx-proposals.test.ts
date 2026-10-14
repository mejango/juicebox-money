import { QueryClient } from '@tanstack/react-query'
import { createElement, createRef, forwardRef, isValidElement, useImperativeHandle, type ReactElement } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import {
  encodeFunctionData,
  parseAbi,
  toEventSelector,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem'
import {
  canonicalSafeTxHash,
  SAFE_EXEC_ABI,
  safeProposalFor,
} from '@bananapus/nana-sdk-core/safe-service'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { STAMPED_CHAIN, STAMPED_SITES } from '../support/stamped-sites'

// Safe proposals through useSafeTx. One registry holds every proposal made
// this session, shared by every flow, and follows each to its result: a flow
// that closes, remounts or changes chain never drops one, and never proposes
// the same call twice while one is pending.

const displayQueries = new QueryClient()
vi.mock('@tanstack/react-query', async importOriginal => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useQueryClient: () => displayQueries,
}))

const mocks = vi.hoisted(() => ({
  publicClient: {
    simulateContract: vi.fn(),
    estimateContractGas: vi.fn(),
    getTransaction: vi.fn(),
    waitForTransactionReceipt: vi.fn(),
    getTransactionReceipt: vi.fn(),
    getChainId: vi.fn(async () => 10),
    getBlock: vi.fn(),
  },
  chainId: 1,
  getAccount: vi.fn(),
  requestReview: vi.fn(),
  switchChain: vi.fn(),
  waitForSafeExecutionHash: vi.fn(),
  findPendingSafeAppProposal: vi.fn(),
  reportedSafeExecution: vi.fn(),
  watchSafeProposal: vi.fn(),
  atOnceExecution: vi.fn(),
  writeContract: vi.fn(),
}))

vi.mock('@wagmi/core', () => ({ getAccount: mocks.getAccount }))
vi.mock('wagmi', () => ({
  usePublicClient: () => mocks.publicClient,
  useSwitchChain: () => ({ switchChainAsync: mocks.switchChain }),
  useWaitForTransactionReceipt: () => ({ data: undefined, isError: false }),
  useWriteContract: () => ({ writeContractAsync: mocks.writeContract }),
}))
vi.mock('@/hooks/useWallet', () => ({
  useWallet: () => ({ isConnected: true, address: SAFE, isCenterWallet: false }),
}))
vi.mock('@/lib/transaction-review', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/transaction-review')>()),
  requestContractTransactionReview: mocks.requestReview,
}))
vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('@/lib/safe-connector', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/safe-connector')>()),
  isSafeConnection: () => true,
  SAFE_NONCE_GUIDANCE: 'Safe nonce guidance',
  useSafeConnection: () => true,
  waitForSafeExecutionHash: mocks.waitForSafeExecutionHash,
  findPendingSafeAppProposal: mocks.findPendingSafeAppProposal,
  reportedSafeExecution: mocks.reportedSafeExecution,
  watchSafeProposal: mocks.watchSafeProposal,
  atOnceExecution: mocks.atOnceExecution,
}))

/** The connected Safe app's Safe, which reviewed every request below. */
const SAFE = '0x1111111111111111111111111111111111111111' as Address
const BOB = '0x2222222222222222222222222222222222222222' as Address
/** What the Safe app returns: its proposal's safeTxHash. */
const PROPOSAL = `0x${'ab'.repeat(32)}` as Hex
const SECOND_PROPOSAL = `0x${'ac'.repeat(32)}` as Hex
/** The transaction an owner sends to execute it. */
const EXECUTION = `0x${'cd'.repeat(32)}` as Hex
/** A safeTxHash the app never saw, as a Safe{Wallet} that executed at once logs it. */
const UNSEEN = `0x${'ef'.repeat(32)}` as Hex
const SUCCESS = toEventSelector('ExecutionSuccess(bytes32,uint256)')
const FAILURE = toEventSelector('ExecutionFailure(bytes32,uint256)')
const WORD = `0x${'00'.repeat(32)}` as Hex
const AWAITING = 'Proposed to your Safe. Its other signers can approve it there.'
const UNCONFIRMED =
  'Safe proposal submitted, but confirmation is unavailable. Check Safe before taking another action.'
const reviewedBySafe = { reviewedAccount: SAFE }
const ABI = parseAbi(['function transfer(address to, uint256 amount)'])
const request = {
  chainId: 10,
  address: BOB,
  abi: ABI,
  functionName: 'transfer',
  args: [BOB, 5n] as readonly [Address, bigint],
  value: 7n,
  label: 'Transfer',
}
const callData = encodeFunctionData({ abi: ABI, functionName: 'transfer', args: [BOB, 5n] })

/** The Safe's execTransaction of the call to Bob, or of `data` in its place. */
const execTransaction = (data: Hex = callData) =>
  encodeFunctionData({
    abi: SAFE_EXEC_ABI,
    functionName: 'execTransaction',
    args: [BOB, 7n, data, 0, 0n, 0n, 0n, zeroAddress, zeroAddress, '0x'],
  })

/** The receipt of `transactionHash`, carrying the Safe's `topic` event for `safeTxHash`. */
const BLOCK = `0x${'99'.repeat(32)}` as Hex
const receiptOf = (transactionHash: Hex, safeTxHash: Hex, topic = SUCCESS) => ({
  status: 'success' as const,
  transactionHash,
  blockHash: BLOCK,
  blockNumber: 9n,
  transactionIndex: 0,
  from: BOB,
  to: SAFE,
  logs: [{ address: SAFE, topics: [topic, safeTxHash], data: WORD, removed: false, transactionHash, blockHash: BLOCK, blockNumber: 9n, transactionIndex: 0 }],
})

/** The browser's storage, shared by its tabs and kept across reloads. */
function browserStorage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
    /** Another tab released every held write, as its exit does: no settlement is left. */
    releaseAll: () => { for (const key of [...values.keys()]) if (key.startsWith('nana-sdk:reviewed-write')) values.delete(key) },
  }
}

/** The held write's notice in place of an error: what the write hold says. */
function heldState(error: unknown) {
  if (!isValidElement(error)) throw new Error(`Expected a held write's notice, got ${String(error)}`)
  return (error as ReactElement<{ state: { status: string; line: string; exit: boolean } }>).props.state
}

let useSafeTx: typeof import('@/hooks/useSafeTx').useSafeTx
type TxRequest = import('@/hooks/useSafeTx').TxRequest
type Value = ReturnType<typeof useSafeTx>

const Harness = forwardRef<Value, { chainId: number; phases?: string[] }>(function Harness(
  { chainId, phases },
  ref,
) {
  const value = useSafeTx(chainId)
  phases?.push(value.phase)
  useImperativeHandle(ref, () => value, [value])
  return null
})

/** One flow's useSafeTx, mounted on `chainId`. */
async function mount(chainId = 10, phases?: string[]) {
  const ref = createRef<Value>()
  let renderer!: TestRenderer.ReactTestRenderer
  await act(async () => {
    renderer = TestRenderer.create(createElement(Harness, { ref, chainId, phases }))
  })
  return {
    get tx() {
      return ref.current!
    },
    send: async (sent: TxRequest = request) => {
      let result: Hex | null = null
      await act(async () => {
        result = await ref.current!.send(sent, reviewedBySafe)
      })
      return result
    },
    changeChain: (next: number) =>
      act(async () => renderer.update(createElement(Harness, { ref, chainId: next, phases }))),
    close: () => act(async () => renderer.unmount()),
  }
}

/** Let the follow run until `done`, the hold's receipt retries included (each a poll apart). */
async function until(done: () => boolean, ms = 25_000) {
  const end = Date.now() + ms
  while (!done() && Date.now() < end) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 100)) })
  }
}

/** Let the registry's follow run. */
const settle = () =>
  act(async () => {
    for (let tick = 0; tick < 20; tick += 1) await new Promise(resolve => setTimeout(resolve, 0))
  })

/** Each proposal's wait, which the test ends when the Safe executes it. */
function signersDecide() {
  const executions = new Map<Hex, (hash: Hex) => void>()
  mocks.waitForSafeExecutionHash.mockImplementation(
    (_chain: number, proposal: Hex) => new Promise<Hex>(resolve => executions.set(proposal, resolve)),
  )
  return (proposal: Hex = PROPOSAL, execution: Hex = EXECUTION) => executions.get(proposal)!(execution)
}

/** The page each test is: an earlier page's follow loops never run into a later one's storage or mocks. */
let page = 0
function timersOfThisPage() {
  const mine = ++page
  const { setTimeout: later, setInterval: every } = globalThis
  vi.stubGlobal('setTimeout', ((run: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) =>
    later(() => { if (page === mine) run(...args) }, ms)) as typeof setTimeout)
  vi.stubGlobal('setInterval', ((run: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) =>
    every(() => { if (page === mine) run(...args) }, ms)) as typeof setInterval)
}

beforeEach(async () => {
  timersOfThisPage()
  displayQueries.clear()
  // The registry lives for the page: each test starts a page of its own.
  vi.resetModules()
  ;({ useSafeTx } = await import('@/hooks/useSafeTx'))
  mocks.chainId = 1
  mocks.getAccount.mockImplementation(() => ({ address: SAFE, chainId: mocks.chainId }))
  mocks.requestReview.mockReset().mockResolvedValue(true)
  mocks.switchChain.mockImplementation(async ({ chainId }: { chainId: number }) => { mocks.chainId = chainId })
  mocks.findPendingSafeAppProposal.mockReset().mockResolvedValue(null)
  mocks.reportedSafeExecution.mockReset().mockResolvedValue(null)
  // The watch ends nothing unless a test says so.
  mocks.watchSafeProposal.mockReset().mockImplementation(() => new Promise(() => {}))
  // One look at the chain, where the app's own probe looks a few times.
  mocks.atOnceExecution.mockReset().mockImplementation((client: typeof mocks.publicClient, hash: Hex) =>
    client.getTransaction({ hash }).then(
      (transaction: unknown) => transaction,
      () => null,
    ),
  )
  mocks.waitForSafeExecutionHash.mockReset().mockResolvedValue(EXECUTION)
  mocks.publicClient.simulateContract.mockResolvedValue({
    request: { address: BOB, functionName: 'transfer', gas: 100n },
  })
  mocks.publicClient.estimateContractGas.mockResolvedValue(50_000n)
  // A proposal's hash is no transaction; the execution is an owner's execTransaction of the call.
  mocks.publicClient.getTransaction.mockReset().mockImplementation(async ({ hash }: { hash: Hex }) => {
    if (hash !== EXECUTION) throw new TransactionNotFoundError({ hash })
    return { hash, chainId: 10, from: BOB, to: SAFE, input: execTransaction(), blockHash: BLOCK, blockNumber: 9n, transactionIndex: 0 }
  })
  // The receipt the write hold verifies: the execution's own, at a canonical block.
  // One node: a hash it shows as a transaction has the receipt its watcher reads; any other has none.
  mocks.publicClient.getTransactionReceipt.mockReset().mockImplementation(async ({ hash }: { hash: Hex }) => {
    const known = await mocks.publicClient.getTransaction({ hash }).then(() => true, () => false)
    if (!known) throw new TransactionReceiptNotFoundError({ hash })
    return mocks.publicClient.waitForTransactionReceipt({ hash })
  })
  mocks.publicClient.getBlock.mockReset().mockImplementation(async (args: { blockTag?: string; blockNumber?: bigint } = {}) =>
    args.blockNumber !== undefined
      ? { number: args.blockNumber, hash: args.blockNumber === 9n ? BLOCK : `0x${'98'.repeat(32)}` }
      : { number: 100n, hash: `0x${'97'.repeat(32)}`, timestamp: 1n })
  vi.stubGlobal('localStorage', browserStorage())
  mocks.publicClient.waitForTransactionReceipt
    .mockReset()
    .mockImplementation(async ({ hash }: { hash: Hex }) => receiptOf(hash, PROPOSAL))
  mocks.writeContract.mockReset().mockResolvedValue(PROPOSAL)
})

describe('a Safe proposal', () => {
  it('ends its confirm on Done while the signers decide, and settles once the Safe executes it', async () => {
    const execute = signersDecide()
    const displayKey = ['projectDisplay', 6, 10, '1', 'currentRuleset']
    displayQueries.setQueryData(displayKey, { marker: true })
    const flow = await mount()
    await flow.send()
    await settle()

    expect(mocks.requestReview).toHaveBeenCalledWith(
      { ...request, account: SAFE, safeTxGas: 0n },
      { label: 'Transfer', description: 'Safe nonce guidance', confirmLabel: 'Agree & continue to Safe' },
    )
    // A Safe app signs the sent gas as safeTxGas: 0 makes a failed call revert.
    expect(mocks.writeContract).toHaveBeenCalledWith(expect.objectContaining({ gas: 0n }))
    expect(flow.tx).toMatchObject({
      phase: 'submitted',
      busy: false,
      settled: true,
      error: null,
      notice: AWAITING,
      safeProposalHash: PROPOSAL,
      safeNonceGuidance: 'Safe nonce guidance',
    })
    expect(mocks.atOnceExecution).toHaveBeenCalledWith(mocks.publicClient, PROPOSAL)
    expect(mocks.waitForSafeExecutionHash).toHaveBeenCalledWith(10, PROPOSAL, {
      client: mocks.publicClient,
      signal: expect.any(AbortSignal),
    })

    expect(displayQueries.getQueryState(displayKey)?.isInvalidated).toBe(false)
    execute()
    await settle()
    expect(displayQueries.getQueryState(displayKey)?.isInvalidated).toBe(true)
    expect(flow.tx).toMatchObject({
      phase: 'success',
      busy: false,
      hash: EXECUTION,
      notice: null,
      safeProposalHash: null,
    })
    expect(flow.tx.receipt?.blockNumber).toBe(9n)
  })

  it('is followed after its flow closes, and a reopened flow is refused the same call until it settles', async () => {
    const execute = signersDecide()
    const first = await mount()
    await first.send()
    await settle()
    // Done while the signers decide does not release the call.
    await act(async () => first.tx.dismiss())
    await first.close()

    const reopened = await mount()
    await expect(reopened.send()).resolves.toBe(PROPOSAL)
    expect(mocks.writeContract).toHaveBeenCalledOnce()
    expect(mocks.requestReview).toHaveBeenCalledOnce()
    expect(reopened.tx).toMatchObject({ phase: 'submitted', notice: AWAITING })

    execute()
    await settle()
    expect(reopened.tx.phase).toBe('success')
    // Settled, the call is the user's again.
    await act(async () => reopened.tx.reset())
    await reopened.send()
    expect(mocks.writeContract).toHaveBeenCalledTimes(2)
  })

  it('survives a remount on another chain and back, as Move remounts: the same move is refused, another is taken', async () => {
    const execute = signersDecide()
    const before = await mount(10)
    await before.send()
    await settle()
    await before.close()
    await (await mount(8453)).close()

    const after = await mount(10)
    await after.send()
    expect(mocks.writeContract).toHaveBeenCalledOnce()
    expect(after.tx).toMatchObject({ phase: 'submitted', notice: AWAITING })
    execute()
    await settle()
    expect(after.tx.phase).toBe('success')

    mocks.writeContract.mockResolvedValueOnce(SECOND_PROPOSAL)
    await act(async () => after.tx.reset())
    await after.send({ ...request, args: [BOB, 6n] })
    expect(mocks.writeContract).toHaveBeenCalledTimes(2)
  })

  it('is followed on its own chain when the flow changes chain, as Redeem does', async () => {
    const execute = signersDecide()
    const flow = await mount(10)
    await flow.send()
    await settle()
    await flow.changeChain(8453)
    await act(async () => flow.tx.reset())
    await settle()
    expect(mocks.waitForSafeExecutionHash.mock.calls.map(([chain]) => chain)).toEqual([10])

    await flow.changeChain(10)
    await flow.send()
    expect(mocks.writeContract).toHaveBeenCalledOnce()
    expect(flow.tx).toMatchObject({ phase: 'submitted', notice: AWAITING })
    execute()
    await settle()
    expect(flow.tx.phase).toBe('success')
  })

  it("is never proposed again when the Safe's queue already holds it, here, after a reload or from another device", async () => {
    const hash = canonicalSafeTxHash(10, SAFE, safeProposalFor({ to: BOB, data: callData, value: 7n }, 5))
    mocks.findPendingSafeAppProposal.mockResolvedValue({
      proposalHash: hash,
      call: { to: BOB, data: callData, value: 7n },
    })
    mocks.publicClient.waitForTransactionReceipt.mockImplementation(async ({ hash: execution }: { hash: Hex }) =>
      receiptOf(execution, hash),
    )
    const flow = await mount()

    await expect(flow.send()).resolves.toBe(hash)
    await settle()
    expect(mocks.findPendingSafeAppProposal).toHaveBeenCalledWith(
      mocks.publicClient,
      10,
      SAFE,
      { to: BOB, data: callData, value: 7n },
    )
    expect(mocks.requestReview).not.toHaveBeenCalled()
    expect(mocks.writeContract).not.toHaveBeenCalled()
    expect(flow.tx).toMatchObject({ phase: 'success' })
    // A proposal from the queue is no reply: the chain is not probed for it.
    expect(mocks.atOnceExecution).not.toHaveBeenCalled()
    expect(mocks.waitForSafeExecutionHash).toHaveBeenCalledWith(10, hash, {
      client: mocks.publicClient,
      signal: expect.any(AbortSignal),
    })
  })

  it("asks no queue on a chain without Safe's service", async () => {
    const flow = await mount(11155420)
    await flow.send({ ...request, chainId: 11155420 })
    expect(mocks.findPendingSafeAppProposal).not.toHaveBeenCalled()
    expect(mocks.writeContract).toHaveBeenCalledOnce()
  })

  it('never shows an execution Safe{Wallet} returned at once as proposed', async () => {
    // The reply is the execution itself, and the Safe logs a safeTxHash the app never saw.
    mocks.publicClient.getTransaction.mockImplementation(async ({ hash }: { hash: Hex }) => ({
      hash,
      chainId: 10, blockHash: BLOCK, blockNumber: 9n, transactionIndex: 0,
      from: BOB,
      to: SAFE,
      input: execTransaction(),
    }))
    mocks.publicClient.waitForTransactionReceipt.mockImplementation(async ({ hash }: { hash: Hex }) =>
      receiptOf(hash, UNSEEN),
    )
    const phases: string[] = []
    const flow = await mount(10, phases)
    await flow.send()
    await settle()

    expect(flow.tx).toMatchObject({ phase: 'success', hash: PROPOSAL })
    expect(phases).not.toContain('submitted')
    expect(mocks.waitForSafeExecutionHash).not.toHaveBeenCalled()
  })

  it.each([
    ['ran the reviewed call', execTransaction(), 'success'],
    ['ran another call', execTransaction('0xdeadbeef'), 'unconfirmed'],
  ] as const)('settles an execution returned at once only when it %s', async (_, input, phase) => {
    // The execution is mined, as one returned at once is.
    mocks.publicClient.getTransaction.mockImplementation(async ({ hash }: { hash: Hex }) => ({
      hash,
      chainId: 10,
      from: BOB,
      to: SAFE,
      input,
      blockHash: BLOCK,
      blockNumber: 9n,
      transactionIndex: 0,
    }))
    mocks.publicClient.waitForTransactionReceipt.mockImplementation(async ({ hash }: { hash: Hex }) =>
      receiptOf(hash, UNSEEN),
    )
    const flow = await mount()
    await flow.send()
    await settle()
    expect(flow.tx.phase).toBe(phase)
    // Mined, its result unreadable: the write hold's line, and no exit yet.
    if (phase === 'unconfirmed') {
      expect(heldState(flow.tx.error)).toMatchObject({
        status: 'pending-known-hash', exit: false, line: "Your transaction is onchain, but its result can't be read yet.",
      })
    }
  })

  it.each([
    ['Safe 1.4, hash indexed', EXECUTION, (hash: Hex) => receiptOf(hash, PROPOSAL, FAILURE)],
    [
      'Safe 1.3, hash in data',
      EXECUTION,
      (hash: Hex) => ({
        ...receiptOf(hash, PROPOSAL),
        logs: [{ address: SAFE, topics: [FAILURE], data: `${PROPOSAL}${WORD.slice(2)}` as Hex }],
      }),
    ],
    ['executed at once', PROPOSAL, (hash: Hex) => receiptOf(hash, UNSEEN, FAILURE)],
  ] as const)('fails a proposal whose execution logged ExecutionFailure for it (%s)', async (_, execution, receipt) => {
    mocks.waitForSafeExecutionHash.mockResolvedValue(execution)
    mocks.publicClient.getTransaction.mockImplementation(async ({ hash }: { hash: Hex }) => {
      if (hash !== execution) throw new TransactionNotFoundError({ hash })
      return { hash, chainId: 10, from: BOB, to: SAFE, input: execTransaction(), blockHash: BLOCK, blockNumber: 9n, transactionIndex: 0 }
    })
    mocks.publicClient.waitForTransactionReceipt.mockImplementation(async ({ hash }: { hash: Hex }) => receipt(hash))
    const flow = await mount()
    await flow.send()
    await settle()
    expect(flow.tx).toMatchObject({
      phase: 'error',
      busy: false,
      error: `Safe executed the proposal, but the onchain transaction failed (${execution}).`,
    })
  })

  it.each([
    ['logged its failure', FAILURE, 'error'],
    ['logged its success', SUCCESS, 'success'],
  ] as const)(
    "settles a proposal Safe's service reports failed by the receipt its record names, which %s",
    async (_, topic, phase) => {
      const reported = new Error('Safe executed the proposal, but the onchain transaction failed.')
      mocks.waitForSafeExecutionHash.mockRejectedValue(reported)
      mocks.reportedSafeExecution.mockResolvedValue(EXECUTION)
      mocks.publicClient.waitForTransactionReceipt.mockImplementation(async ({ hash }: { hash: Hex }) =>
        receiptOf(hash, PROPOSAL, topic),
      )
      const flow = await mount()
      await flow.send()
      await settle()
      expect(mocks.reportedSafeExecution).toHaveBeenCalledWith(reported, 10, SAFE, PROPOSAL)
      expect(flow.tx).toMatchObject({ phase, hash: EXECUTION })
      if (phase === 'error') {
        expect(flow.tx.error).toBe(`Safe executed the proposal, but the onchain transaction failed (${EXECUTION}).`)
      }
    },
  )

  it("holds a proposal Safe's service reports failed without naming its execution, until Dismiss", async () => {
    mocks.waitForSafeExecutionHash.mockRejectedValue(
      new Error('Safe executed the proposal, but the onchain transaction failed.'),
    )
    const flow = await mount()
    await flow.send()
    await settle()
    expect(flow.tx).toMatchObject({ phase: 'unconfirmed', confirmationUncertain: true })
    expect(heldState(flow.tx.error)).toMatchObject({ status: 'safe-unproven', exit: true })
    await flow.send()
    await act(async () => flow.tx.dismiss())
    await flow.send()
    expect(mocks.writeContract).toHaveBeenCalledOnce()
    expect(heldState(flow.tx.error)).toMatchObject({ status: 'safe-unproven', exit: true })
  })

  it("holds a known proposal with unproven execution through reset and Dismiss", async () => {
    // The execution's events all belong to another proposal or another Safe.
    mocks.publicClient.waitForTransactionReceipt.mockImplementation(async ({ hash }: { hash: Hex }) => ({
      ...receiptOf(hash, UNSEEN, FAILURE),
      logs: [
        { address: SAFE, topics: [FAILURE, UNSEEN], data: WORD },
        { address: BOB, topics: [FAILURE, PROPOSAL], data: WORD },
      ],
    }))
    const flow = await mount()
    await flow.send()
    await settle()
    expect(flow.tx).toMatchObject({
      phase: 'submitted',
      busy: false,
      settled: true,
      confirmationUncertain: true,
      error: null,
      notice: UNCONFIRMED,
    })

    // A new review opens on its own state.
    await act(async () => flow.tx.reset())
    expect(flow.tx).toMatchObject({ phase: 'idle', notice: null })
    // The user never saw the line here, so the same call is refused, with it.
    await flow.send()
    expect(mocks.writeContract).toHaveBeenCalledOnce()
    expect(flow.tx).toMatchObject({ phase: 'submitted', notice: UNCONFIRMED })

    await act(async () => flow.tx.dismiss())
    expect(flow.tx).toMatchObject({ phase: 'idle', notice: null })
    await flow.send()
    expect(mocks.writeContract).toHaveBeenCalledOnce()
  })

  it('holds a proposal it lost track of with the SDK line and exit; only accepting the exit proposes it again', async () => {
    mocks.waitForSafeExecutionHash.mockRejectedValue(new Error('Safe service unavailable'))
    mocks.writeContract.mockResolvedValueOnce(PROPOSAL).mockResolvedValueOnce(SECOND_PROPOSAL)
    const flow = await mount()
    await flow.send()
    await settle()
    const shown = (flow.tx.error as ReactElement<{ state: { status: string; exit: boolean }; onExit?: () => void }>).props
    expect(flow.tx).toMatchObject({ phase: 'unconfirmed', busy: false, settled: true })
    expect(shown.state).toMatchObject({ status: 'safe-unproven', exit: true })
    // Sending again, or closing and reopening, proposes nothing.
    await flow.send()
    await act(async () => flow.tx.reset())
    await flow.send()
    await act(async () => flow.tx.dismiss())
    await flow.send()
    expect(mocks.writeContract).toHaveBeenCalledOnce()
    expect(heldState(flow.tx.error)).toMatchObject({ status: 'safe-unproven', exit: true })
    // Only the user's accepted exit proposes it again.
    await act(async () => (flow.tx.error as ReactElement<{ onExit?: () => void }>).props.onExit!())
    await settle()
    expect(mocks.writeContract).toHaveBeenCalledTimes(2)
  })

})

describe('a call stamped at send time', () => {
  /** A first send's stamp; the same action sent again takes a later one. */
  const NOW = 1_800_000_000n

  it.each(STAMPED_SITES)(
    'is refused while proposed: %s, sent again with a later stamp after Done and after closing',
    async (_, build) => {
      signersDecide()
      const flow = await mount(STAMPED_CHAIN)
      await flow.send(build(NOW))
      await settle()
      expect(flow.tx).toMatchObject({ phase: 'submitted', notice: AWAITING })

      // Done with the flow still open, as every flow's Done handler ends it,
      // then the same action reviewed and confirmed again.
      await act(async () => flow.tx.dismiss())
      await expect(flow.send(build(NOW + 600n))).resolves.toBe(PROPOSAL)
      expect(flow.tx).toMatchObject({ phase: 'submitted', notice: AWAITING })

      await flow.close()
      const reopened = await mount(STAMPED_CHAIN)
      await expect(reopened.send(build(NOW + 1_200n))).resolves.toBe(PROPOSAL)
      expect(reopened.tx).toMatchObject({ phase: 'submitted', notice: AWAITING })
      expect(mocks.writeContract).toHaveBeenCalledOnce()
      expect(mocks.requestReview).toHaveBeenCalledOnce()
      // Held here, the action is never looked up in the queue again.
      expect(mocks.findPendingSafeAppProposal).toHaveBeenCalledOnce()
    },
  )

  it.each(STAMPED_SITES)('never holds %s against the same site with any other field changed', async (_, build) => {
    signersDecide()
    mocks.writeContract.mockResolvedValueOnce(PROPOSAL).mockResolvedValueOnce(SECOND_PROPOSAL)
    const flow = await mount(STAMPED_CHAIN)
    await flow.send(build(NOW))
    await act(async () => flow.tx.reset())
    await expect(flow.send(build(NOW, 1n))).resolves.toBe(SECOND_PROPOSAL)
    expect(mocks.writeContract).toHaveBeenCalledTimes(2)
  })

  it("follows the queue's proposal of the action with an older stamp, and holds the action by it", async () => {
    signersDecide()
    const [, build] = STAMPED_SITES[0]
    const older = build(NOW)
    const call = {
      to: older.address,
      data: encodeFunctionData(older as Parameters<typeof encodeFunctionData>[0]),
      value: older.value ?? 0n,
    }
    const hash = canonicalSafeTxHash(STAMPED_CHAIN, SAFE, safeProposalFor(call, 5))
    mocks.findPendingSafeAppProposal.mockResolvedValueOnce({ proposalHash: hash, call })
    const flow = await mount(STAMPED_CHAIN)
    await expect(flow.send(build(NOW + 600n))).resolves.toBe(hash)
    await settle()
    expect(flow.tx).toMatchObject({ phase: 'submitted', notice: AWAITING, safeProposalHash: hash })

    await act(async () => flow.tx.reset())
    await expect(flow.send(build(NOW + 1_200n))).resolves.toBe(hash)
    expect(mocks.findPendingSafeAppProposal).toHaveBeenCalledOnce()
    expect(mocks.writeContract).not.toHaveBeenCalled()
  })
})

describe('a Safe proposal awaiting its signers', () => {
  const EXPIRED = "This Safe proposal's deadline passed. Review it again."
  const REPLACED = 'Another Safe transaction used this nonce. Propose it again to run it.'

  it.each([
    ['its deadline passed before the Safe ran it', 'expired', EXPIRED],
    ["the Safe's nonce moved past it without running it", 'replaced', REPLACED],
  ] as const)('ends when %s, and keeps its action held until the chain proves it', async (_, end, line) => {
    signersDecide()
    let watchEnds!: (end: string) => void
    mocks.watchSafeProposal.mockImplementationOnce(() => new Promise(resolve => (watchEnds = resolve)))
    mocks.writeContract.mockResolvedValueOnce(PROPOSAL).mockResolvedValueOnce(SECOND_PROPOSAL)
    const flow = await mount()
    await flow.send()
    await settle()
    expect(mocks.watchSafeProposal).toHaveBeenCalledWith(mocks.publicClient, 10, SAFE, PROPOSAL, expect.any(AbortSignal))
    const [, , , , watching] = mocks.watchSafeProposal.mock.lastCall!
    const [, , { signal: waiting }] = mocks.waitForSafeExecutionHash.mock.lastCall!

    watchEnds(end)
    await settle()
    expect(flow.tx).toMatchObject({ phase: 'error', busy: false, error: line, notice: null })
    // The wait for its execution stops with it.
    expect(waiting.aborted).toBe(true)
    expect(watching.aborted).toBe(true)

    // The write hold releases it only on the chain's proof, which this node can't give.
    await act(async () => flow.tx.reset())
    await expect(flow.send()).resolves.toBeNull()
    expect(mocks.writeContract).toHaveBeenCalledOnce()
    expect(heldState(flow.tx.error)).toMatchObject({ status: 'pending-known-hash', exit: false })
  })

  it('keeps waiting for the execution once a finalized block shows the Safe ran it', async () => {
    const execute = signersDecide()
    let watchEnds!: (end: string) => void
    mocks.watchSafeProposal.mockImplementationOnce(() => new Promise(resolve => (watchEnds = resolve)))
    const flow = await mount()
    await flow.send()
    await settle()
    watchEnds('executed')
    await settle()
    expect(flow.tx.phase).toBe('submitted')
    execute()
    await settle()
    expect(flow.tx.phase).toBe('success')
  })

  it("says the Safe ran it and never proposes it again, across reset and reload, when its execution can't be read", async () => {
    const values = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
      removeItem: (key: string) => { values.delete(key) },
    })
    let fail!: (reason: Error) => void
    mocks.waitForSafeExecutionHash.mockImplementation(() => new Promise((_, reject) => (fail = reject)))
    let watchEnds!: (end: string) => void
    mocks.watchSafeProposal.mockImplementationOnce(() => new Promise(resolve => (watchEnds = resolve)))
    mocks.writeContract.mockResolvedValueOnce(PROPOSAL).mockResolvedValueOnce(SECOND_PROPOSAL)
    const flow = await mount()
    await flow.send()
    await settle()
    watchEnds('executed')
    await settle()
    fail(new Error('Safe service unavailable'))
    await settle()
    const RAN = { phase: 'submitted', busy: false, settled: true, notice: 'Your Safe ran this transaction.' }
    expect(flow.tx).toMatchObject(RAN)

    // Done, then open it again: it is rechecked, never proposed again.
    await act(async () => flow.tx.reset())
    await expect(flow.send()).resolves.toBe(PROPOSAL)
    await settle()
    expect(flow.tx).toMatchObject(RAN)

    // A reload: the page's registry starts empty, the browser remembers it.
    vi.resetModules()
    ;({ useSafeTx } = await import('@/hooks/useSafeTx'))
    const reloaded = await mount()
    await expect(reloaded.send()).resolves.toBeNull()
    await settle()
    expect(reloaded.tx).toMatchObject({ phase: 'unconfirmed', busy: false, settled: true })
    // With no execution hash, the hold has nothing to settle it on here: held, never resent.
    expect(heldState(reloaded.tx.error)).toMatchObject({ exit: false })
    expect(mocks.writeContract).toHaveBeenCalledOnce()
  })

  it("shows success only once the write hold settles the execution, never from a receipt the chain doesn't show canonical", async () => {
    const execute = signersDecide()
    let canonical = false
    mocks.publicClient.getBlock.mockImplementation(async (args: { blockTag?: string; blockNumber?: bigint } = {}) =>
      args.blockNumber !== undefined
        ? { number: args.blockNumber, hash: canonical && args.blockNumber === 9n ? BLOCK : `0x${'98'.repeat(32)}` }
        : { number: 100n, hash: `0x${'97'.repeat(32)}`, timestamp: 1n })
    const phases: string[] = []
    const flow = await mount(10, phases)
    await flow.send()
    await settle()
    execute()
    await settle()
    expect(phases).not.toContain('success')
    canonical = true
    await until(() => flow.tx.phase === 'success')
    expect(flow.tx.phase).toBe('success')
  }, 30_000)

  it('never shows success when another tab released the hold while its execution was awaited, and says so plainly', async () => {
    const storage = browserStorage()
    vi.stubGlobal('localStorage', storage)
    const execute = signersDecide()
    const flow = await mount()
    await flow.send()
    await settle()
    storage.releaseAll()
    execute()
    await settle()
    expect(flow.tx.phase).not.toBe('success')
    expect(flow.tx.notice).toBe('This transaction is no longer held here. Check your wallet before sending it again.')
  })

  it('stops being watched once its execution is known', async () => {
    const execute = signersDecide()
    const flow = await mount()
    await flow.send()
    await settle()
    const [, , , , watching] = mocks.watchSafeProposal.mock.lastCall!
    expect(watching.aborted).toBe(false)
    execute()
    await settle()
    expect(flow.tx.phase).toBe('success')
    expect(watching.aborted).toBe(true)
  })

  it("is not watched on a chain without Safe's service", async () => {
    signersDecide()
    const flow = await mount(11155420)
    await flow.send({ ...request, chainId: 11155420 })
    await settle()
    expect(flow.tx.phase).toBe('submitted')
    expect(mocks.watchSafeProposal).not.toHaveBeenCalled()
  })
})

describe('an executed Safe proposal', () => {
  const PENDING_RECEIPT = 'Executed by your Safe. Confirming it onchain.'
  /** Lets `ms` of time pass for the follow. */
  const pass = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms)
    })

  beforeEach(() => {
    vi.useFakeTimers()
    // The node answers no receipt: each tracked wait gives up after its polls.
    mocks.publicClient.waitForTransactionReceipt.mockReset().mockRejectedValue(new Error('timed out'))
    mocks.publicClient.getTransactionReceipt
      .mockReset()
      .mockImplementation(async ({ hash }: { hash: Hex }) => {
        throw new TransactionReceiptNotFoundError({ hash })
      })
  })

  it('holds a known proposal while its receipt is missing, including after the confirmation horizon', async () => {
    const flow = await mount()
    await flow.send()
    await pass(0)
    expect(flow.tx).toMatchObject({ phase: 'pending', hash: EXECUTION })

    // One tracked wait (about three minutes) found no receipt.
    await pass(4 * 60_000)
    expect(flow.tx).toMatchObject({
      phase: 'submitted',
      settled: true,
      notice: PENDING_RECEIPT,
      confirmationUncertain: false,
      hash: EXECUTION,
    })
    await act(async () => flow.tx.dismiss())
    await flow.send()
    expect(mocks.writeContract).toHaveBeenCalledOnce()
    expect(flow.tx).toMatchObject({ phase: 'submitted', notice: PENDING_RECEIPT })

    await pass(50 * 60_000)
    expect(flow.tx.notice).toBe(PENDING_RECEIPT)
    await pass(10 * 60_000)
    expect(flow.tx).toMatchObject({ phase: 'submitted', confirmationUncertain: true, notice: UNCONFIRMED })
    await act(async () => flow.tx.dismiss())
    await flow.send()
    expect(mocks.writeContract).toHaveBeenCalledOnce()
  })

  it('settles once its receipt arrives within the hour', async () => {
    const flow = await mount()
    await flow.send()
    await pass(30 * 60_000)
    expect(flow.tx.notice).toBe(PENDING_RECEIPT)
    mocks.publicClient.getTransactionReceipt.mockImplementation(async ({ hash }: { hash: Hex }) =>
      receiptOf(hash, PROPOSAL),
    )
    await pass(5 * 60_000)
    expect(flow.tx).toMatchObject({ phase: 'success', hash: EXECUTION, notice: null })
  })
})

describe("a send that asks Safe's queue first", () => {
  it('shows the flow checking while the queue is read', async () => {
    let answer!: (queued: null) => void
    mocks.findPendingSafeAppProposal.mockImplementationOnce(() => new Promise(resolve => (answer = resolve)))
    const flow = await mount()
    let sent!: Promise<unknown>
    await act(async () => {
      sent = flow.tx.send(request, reviewedBySafe)
    })
    expect(flow.tx).toMatchObject({ phase: 'simulating', busy: true })
    expect(mocks.requestReview).not.toHaveBeenCalled()
    await act(async () => {
      answer(null)
      await sent
    })
    expect(mocks.requestReview).toHaveBeenCalledOnce()
    expect(mocks.writeContract).toHaveBeenCalledOnce()
  })
})

describe('a Safe proposal an app journal holds (Defifa)', () => {
  it('reports the follower giving up to the journal\'s own hold, so its exit appears and accepting it proposes exactly once more', async () => {
    const { defifaWriteHold, readDefifaWriteRecovery, sendRecoverableDefifaWrite, DEFIFA_RECOVERY_CHANGE_EVENT } = await import('@/lib/defifa-write-recovery')
    // The recovery card listens for this event.
    const changed = vi.fn()
    vi.stubGlobal('dispatchEvent', changed)
    const scope = { chainId: 10, projectId: 7, account: SAFE, action: 'transfer' as const }
    mocks.waitForSafeExecutionHash.mockRejectedValue(new Error('Safe service unavailable'))
    mocks.writeContract.mockResolvedValueOnce(PROPOSAL).mockResolvedValueOnce(SECOND_PROPOSAL)
    const flow = await mount()
    const sendThrough = () => act(async () => {
      await sendRecoverableDefifaWrite({ scope, request, safe: true, options: { ...reviewedBySafe, reviewedInParent: true },
        send: (sent, options) => flow.tx.send(sent, options) }).catch(() => null)
    })
    await sendThrough()
    await settle()
    const record = readDefifaWriteRecovery(scope)!
    const hold = defifaWriteHold(scope, record)
    // Read from storage alone it offers no exit; the chain's answer below does.
    expect(hold.peek()).toMatchObject({ status: 'safe-unproven', exit: false })
    expect(changed).toHaveBeenCalledWith(expect.objectContaining({ type: DEFIFA_RECOVERY_CHANGE_EVENT }))
    const shown = await hold.state(mocks.publicClient as never)
    expect(shown).toMatchObject({ status: 'safe-unproven', exit: true })
    await expect(hold.exit(shown, { checkedWallet: true }, mocks.publicClient as never)).resolves.toMatchObject({ released: true })
    await act(async () => flow.tx.reset())
    await sendThrough()
    expect(mocks.writeContract).toHaveBeenCalledTimes(2)
  })
})

describe('a queued Safe proposal this app adopts', () => {
  it('is saved in its write hold, so after it ends unproven and Done, a send the queue no longer matches proposes nothing and shows the exit', async () => {
    const queuedHash = canonicalSafeTxHash(10, SAFE, safeProposalFor({ to: BOB, data: callData, value: 7n }, 5))
    mocks.findPendingSafeAppProposal.mockResolvedValueOnce({ proposalHash: queuedHash, call: { to: BOB, data: callData, value: 7n } })
    mocks.waitForSafeExecutionHash.mockRejectedValue(new Error('Safe service unavailable'))
    const flow = await mount()
    await expect(flow.send()).resolves.toBe(queuedHash)
    await settle()
    expect(mocks.writeContract).not.toHaveBeenCalled()
    await act(async () => flow.tx.dismiss())
    // The queue lookup misses it now: the write hold still holds it.
    await flow.send()
    expect(mocks.writeContract).not.toHaveBeenCalled()
    expect(flow.tx.phase).toBe('unconfirmed')
    expect(heldState(flow.tx.error)).toMatchObject({ status: 'safe-unproven', exit: true })
    // Only the accepted exit proposes it.
    await act(async () => (flow.tx.error as ReactElement<{ onExit?: () => void }>).props.onExit!())
    await settle()
    expect(mocks.writeContract).toHaveBeenCalledOnce()
  })
})

describe('a queued Safe proposal an app journal adopts (Defifa)', () => {
  it("reports the adopted proposal's unproven end to the journal's hold, so its exit appears and accepting it proposes exactly once more", async () => {
    const { defifaWriteHold, readDefifaWriteRecovery, sendRecoverableDefifaWrite } = await import('@/lib/defifa-write-recovery')
    const scope = { chainId: 10, projectId: 8, account: SAFE, action: 'transfer' as const }
    const queuedHash = canonicalSafeTxHash(10, SAFE, safeProposalFor({ to: BOB, data: callData, value: 7n }, 5))
    // The Safe's queue already holds this exact call, and its execution can't be followed.
    mocks.findPendingSafeAppProposal.mockResolvedValueOnce({ proposalHash: queuedHash, call: { to: BOB, data: callData, value: 7n } })
    mocks.waitForSafeExecutionHash.mockRejectedValue(new Error('Safe service unavailable'))
    mocks.writeContract.mockResolvedValueOnce(SECOND_PROPOSAL)
    const flow = await mount()
    const sendThrough = () => act(async () => {
      await sendRecoverableDefifaWrite({ scope, request, safe: true, options: { ...reviewedBySafe, reviewedInParent: true },
        send: (sent, options) => flow.tx.send(sent, options) }).catch(() => null)
    })
    await sendThrough()
    await settle()
    expect(mocks.writeContract).not.toHaveBeenCalled()
    const record = readDefifaWriteRecovery(scope)!
    expect(record.hash).toBe(queuedHash)
    const hold = defifaWriteHold(scope, record)
    const shown = await hold.state(mocks.publicClient as never)
    expect(shown).toMatchObject({ status: 'safe-unproven', exit: true })
    await expect(hold.exit(shown, { checkedWallet: true }, mocks.publicClient as never)).resolves.toMatchObject({ released: true })
    await act(async () => flow.tx.reset())
    await sendThrough()
    expect(mocks.writeContract).toHaveBeenCalledOnce()
  })
})

describe('a Safe write keyed by its intent', () => {
  it('refuses a proposal under its intent while a #128-era Safe hold of the call is unresolved, until its explicit exit', async () => {
    const { safeHoldNamespace, safeProposalKey } = await import('@/lib/write-holds')
    const { createBrowserWriteRecovery, createHeldWriteStorage } = await import('@bananapus/nana-sdk-core/review')
    // A #128-era row: the Safe call held under its own namespace alone (no mirrors), its reply lost.
    const call = { to: BOB, data: callData, value: 7n }
    const legacy = createBrowserWriteRecovery({ chainId: 10, account: SAFE, safe: true,
      namespace: safeHoldNamespace(safeProposalKey(10, SAFE, call)), call }, { storage: createHeldWriteStorage() })
    await legacy.withLock(async () => { legacy.reserve() })
    const flow = await mount()
    const send = () => act(async () => { await flow.tx.send(request, { ...reviewedBySafe, intent: 'intent:transfer:test' }) })
    await send()
    expect(mocks.writeContract).not.toHaveBeenCalled()
    const shown = (flow.tx.error as ReactElement<{ state: { exit: boolean }; onExit?: () => void }>).props
    expect(shown.state.exit).toBe(true)
    await act(async () => shown.onExit!())
    await settle()
    expect(mocks.writeContract).toHaveBeenCalledOnce()
  })
})

describe('a Safe proposal lost track of in two flows', () => {
  it('stays held in every flow, with the exit, whichever flow is dismissed', async () => {
    mocks.waitForSafeExecutionHash.mockRejectedValue(new Error('Safe service unavailable'))
    const first = await mount()
    await first.send()
    await settle()
    const second = await mount()
    await second.send()
    expect(second.tx).toMatchObject({ phase: 'unconfirmed', confirmationUncertain: true })
    expect(heldState(second.tx.error)).toMatchObject({ status: 'safe-unproven', exit: true })

    await act(async () => second.tx.dismiss())
    await act(async () => first.tx.reset())
    await first.send()
    expect(mocks.writeContract).toHaveBeenCalledOnce()
    expect(heldState(first.tx.error)).toMatchObject({ status: 'safe-unproven', exit: true })
  })

})

describe("a Safe proposal's last look at the chain", () => {
  /** Lets `ms` of time pass for the follow. */
  const pass = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms)
    })
  const NO_RECORD = new Error("Safe's transaction service has no record of this proposal.")

  it('settles an execution returned at once that the probe missed, before it could end unproven', async () => {
    // Safe{Wallet} executed at once, and the node learned the execution only after the probe.
    mocks.atOnceExecution.mockResolvedValue(null)
    mocks.waitForSafeExecutionHash.mockRejectedValue(NO_RECORD)
    // A replica behind it answers every later read: the execution is bound on the one the look read.
    let reads = 0
    let caughtUp = false
    mocks.publicClient.getTransaction.mockImplementation(async ({ hash }: { hash: Hex }) => {
      reads += 1
      if (reads > 1 && !caughtUp) throw new TransactionNotFoundError({ hash })
      return { hash, chainId: 10, from: BOB, to: SAFE, input: execTransaction(), blockHash: BLOCK, blockNumber: 9n, transactionIndex: 0 }
    })
    mocks.publicClient.waitForTransactionReceipt.mockImplementation(async ({ hash }: { hash: Hex }) =>
      receiptOf(hash, UNSEEN),
    )
    const phases: string[] = []
    const flow = await mount(10, phases)
    await flow.send()
    await settle()
    // The registry bound the execution on its first read; success waits for the
    // write hold, which can't verify it while the node is behind.
    expect(phases).not.toContain('success')
    expect(mocks.writeContract).toHaveBeenCalledOnce()
    caughtUp = true
    await until(() => flow.tx.phase === 'success')
    expect(flow.tx).toMatchObject({ phase: 'success', hash: PROPOSAL, confirmationUncertain: false })
    expect(flow.tx.notice).toBeNull()
  }, 30_000)

  it("keeps a proposal held through a node that can't answer its last look, and looks again a minute later", async () => {
    vi.useFakeTimers()
    mocks.waitForSafeExecutionHash.mockRejectedValue(NO_RECORD)
    let nodeUp = false
    mocks.publicClient.getTransaction.mockImplementation(async ({ hash }: { hash: Hex }) => {
      if (!nodeUp) throw new Error('fetch failed')
      throw new TransactionNotFoundError({ hash })
    })
    const flow = await mount()
    await flow.send()
    await pass(0)
    // Never flagged on a node error: still with the Safe, and held.
    expect(flow.tx).toMatchObject({ phase: 'submitted', confirmationUncertain: false, notice: AWAITING })
    await act(async () => flow.tx.dismiss())
    await flow.send()
    expect(mocks.writeContract).toHaveBeenCalledOnce()

    nodeUp = true
    await pass(60_000)
    expect(flow.tx).toMatchObject({ phase: 'unconfirmed', confirmationUncertain: true })
    expect(heldState(flow.tx.error)).toMatchObject({ status: 'safe-unproven', exit: true })
  })

  it("keeps an execution held through a node that can't answer for its receipt after the hour", async () => {
    vi.useFakeTimers()
    mocks.publicClient.waitForTransactionReceipt.mockReset().mockRejectedValue(new Error('timed out'))
    let nodeUp = true
    mocks.publicClient.getTransactionReceipt.mockReset().mockImplementation(async ({ hash }: { hash: Hex }) => {
      if (!nodeUp) throw new Error('fetch failed')
      throw new TransactionReceiptNotFoundError({ hash })
    })
    const flow = await mount()
    await flow.send()
    await pass(57 * 60_000)
    expect(flow.tx.notice).toBe('Executed by your Safe. Confirming it onchain.')
    nodeUp = false
    await pass(10 * 60_000)
    expect(flow.tx).toMatchObject({ phase: 'submitted', confirmationUncertain: false })
    nodeUp = true
    await pass(60_000)
    expect(flow.tx).toMatchObject({ phase: 'submitted', confirmationUncertain: true, notice: UNCONFIRMED })
  })

  it("shows the hold's exit once an execution whose receipt it can't authenticate passes the mined window", async () => {
    vi.useFakeTimers()
    // Safe's service names the execution, but the node never shows its block canonical.
    mocks.publicClient.getBlock.mockImplementation(async (args: { blockTag?: string; blockNumber?: bigint } = {}) =>
      args.blockNumber !== undefined
        ? { number: args.blockNumber, hash: `0x${'98'.repeat(32)}` }
        : { number: 100n, hash: `0x${'97'.repeat(32)}`, timestamp: 1n })
    const flow = await mount()
    await flow.send()
    await pass(0)
    expect(flow.tx.phase).not.toBe('success')
    // Then Safe's service loses the proposal: nothing more will come from it.
    mocks.waitForSafeExecutionHash.mockRejectedValue(NO_RECORD)
    await pass(31 * 60_000)
    expect(flow.tx.phase).toBe('unconfirmed')
    expect(heldState(flow.tx.error)).toMatchObject({ status: 'held-unchecked', exit: true })
  })

  it('binds an execution returned at once on the transaction the probe read, whatever a later read says', async () => {
    mocks.atOnceExecution.mockResolvedValue({ hash: PROPOSAL, from: BOB, to: SAFE, input: execTransaction() })
    // A replica that hasn't imported the receipt's block has no transaction for it.
    let caughtUp = false
    mocks.publicClient.getTransaction.mockImplementation(async ({ hash }: { hash: Hex }) => {
      if (!caughtUp) throw new TransactionNotFoundError({ hash })
      return { hash, chainId: 10, from: BOB, to: SAFE, input: execTransaction(), blockHash: BLOCK, blockNumber: 9n, transactionIndex: 0 }
    })
    mocks.publicClient.waitForTransactionReceipt.mockImplementation(async ({ hash }: { hash: Hex }) =>
      receiptOf(hash, UNSEEN),
    )
    const phases: string[] = []
    const flow = await mount(10, phases)
    await flow.send()
    await settle()
    // Bound on the probe's read; success waits for the write hold to verify it.
    expect(phases).not.toContain('success')
    caughtUp = true
    await until(() => flow.tx.phase === 'success')
    expect(flow.tx).toMatchObject({ phase: 'success', hash: PROPOSAL })
  }, 30_000)

  it('asks a node behind the receipt again, held and able to end on Done, when no transaction is in hand', async () => {
    vi.useFakeTimers()
    // The SDK's wait found the reply on the chain: it was the execution, read by nobody here.
    mocks.atOnceExecution.mockResolvedValue(null)
    mocks.waitForSafeExecutionHash.mockResolvedValue(PROPOSAL)
    mocks.publicClient.waitForTransactionReceipt.mockImplementation(async ({ hash }: { hash: Hex }) =>
      receiptOf(hash, UNSEEN),
    )
    let caughtUp = false
    mocks.publicClient.getTransaction.mockImplementation(async ({ hash }: { hash: Hex }) => {
      // The receipt is in hand, so a not-found says only that this node is behind.
      if (!caughtUp) throw new TransactionNotFoundError({ hash })
      return { hash, chainId: 10, from: BOB, to: SAFE, input: execTransaction(), blockHash: BLOCK, blockNumber: 9n, transactionIndex: 0 }
    })
    const flow = await mount()
    await flow.send()
    await pass(0)
    expect(flow.tx).toMatchObject({
      phase: 'submitted',
      settled: true,
      confirmationUncertain: false,
      notice: 'Executed by your Safe. Confirming it onchain.',
    })
    await act(async () => flow.tx.dismiss())
    await flow.send()
    expect(mocks.writeContract).toHaveBeenCalledOnce()

    caughtUp = true
    await pass(60_000)
    expect(flow.tx).toMatchObject({ phase: 'success', hash: PROPOSAL })
  })

  it.each([SUCCESS, FAILURE])('retains a reverted proposal across dismiss/remount until an authenticated %s', async topic => {
    mocks.publicClient.waitForTransactionReceipt.mockImplementation(async ({ hash }: { hash: Hex }) => ({
      ...receiptOf(hash, PROPOSAL), status: 'reverted' as const,
    }))
    const flow = await mount()
    await flow.send()
    await settle()
    expect(flow.tx).toMatchObject({
      phase: 'submitted', safeProposalHash: PROPOSAL, notice: UNCONFIRMED, hash: EXECUTION,
    })
    await act(async () => flow.tx.dismiss())
    await flow.close()

    // A recheck follows the original proposal, without another wallet send.
    const execute = signersDecide()
    mocks.publicClient.waitForTransactionReceipt.mockImplementation(async ({ hash }: { hash: Hex }) =>
      receiptOf(hash, PROPOSAL, topic),
    )
    const resumed = await mount()
    await resumed.send()
    await settle()
    await resumed.send()
    expect(mocks.waitForSafeExecutionHash).toHaveBeenCalledTimes(2)
    expect(mocks.writeContract).toHaveBeenCalledOnce()
    expect(resumed.tx.phase).toBe('submitted')
    execute()
    await settle()
    expect(resumed.tx.phase).toBe(topic === SUCCESS ? 'success' : 'error')
    expect(mocks.writeContract).toHaveBeenCalledOnce()
  })

  it('retains a known reverted proposal when a later service look is unavailable, then releases on nonce proof', async () => {
    mocks.publicClient.waitForTransactionReceipt.mockImplementation(async ({ hash }: { hash: Hex }) => ({
      ...receiptOf(hash, PROPOSAL), status: 'reverted' as const,
    }))
    const flow = await mount()
    await flow.send()
    await settle()
    mocks.waitForSafeExecutionHash.mockRejectedValue(NO_RECORD)
    await act(async () => flow.tx.dismiss())
    await flow.send()
    await settle()
    expect(flow.tx).toMatchObject({ phase: 'submitted', safeProposalHash: PROPOSAL })
    expect(flow.tx.notice).toContain(UNCONFIRMED)
    expect(mocks.writeContract).toHaveBeenCalledOnce()
    await act(async () => flow.tx.dismiss())
    await flow.close()
    mocks.waitForSafeExecutionHash.mockImplementation(() => new Promise(() => {}))
    mocks.watchSafeProposal.mockResolvedValue('replaced')
    const resumed = await mount()
    await resumed.send()
    await settle()
    expect(resumed.tx).toMatchObject({ phase: 'error', error: 'Another Safe transaction used this nonce. Propose it again to run it.' })
    expect(mocks.writeContract).toHaveBeenCalledOnce()
  })

  it('fails a reverted execution returned at once without waiting on its transaction', async () => {
    mocks.atOnceExecution.mockResolvedValue(null)
    mocks.waitForSafeExecutionHash.mockResolvedValue(PROPOSAL)
    mocks.publicClient.waitForTransactionReceipt.mockImplementation(async ({ hash }: { hash: Hex }) => ({
      ...receiptOf(hash, UNSEEN),
      status: 'reverted' as const,
    }))
    mocks.publicClient.getTransaction.mockImplementation(async () => {
      throw new Error('fetch failed')
    })
    const flow = await mount()
    await flow.send()
    await settle()
    expect(flow.tx).toMatchObject({
      phase: 'error',
      error: `Safe executed the proposal, but the onchain transaction failed (${PROPOSAL}).`,
    })
  })
})

describe("a Safe app's reply", () => {
  it('holds one that is not a 32-byte hash with the exit, which proposes it again', async () => {
    mocks.writeContract.mockResolvedValueOnce('0x1234').mockResolvedValueOnce(PROPOSAL)
    const flow = await mount()
    await expect(flow.send()).resolves.toBeNull()
    expect(flow.tx).toMatchObject({ phase: 'unconfirmed', busy: false })
    expect(mocks.waitForSafeExecutionHash).not.toHaveBeenCalled()
    const held = (flow.tx.error as ReactElement<{ state: { status: string }; onExit?: () => void }>).props
    expect(held.state.status).toBe('held-no-hash')
    await act(async () => held.onExit!())
    await settle()
    expect(mocks.writeContract).toHaveBeenCalledTimes(2)
  })
})
