import { createElement, createRef, forwardRef, useImperativeHandle } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import {
  encodeFunctionData,
  parseAbi,
  toEventSelector,
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

const mocks = vi.hoisted(() => ({
  publicClient: {
    simulateContract: vi.fn(),
    estimateContractGas: vi.fn(),
    getTransaction: vi.fn(),
    waitForTransactionReceipt: vi.fn(),
    getTransactionReceipt: vi.fn(),
  },
  getAccount: vi.fn(),
  requestReview: vi.fn(),
  switchChain: vi.fn(),
  waitForSafeExecutionHash: vi.fn(),
  findPendingSafeAppProposal: vi.fn(),
  reportedSafeExecution: vi.fn(),
  watchSafeProposal: vi.fn(),
  executedAtOnce: vi.fn(),
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
  executedAtOnce: mocks.executedAtOnce,
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
const receiptOf = (transactionHash: Hex, safeTxHash: Hex, topic = SUCCESS) => ({
  status: 'success' as const,
  transactionHash,
  blockNumber: 9n,
  logs: [{ address: SAFE, topics: [topic, safeTxHash], data: WORD }],
})

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

beforeEach(async () => {
  // The registry lives for the page: each test starts a page of its own.
  vi.resetModules()
  ;({ useSafeTx } = await import('@/hooks/useSafeTx'))
  mocks.getAccount.mockImplementation(() => ({ address: SAFE }))
  mocks.requestReview.mockReset().mockResolvedValue(true)
  mocks.switchChain.mockResolvedValue(undefined)
  mocks.findPendingSafeAppProposal.mockReset().mockResolvedValue(null)
  mocks.reportedSafeExecution.mockReset().mockResolvedValue(null)
  // The watch ends nothing unless a test says so.
  mocks.watchSafeProposal.mockReset().mockImplementation(() => new Promise(() => {}))
  // One look at the chain, where the app's own probe looks a few times.
  mocks.executedAtOnce.mockReset().mockImplementation((client: typeof mocks.publicClient, hash: Hex) =>
    client.getTransaction({ hash }).then(
      () => true,
      () => false,
    ),
  )
  mocks.waitForSafeExecutionHash.mockReset().mockResolvedValue(EXECUTION)
  mocks.publicClient.simulateContract.mockResolvedValue({
    request: { address: BOB, functionName: 'transfer', gas: 100n },
  })
  mocks.publicClient.estimateContractGas.mockResolvedValue(50_000n)
  // A proposal's hash is no transaction; the execution is an owner's execTransaction of the call.
  mocks.publicClient.getTransaction.mockReset().mockImplementation(async ({ hash }: { hash: Hex }) => {
    if (hash !== EXECUTION) throw new Error('transaction not found')
    return { hash, from: BOB, to: SAFE, input: execTransaction() }
  })
  mocks.publicClient.waitForTransactionReceipt
    .mockReset()
    .mockImplementation(async ({ hash }: { hash: Hex }) => receiptOf(hash, PROPOSAL))
  mocks.writeContract.mockReset().mockResolvedValue(PROPOSAL)
})

describe('a Safe proposal', () => {
  it('ends its confirm on Done while the signers decide, and settles once the Safe executes it', async () => {
    const execute = signersDecide()
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
    expect(mocks.executedAtOnce).toHaveBeenCalledWith(mocks.publicClient, PROPOSAL)
    expect(mocks.waitForSafeExecutionHash).toHaveBeenCalledWith(10, PROPOSAL, {
      client: mocks.publicClient,
      signal: expect.any(AbortSignal),
    })

    execute()
    await settle()
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
    expect(mocks.executedAtOnce).not.toHaveBeenCalled()
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
    ['ran another call', execTransaction('0xdeadbeef'), 'submitted'],
  ] as const)('settles an execution returned at once only when it %s', async (_, input, phase) => {
    mocks.publicClient.getTransaction.mockImplementation(async ({ hash }: { hash: Hex }) => ({
      hash,
      from: BOB,
      to: SAFE,
      input,
    }))
    mocks.publicClient.waitForTransactionReceipt.mockImplementation(async ({ hash }: { hash: Hex }) =>
      receiptOf(hash, UNSEEN),
    )
    const flow = await mount()
    await flow.send()
    await settle()
    expect(flow.tx.phase).toBe(phase)
    if (phase === 'submitted') expect(flow.tx).toMatchObject({ notice: UNCONFIRMED, confirmationUncertain: true })
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
      if (hash !== execution) throw new Error('transaction not found')
      return { hash, from: BOB, to: SAFE, input: execTransaction() }
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
    expect(flow.tx).toMatchObject({
      phase: 'submitted',
      confirmationUncertain: true,
      notice: `${UNCONFIRMED} Safe executed the proposal, but the onchain transaction failed.`,
    })
    await flow.send()
    expect(mocks.writeContract).toHaveBeenCalledOnce()
    await act(async () => flow.tx.dismiss())
    await flow.send()
    expect(mocks.writeContract).toHaveBeenCalledTimes(2)
  })

  it("holds an unproven result through an open handler's reset, and releases it on Dismiss", async () => {
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
    expect(mocks.writeContract).toHaveBeenCalledTimes(2)
  })

  it('holds a proposal it lost track of until Dismiss, naming why', async () => {
    mocks.waitForSafeExecutionHash.mockRejectedValue(new Error('Safe service unavailable'))
    const flow = await mount()
    await flow.send()
    await settle()
    expect(flow.tx).toMatchObject({
      phase: 'submitted',
      confirmationUncertain: true,
      notice: `${UNCONFIRMED} Safe service unavailable`,
    })
    await flow.send()
    expect(mocks.writeContract).toHaveBeenCalledOnce()
    await act(async () => flow.tx.dismiss())
    await flow.send()
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

      // Done with the flow still open, then the same action reviewed and confirmed again.
      await act(async () => flow.tx.reset())
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
  const REPLACED = 'Safe moved past this proposal without running it. Review it again.'

  it.each([
    ['its deadline passed before the Safe ran it', 'expired', EXPIRED],
    ["the Safe's nonce moved past it without running it", 'replaced', REPLACED],
  ] as const)('ends when %s, and releases its action', async (_, end, line) => {
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

    await act(async () => flow.tx.reset())
    await expect(flow.send()).resolves.toBe(SECOND_PROPOSAL)
    expect(mocks.writeContract).toHaveBeenCalledTimes(2)
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
  const PENDING_RECEIPT = 'Executed by your Safe. Its receipt is not available yet.'
  /** Lets `ms` of time pass for the follow. */
  const pass = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms)
    })

  beforeEach(() => {
    vi.useFakeTimers()
    // The node answers no receipt: each tracked wait gives up after its polls.
    mocks.publicClient.waitForTransactionReceipt.mockReset().mockRejectedValue(new Error('timed out'))
    mocks.publicClient.getTransactionReceipt.mockReset().mockRejectedValue(new Error('receipt not found'))
  })

  it('is held, shown with its line and never dismissed, while its receipt is missing for an hour, then ends unproven', async () => {
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
    expect(mocks.writeContract).toHaveBeenCalledTimes(2)
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
