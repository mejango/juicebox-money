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
  SAFE_EXEC_ABI,
  safeProposalFor,
} from '@bananapus/nana-sdk-core/safe-service'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HELD_EXIT_LABEL } from '@bananapus/nana-sdk-core/review'
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
const SUCCESS = toEventSelector('ExecutionSuccess(bytes32,uint256)')
const WORD = `0x${'00'.repeat(32)}` as Hex
const AWAITING = 'Proposed to your Safe. Its other signers can approve it there.'
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

/** The held write's notice in place of an error: the SDK view it shows, and its action. */
function heldNotice(error: unknown) {
  if (!isValidElement(error)) throw new Error(`Expected a held write's notice, got ${String(error)}`)
  const { view, action } = (error as ReactElement<{ view: { line: string | null; exit: boolean }; action?: { label: string; run: () => unknown } | null }>).props
  return { line: view.line, exit: view.exit, label: action?.label, run: action ? () => action.run() : undefined }
}

/** The SDK's hold of every proposal this Safe made, as the app-wide notice lists them. */
async function heldProposals() {
  const { writeHolds } = await import('@/lib/write-holds')
  return writeHolds.list({ account: SAFE, chainId: 10 })
}

/** The page regains focus: every shown view asks the hold again. */
const refocus = () => act(async () => { globalThis.dispatchEvent?.(new Event('focus')) })

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

describe('a Safe proposal, held and followed by the SDK', () => {
  it('ends its confirm on Done while the signers decide, with the SDK line, and proposes the same call only once', async () => {
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
      phase: 'submitted', busy: false, settled: true, error: null, notice: AWAITING,
      safeProposalHash: PROPOSAL, safeNonceGuidance: 'Safe nonce guidance',
    })
    // The same call again, here or in a reopened flow, is the held proposal: never proposed twice.
    await act(async () => flow.tx.dismiss())
    await expect(flow.send()).resolves.toBe(PROPOSAL)
    await flow.close()
    const reopened = await mount()
    await expect(reopened.send()).resolves.toBe(PROPOSAL)
    expect(reopened.tx).toMatchObject({ phase: 'submitted', notice: AWAITING })
    expect(mocks.writeContract).toHaveBeenCalledOnce()
    await reopened.close()
  })

  it('settles once the hold settles its execution, and refreshes the chain display', async () => {
    const displayKey = ['projectDisplay', 6, 10, '1', 'currentRuleset']
    displayQueries.setQueryData(displayKey, { marker: true })
    const flow = await mount()
    await flow.send()
    await settle()
    expect(flow.tx.phase).toBe('submitted')
    // Safe's service names the execution to the hold, which reads its receipt.
    mocks.publicClient.waitForTransactionReceipt.mockImplementation(async ({ hash }: { hash: Hex }) => receiptOf(hash, PROPOSAL))
    const [held] = await heldProposals()
    await act(async () => { await held.handle.onExecuted(mocks.publicClient as never, EXECUTION) })
    await refocus()
    await until(() => flow.tx.phase === 'success', 5_000)
    expect(flow.tx).toMatchObject({ phase: 'success', hash: EXECUTION })
    expect(displayQueries.getQueryState(displayKey)?.isInvalidated).toBe(true)
    await flow.close()
  })

  it('is never proposed again when the Safe queue already holds it', async () => {
    const tx = safeProposalFor({ to: BOB, data: callData, value: 7n }, 3)
    mocks.findPendingSafeAppProposal.mockResolvedValue({ call: { to: BOB, data: callData, value: 7n }, proposalHash: PROPOSAL, tx })
    const flow = await mount()
    await expect(flow.send()).resolves.toBe(PROPOSAL)
    await settle()
    expect(mocks.writeContract).not.toHaveBeenCalled()
    expect(flow.tx).toMatchObject({ phase: 'submitted', notice: AWAITING })
    await flow.close()
  })

  it('holds one whose reply is not a 32-byte hash, and proposes nothing again until the exit', async () => {
    mocks.writeContract.mockResolvedValueOnce('0x1234')
    const flow = await mount()
    await flow.send()
    await settle()
    expect(mocks.writeContract).toHaveBeenCalledOnce()
    await act(async () => flow.tx.reset())
    await flow.send()
    await settle()
    expect(mocks.writeContract).toHaveBeenCalledOnce()
    await flow.close()
  })

  it("shows the hold's line and exit for a proposal its follower lost; only the exit proposes it again, through its review", async () => {
    const flow = await mount()
    await flow.send()
    await settle()
    const [held] = await heldProposals()
    await act(async () => { await held.handle.onUnproven(mocks.publicClient as never, PROPOSAL) })
    await refocus()
    await until(() => flow.tx.phase === 'unconfirmed', 5_000)
    const shown = heldNotice(flow.tx.error)
    expect(shown).toMatchObject({ exit: true, label: HELD_EXIT_LABEL })
    // Paying again proposes nothing: only the exit does.
    await act(async () => flow.tx.reset())
    await flow.send()
    expect(mocks.writeContract).toHaveBeenCalledOnce()
    mocks.writeContract.mockResolvedValueOnce(SECOND_PROPOSAL)
    await act(async () => { await heldNotice(flow.tx.error).run!() })
    await until(() => mocks.writeContract.mock.calls.length === 2, 5_000)
    expect(mocks.writeContract).toHaveBeenCalledTimes(2)
    expect(mocks.requestReview).toHaveBeenCalledTimes(2)
    await flow.close()
  })

  const NOW = 1_800_000_000n
  it.each(STAMPED_SITES)('is refused while proposed: %s, sent again with a later stamp after Done and after closing', async (_, build) => {
    const flow = await mount(STAMPED_CHAIN)
    await flow.send(build(NOW))
    await settle()
    expect(flow.tx).toMatchObject({ phase: 'submitted', notice: AWAITING })
    await act(async () => flow.tx.dismiss())
    await expect(flow.send(build(NOW + 600n))).resolves.toBe(PROPOSAL)
    await flow.close()
    const reopened = await mount(STAMPED_CHAIN)
    await expect(reopened.send(build(NOW + 1_200n))).resolves.toBe(PROPOSAL)
    expect(reopened.tx).toMatchObject({ phase: 'submitted', notice: AWAITING })
    expect(mocks.writeContract).toHaveBeenCalledOnce()
    expect(mocks.requestReview).toHaveBeenCalledOnce()
    await reopened.close()
  })

  it.each(STAMPED_SITES)('never holds %s against the same site with any other field changed', async (_, build) => {
    mocks.writeContract.mockResolvedValueOnce(PROPOSAL).mockResolvedValueOnce(SECOND_PROPOSAL)
    const flow = await mount(STAMPED_CHAIN)
    await flow.send(build(NOW))
    await act(async () => flow.tx.reset())
    await expect(flow.send(build(NOW + 600n, 1n))).resolves.toBe(SECOND_PROPOSAL)
    expect(mocks.writeContract).toHaveBeenCalledTimes(2)
    await flow.close()
  })

  it('refuses a proposal under its intent while a #128-era Safe hold of the call is unresolved, until its explicit exit', async () => {
    const { safeWriteHold } = await import('@/lib/write-holds')
    const old = safeWriteHold(10, SAFE, { to: BOB, data: callData, value: 7n })
    await old.send(mocks.publicClient as never, async gate => { await gate.beforeSend(); throw new Error('wallet transport disconnected') }).catch(() => null)
    const flow = await mount()
    await act(async () => { await flow.tx.send(request, { ...reviewedBySafe, intent: 'intent:test:transfer' }) })
    await settle()
    expect(mocks.writeContract).not.toHaveBeenCalled()
    await flow.close()
  })
})
