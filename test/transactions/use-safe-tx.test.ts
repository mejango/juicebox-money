import { QueryClient } from '@tanstack/react-query'
import { createElement, createRef, forwardRef, isValidElement, useImperativeHandle, type ReactElement } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import {
  encodeFunctionData,
  parseAbi,
  TransactionNotFoundError,
  UserRejectedRequestError,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem'
import { SAFE_EXEC_ABI } from '@bananapus/nana-sdk-core/safe-service'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const displayQueries = new QueryClient()
vi.mock('@tanstack/react-query', async importOriginal => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useQueryClient: () => displayQueries,
}))

const mocks = vi.hoisted(() => ({
  account: undefined as Address | undefined,
  chainId: 1,
  connectorUid: 'reviewed-wallet',
  centerWallet: false,
  connected: true,
  publicClient: {
    simulateContract: vi.fn(),
    estimateContractGas: vi.fn(),
    getTransaction: vi.fn(),
    getChainId: vi.fn(async () => 10),
    // The account's next nonce, read before each wallet send.
    getBlockNumber: vi.fn(async () => 100n),
    getTransactionCount: vi.fn(async () => 3),
  },
  receipt: { data: undefined, isError: false } as {
    data?: {
      status: 'success' | 'reverted'
      blockNumber?: bigint
      transactionHash: string
      logs?: { address: string; topics: readonly `0x${string}`[]; data: `0x${string}` }[]
    }
    isError: boolean
  },
  getAccount: vi.fn(),
  requestReview: vi.fn(),
  safeConnection: false,
  switchChain: vi.fn(),
  waitForSafeExecutionHash: vi.fn(),
  findPendingSafeAppProposal: vi.fn(),
  writeContract: vi.fn(),
}))

vi.mock('@wagmi/core', () => ({
  getAccount: mocks.getAccount,
}))
vi.mock('wagmi', () => ({
  usePublicClient: () => mocks.publicClient,
  useSwitchChain: () => ({ switchChainAsync: mocks.switchChain }),
  useWaitForTransactionReceipt: () => mocks.receipt,
  useWriteContract: () => ({ writeContractAsync: mocks.writeContract }),
}))
vi.mock('@/hooks/useWallet', () => ({
  useWallet: () => ({
    isConnected: mocks.connected,
    address: mocks.account,
    isCenterWallet: mocks.centerWallet,
  }),
}))
vi.mock('@/lib/transaction-review', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/transaction-review')>()),
  requestContractTransactionReview: mocks.requestReview,
}))
vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('@/lib/safe-connector', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/safe-connector')>()),
  isSafeConnection: () => mocks.safeConnection,
  SAFE_NONCE_GUIDANCE: 'Safe nonce guidance',
  useSafeConnection: () => mocks.safeConnection,
  waitForSafeExecutionHash: mocks.waitForSafeExecutionHash,
  // The Safe proposal suite covers the queue lookup; nothing is queued here.
  findPendingSafeAppProposal: mocks.findPendingSafeAppProposal,
}))

import { useSafeTx } from '@/hooks/useSafeTx'
import { writeHolds } from '@/lib/write-holds'
import { createBrowserWriteRecovery, createHeldWriteStorage, type WriteHeldState } from '@bananapus/nana-sdk-core/review'
import { clearViewAs, setViewAs, VIEW_AS_WRITE_BLOCKED } from '@/lib/viewAs'

const ALICE = '0x1111111111111111111111111111111111111111' as Address
const BOB = '0x2222222222222222222222222222222222222222' as Address
/** Every request below was built for, and reviewed by, Alice. */
const reviewedByAlice = { reviewedAccount: ALICE }
const HASH = `0x${'ab'.repeat(32)}` as const
const EXECUTION_HASH = `0x${'cd'.repeat(32)}` as const
const ABI = parseAbi(['function transfer(address to, uint256 amount)'])
const request = {
  chainId: 10,
  address: BOB,
  abi: ABI,
  functionName: 'transfer',
  args: [BOB, 5n] as const,
  value: 7n,
  label: 'Transfer',
}

/** Alice's Safe running `data` as the call to Bob that `request` reviews, as an owner sends it. */
const execTransaction = (data: Hex = encodeFunctionData({ abi: ABI, functionName: 'transfer', args: [BOB, 5n] })) =>
  encodeFunctionData({
    abi: SAFE_EXEC_ABI,
    functionName: 'execTransaction',
    args: [BOB, 7n, data, 0, 0n, 0n, 0n, zeroAddress, zeroAddress, '0x'],
  })

type SafeTxValue = ReturnType<typeof useSafeTx>

/** The held write's notice in place of an error: its props, with the exit. */
function heldNotice(error: SafeTxValue['error']) {
  if (!isValidElement(error)) throw new Error(`Expected a held write's notice, got ${String(error)}`)
  const { chainId, state, onExit } = (error as ReactElement<{ chainId: number; state: WriteHeldState; onExit?: () => void }>).props
  return {
    chainId,
    status: state.status,
    line: state.line,
    hash: ('hash' in state ? state.hash : state.record.hash) ?? null,
    value: state.record.call.value,
    onExit,
  }
}

const Harness = forwardRef<SafeTxValue>(function Harness(_, ref) {
  const value = useSafeTx(10)
  useImperativeHandle(ref, () => value, [value])
  return null
})

async function renderHook() {
  const ref = createRef<SafeTxValue>()
  let renderer!: TestRenderer.ReactTestRenderer
  await act(async () => {
    renderer = TestRenderer.create(createElement(Harness, { ref }))
  })
  return { ref, renderer }
}

/** A browser's storage: shared by its tabs and kept across reloads. */
function browserStorage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
  }
}

const basePublicClient = mocks.publicClient
const MINED_BLOCK = `0x${'55'.repeat(32)}` as Hex
/** `hash`'s receipt in canonical block 5. */
function mined(hash: string, status: 'success' | 'reverted' = 'success') {
  return { status, transactionHash: hash, blockHash: MINED_BLOCK, blockNumber: 5n, from: BOB, to: ALICE, transactionIndex: 0, logs: [] }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', browserStorage())
  mocks.publicClient = basePublicClient
  displayQueries.clear()
  mocks.account = ALICE
  mocks.chainId = 1
  mocks.connectorUid = 'reviewed-wallet'
  mocks.findPendingSafeAppProposal.mockResolvedValue(null)
  mocks.centerWallet = false
  mocks.connected = true
  mocks.receipt = { data: undefined, isError: false }
  mocks.getAccount.mockImplementation(() => ({ address: mocks.account, chainId: mocks.chainId, connector: { uid: mocks.connectorUid } }))
  mocks.requestReview.mockResolvedValue(true)
  mocks.safeConnection = false
  mocks.switchChain.mockImplementation(async ({ chainId }: { chainId: number }) => { mocks.chainId = chainId })
  mocks.waitForSafeExecutionHash.mockResolvedValue(EXECUTION_HASH)
  // Every transaction the chain shows is mined in block 5, canonical, so the
  // write hold can verify a receipt (a test that needs otherwise says so).
  mocks.publicClient.getTransaction.mockImplementation(async ({ hash }: { hash: Hex }) => ({
    hash,
    chainId: 10,
    from: BOB,
    to: ALICE,
    input: execTransaction(),
    nonce: 3,
    blockHash: MINED_BLOCK,
    blockNumber: 5n,
    transactionIndex: 0,
  }))
  ;(mocks.publicClient as Record<string, unknown>).getTransactionReceipt = vi.fn(async ({ hash }: { hash: Hex }) =>
    mined(hash, mocks.receipt.data?.transactionHash?.toLowerCase() === hash.toLowerCase() ? mocks.receipt.data.status : 'success'))
  ;(mocks.publicClient as Record<string, unknown>).getBlock = vi.fn(async (args: { blockTag?: string; blockNumber?: bigint } = {}) =>
    args.blockTag === 'finalized'
      ? { number: 4n, hash: `0x${'44'.repeat(32)}`, timestamp: 1n }
      : { number: args.blockNumber ?? 6n, hash: args.blockNumber === 5n ? MINED_BLOCK : `0x${'66'.repeat(32)}` })
  mocks.publicClient.simulateContract.mockResolvedValue({
    request: { address: BOB, functionName: 'transfer', gas: 100n },
  })
  mocks.publicClient.estimateContractGas.mockResolvedValue(50_000n)
  mocks.writeContract.mockResolvedValue(HASH)
})

describe('useSafeTx', () => {
  it('refuses to send while view-as is active', async () => {
    setViewAs(BOB)
    try {
      const hook = await renderHook()
      let result: Awaited<ReturnType<SafeTxValue['send']>> = 'unset' as never

      await act(async () => {
        result = await hook.ref.current!.send(request, reviewedByAlice)
      })

      expect(result).toBeNull()
      expect(hook.ref.current).toMatchObject({
        phase: 'error',
        error: VIEW_AS_WRITE_BLOCKED,
      })
      expect(mocks.requestReview).not.toHaveBeenCalled()
      expect(mocks.writeContract).not.toHaveBeenCalled()
    } finally {
      clearViewAs()
    }
  })

  it('refuses connector replacement during the initial Safe queue lookup', async () => {
    mocks.safeConnection = true
    let release!: (value: null) => void
    mocks.findPendingSafeAppProposal.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const hook = await renderHook()
    let sending!: Promise<Hex | null>
    await act(async () => { sending = hook.ref.current!.send(request, reviewedByAlice) })
    expect(mocks.findPendingSafeAppProposal).toHaveBeenCalledOnce()
    mocks.connectorUid = 'replacement-wallet'
    await act(async () => { release(null); await sending })
    expect(mocks.writeContract).not.toHaveBeenCalled()
    expect(hook.ref.current!.error).toContain('wallet changed')
  })

  it('requests the transaction without a redundant switch when already on its chain', async () => {
    mocks.getAccount.mockImplementation(() => ({ address: ALICE, chainId: 10 }))
    const hook = await renderHook()
    await act(async () => { await hook.ref.current!.send(request, reviewedByAlice) })
    expect(mocks.switchChain).not.toHaveBeenCalled()
    expect(mocks.writeContract).toHaveBeenCalledOnce()
    await act(async () => hook.renderer.unmount())
  })

  it('wallet-action:submit-a-reviewed-direct-write runs exact review, chain/account checks, simulation, and the simulated write', async () => {
    const hook = await renderHook()
    let result: Awaited<ReturnType<SafeTxValue['send']>> = null

    await act(async () => {
      result = await hook.ref.current!.send(request, reviewedByAlice)
    })

    expect(result).toBe(HASH)
    expect(mocks.requestReview).toHaveBeenCalledWith(
      { ...request, account: ALICE },
      { label: 'Transfer' },
    )
    expect(mocks.switchChain).toHaveBeenCalledWith({ chainId: 10 })
    expect(mocks.publicClient.simulateContract).toHaveBeenCalledWith({
      address: BOB,
      abi: ABI,
      functionName: 'transfer',
      args: [BOB, 5n],
      value: 7n,
      account: ALICE,
    })
    expect(mocks.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ chainId: request.chainId, gas: 100_000n }),
    )
    expect(hook.ref.current).toMatchObject({
      phase: 'pending',
      busy: true,
      hash: HASH,
    })
  })

  it('anchors a dependent simulation to its confirmed prerequisite block', async () => {
    const hook = await renderHook()

    await act(async () => {
      await hook.ref.current!.send(request, { ...reviewedByAlice, simulationBlockNumber: 12_345n })
    })

    expect(mocks.publicClient.simulateContract).toHaveBeenCalledWith(
      expect.objectContaining({ blockNumber: 12_345n }),
    )
  })

  it('skips only the duplicate app review when the parent already showed the exact call', async () => {
    const hook = await renderHook()

    await act(async () => {
      await hook.ref.current!.send(request, { ...reviewedByAlice, reviewedInParent: true })
    })

    expect(mocks.requestReview).not.toHaveBeenCalled()
    expect(mocks.switchChain).toHaveBeenCalledWith({ chainId: 10 })
    expect(mocks.publicClient.simulateContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: BOB, account: ALICE }),
    )
    expect(mocks.writeContract).toHaveBeenCalled()
  })

  it('cancels without switching, simulating, or signing', async () => {
    mocks.requestReview.mockResolvedValueOnce(false)
    const hook = await renderHook()

    await act(async () => {
      await expect(hook.ref.current!.send(request, reviewedByAlice)).resolves.toBeNull()
    })

    expect(hook.ref.current!.phase).toBe('idle')
    expect(mocks.switchChain).not.toHaveBeenCalled()
    expect(mocks.publicClient.simulateContract).not.toHaveBeenCalled()
    expect(mocks.writeContract).not.toHaveBeenCalled()
  })

  it('blocks a duplicate while review is open', async () => {
    let finishReview!: (approved: boolean) => void
    mocks.requestReview.mockImplementationOnce(
      () => new Promise<boolean>(resolve => (finishReview = resolve)),
    )
    const hook = await renderHook()

    await act(async () => {
      const first = hook.ref.current!.send(request, reviewedByAlice)
      await Promise.resolve()
      await expect(hook.ref.current!.send(request, reviewedByAlice)).resolves.toBeNull()
      finishReview(false)
      await first
    })

    expect(mocks.requestReview).toHaveBeenCalledTimes(1)
    expect(hook.ref.current!.phase).toBe('idle')
  })

  it.each([
    ['its own review', {}],
    ['a review its parent showed', { reviewedInParent: true }],
  ])(
    'refuses, before %s opens, a request reviewed for another account',
    async (_, options) => {
      mocks.account = BOB
      const beforeWrite = vi.fn()
      const hook = await renderHook()

      await act(async () => {
        await expect(
          hook.ref.current!.send(request, { ...options, reviewedAccount: ALICE, beforeWrite }),
        ).resolves.toBeNull()
      })

      expect(hook.ref.current).toMatchObject({
        phase: 'error',
        busy: false,
        error: 'The connected account changed. Review again.',
      })
      expect(mocks.requestReview).not.toHaveBeenCalled()
      expect(mocks.switchChain).not.toHaveBeenCalled()
      expect(beforeWrite).not.toHaveBeenCalled()
      expect(mocks.publicClient.simulateContract).not.toHaveBeenCalled()
      expect(mocks.writeContract).not.toHaveBeenCalled()
    },
  )

  it('refuses a request whose reviewed account was switched away while its review was open', async () => {
    mocks.requestReview.mockImplementationOnce(async () => {
      mocks.account = BOB
      return true
    })
    const hook = await renderHook()

    await act(async () => {
      await hook.ref.current!.send(request, { reviewedAccount: ALICE })
    })

    expect(hook.ref.current!.error).toBe('The connected account changed. Review again.')
    expect(mocks.publicClient.simulateContract).not.toHaveBeenCalled()
    expect(mocks.writeContract).not.toHaveBeenCalled()
  })

  it('reviews, simulates and sends as the account the request was reviewed for', async () => {
    const hook = await renderHook()

    await act(async () => {
      await hook.ref.current!.send(request, { reviewedAccount: ALICE })
    })

    expect(mocks.requestReview).toHaveBeenCalledWith({ ...request, account: ALICE }, { label: 'Transfer' })
    expect(mocks.publicClient.simulateContract).toHaveBeenCalledWith(expect.objectContaining({ account: ALICE }))
    expect(mocks.writeContract).toHaveBeenCalledOnce()
  })

  it('fails before simulation when switching changes the account', async () => {
    mocks.switchChain.mockImplementationOnce(async () => {
      mocks.account = BOB
    })
    const hook = await renderHook()

    await act(async () => {
      await hook.ref.current!.send(request, reviewedByAlice)
    })

    expect(hook.ref.current).toMatchObject({ phase: 'error', busy: false })
    expect(hook.ref.current!.error).toMatch(/account changed/i)
    expect(mocks.publicClient.simulateContract).not.toHaveBeenCalled()
    expect(mocks.writeContract).not.toHaveBeenCalled()
  })

  it('fails before signing when the account changes during simulation', async () => {
    mocks.publicClient.simulateContract.mockImplementationOnce(async () => {
      mocks.account = BOB
      return { request: { gas: 100n } }
    })
    const hook = await renderHook()

    await act(async () => {
      await hook.ref.current!.send(request, reviewedByAlice)
    })

    expect(hook.ref.current!.error).toMatch(/account changed/i)
    expect(mocks.writeContract).not.toHaveBeenCalled()
  })

  it.each([
    ['simulation', 'chain'], ['simulation', 'view-as'],
    ['persistence', 'chain'], ['persistence', 'view-as'],
  ] as const)('refuses %s-time %s drift at the final shared boundary', async (phase, changed) => {
    let release!: () => void
    let entered!: () => void
    const waiting = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { entered = resolve })
    const pause = async () => { entered(); await waiting }
    if (phase === 'simulation') {
      mocks.publicClient.simulateContract.mockImplementationOnce(async () => {
        await pause()
        return { request: { address: BOB, functionName: 'transfer', gas: 100n } }
      })
    }
    const onBeforeWriteAborted = vi.fn()
    const onWriteRejected = vi.fn()
    const hook = await renderHook()
    try {
      await act(async () => {
        const sent = hook.ref.current!.send(request, {
          ...reviewedByAlice,
          beforeWrite: phase === 'persistence' ? pause : undefined,
          onBeforeWriteAborted,
          onWriteRejected,
        })
        await started
        if (changed === 'chain') mocks.chainId = 8453
        else setViewAs(BOB)
        release()
        expect(await sent).toBeNull()
      })
      expect(mocks.writeContract).not.toHaveBeenCalled()
      expect(onBeforeWriteAborted).toHaveBeenCalledTimes(phase === 'persistence' ? 1 : 0)
      expect(onWriteRejected).not.toHaveBeenCalled()
      expect(hook.ref.current!.error).toBe(changed === 'chain'
        ? 'Connected wallet changed. Review the transaction again.'
        : VIEW_AS_WRITE_BLOCKED)
    } finally {
      clearViewAs()
      await act(async () => hook.renderer.unmount())
    }
  })

  it('invalidates only the confirmed chain display evidence after a successful receipt', async () => {
    const key = ['projectDisplay', 6, 10, '1', 'currentRuleset']
    const other = ['projectDisplay', 6, 1, '1', 'currentRuleset']
    displayQueries.setQueryData(key, { marker: true })
    displayQueries.setQueryData(other, { marker: true })
    const hook = await renderHook()
    await act(async () => { await hook.ref.current!.send(request, reviewedByAlice) })
    expect(displayQueries.getQueryState(key)?.isInvalidated).toBe(false)
    mocks.receipt = { data: mined(hook.ref.current!.hash!), isError: false }
    await act(async () => { hook.renderer.update(createElement(Harness, { ref: hook.ref })) })
    expect(displayQueries.getQueryState(key)?.isInvalidated).toBe(true)
    expect(displayQueries.getQueryState(other)?.isInvalidated).toBe(false)
    await act(async () => hook.renderer.unmount())
  })

  it('says it could not confirm yet once the receipt watch gives up, frees the dialog and still refuses a duplicate send', async () => {
    const hook = await renderHook()
    await act(async () => {
      await hook.ref.current!.send(request, reviewedByAlice)
    })
    expect(hook.ref.current).toMatchObject({ phase: 'pending', busy: true, confirmationUncertain: false })

    mocks.receipt = { data: undefined, isError: true }
    await act(async () => {
      hook.renderer.update(createElement(Harness, { ref: hook.ref }))
    })

    expect(hook.ref.current).toMatchObject({
      phase: 'unconfirmed',
      busy: false,
      settled: true,
      confirmationUncertain: true,
    })
    expect(heldNotice(hook.ref.current!.error)).toMatchObject({ chainId: 10, hash: HASH, value: '7' })
    await act(async () => {
      await expect(hook.ref.current!.send(request, reviewedByAlice)).resolves.toBeNull()
    })
    expect(mocks.requestReview).toHaveBeenCalledTimes(1)
  })

  describe('success shown only once the write hold settles it', () => {
    const BLOCK = `0x${'55'.repeat(32)}` as Hex
    const OTHER_BLOCK = `0x${'56'.repeat(32)}` as Hex
    /** A chain that knows `hash` mined in block 5, canonical while `canonical()` says so. */
    function chainWith(hash: Hex, canonical: () => boolean) {
      mocks.publicClient = {
        ...mocks.publicClient,
        getTransaction: vi.fn(async () => ({ hash, chainId: 10, from: ALICE, to: BOB, input: '0x', value: 7n, nonce: 3, blockHash: BLOCK, blockNumber: 5n, transactionIndex: 0 })),
        getTransactionReceipt: vi.fn(async () => receiptFor(hash)),
        getBlock: vi.fn(async (args: { blockTag?: string; blockNumber?: bigint } = {}) => args.blockTag === 'finalized'
          ? { number: 4n, hash: OTHER_BLOCK, timestamp: 1n }
          : { number: args.blockNumber ?? 6n, hash: canonical() && args.blockNumber === 5n ? BLOCK : OTHER_BLOCK }),
      } as typeof mocks.publicClient
    }
    const receiptFor = (hash: Hex) => ({ status: 'success' as const, transactionHash: hash, blockHash: BLOCK, blockNumber: 5n, from: ALICE, to: BOB, transactionIndex: 0, logs: [] })

    it('never renders success from an instant receipt the chain does not show canonical, and does once it does', async () => {
      let canonical = false
      chainWith(HASH, () => canonical)
      const phases: string[] = []
      const hook = await renderHook()
      await act(async () => { await hook.ref.current!.send(request, reviewedByAlice) })
      mocks.receipt = { data: receiptFor(HASH), isError: false }
      await act(async () => { hook.renderer.update(createElement(Harness, { ref: hook.ref })) })
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
      phases.push(hook.ref.current!.phase)
      expect(phases).not.toContain('success')
      expect(hook.ref.current!.phase).toBe('pending')

      // The chain shows it canonical, and the receipt is read again.
      canonical = true
      mocks.receipt = { data: { ...receiptFor(HASH) }, isError: false }
      await act(async () => { hook.renderer.update(createElement(Harness, { ref: hook.ref })) })
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
      expect(hook.ref.current!.phase).toBe('success')
      await act(async () => hook.renderer.unmount())
    })

    it("takes only its own hash's settlement: a flow following H1 shows nothing when the resend H2 settles", async () => {
      const H2 = `0x${'ef'.repeat(32)}` as Hex
      // H1's wallet reply is lost to the network; its watch gives up.
      mocks.publicClient = {
        ...mocks.publicClient,
        getTransaction: vi.fn(async ({ hash }: { hash: Hex }) => { throw new TransactionNotFoundError({ hash }) }),
      } as typeof mocks.publicClient
      mocks.writeContract.mockRejectedValueOnce(new Error('wallet transport disconnected'))
      const first = await renderHook()
      await act(async () => { await first.ref.current!.send(request, reviewedByAlice) })
      expect(first.ref.current!.phase).toBe('unconfirmed')

      // Another flow takes the exit and resends as H2, which settles.
      const second = await renderHook()
      await act(async () => { await second.ref.current!.send(request, reviewedByAlice) })
      mocks.writeContract.mockResolvedValueOnce(H2)
      chainWith(H2, () => true)
      await act(async () => { heldNotice(second.ref.current!.error).onExit!() })
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
      expect(mocks.writeContract).toHaveBeenCalledTimes(2)
      mocks.receipt = { data: receiptFor(H2), isError: false }
      await act(async () => { second.renderer.update(createElement(Harness, { ref: second.ref })) })
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
      expect(second.ref.current!.phase).toBe('success')
      // The first flow never claims H2's result for its own attempt.
      expect(first.ref.current!.notice).not.toBe('Your earlier transaction went through.')
      expect(first.ref.current!.phase).not.toBe('success')
      await act(async () => first.renderer.unmount())
      await act(async () => second.renderer.unmount())
    })
  })

  it("enters the hold when the receipt watch gives up, so the SDK's time-based exit appears, and accepting it sends exactly once more", async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    try {
      mocks.publicClient = {
        ...mocks.publicClient,
        // The wallet's hash never reaches the network.
        getTransaction: vi.fn(async ({ hash }: { hash: Hex }) => { throw new TransactionNotFoundError({ hash }) }),
      } as typeof mocks.publicClient
      const hook = await renderHook()
      await act(async () => { await hook.ref.current!.send(request, reviewedByAlice) })
      mocks.receipt = { data: undefined, isError: true }
      await act(async () => { hook.renderer.update(createElement(Harness, { ref: hook.ref })) })
      expect(hook.ref.current).toMatchObject({ phase: 'unconfirmed', settled: true })
      expect(heldNotice(hook.ref.current!.error).onExit).toBeUndefined()

      // Closing and reopening the dialog keeps it held, and it is still checked.
      await act(async () => hook.ref.current!.dismiss())
      await act(async () => hook.ref.current!.reset())
      vi.setSystemTime(Date.now() + 31 * 60_000)
      await act(async () => { vi.advanceTimersByTime(60_000) })
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
      expect(hook.ref.current!.phase).toBe('unconfirmed')
      const shown = heldNotice(hook.ref.current!.error)
      expect(shown).toMatchObject({ status: 'held-unchecked' })
      expect(shown.onExit).toBeTypeOf('function')
      mocks.receipt = { data: undefined, isError: false }
      await act(async () => { shown.onExit!() })
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
      expect(mocks.writeContract).toHaveBeenCalledTimes(2)
      await act(async () => hook.renderer.unmount())
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the unconfirmed send locked through dismiss and reset, then settles when the receipt shows up', async () => {
    const hook = await renderHook()
    await act(async () => {
      await hook.ref.current!.send(request, reviewedByAlice)
    })
    const hash = hook.ref.current!.hash!
    mocks.receipt = { data: undefined, isError: true }
    await act(async () => {
      hook.renderer.update(createElement(Harness, { ref: hook.ref }))
    })

    await act(async () => hook.ref.current!.dismiss())
    await act(async () => hook.ref.current!.reset())
    expect(hook.ref.current).toMatchObject({ phase: 'unconfirmed', hash, confirmationUncertain: true })
    await act(async () => {
      await expect(hook.ref.current!.send(request, reviewedByAlice)).resolves.toBeNull()
    })
    expect(mocks.requestReview).toHaveBeenCalledTimes(1)

    mocks.receipt = { data: mined(hash), isError: false }
    await act(async () => {
      hook.renderer.update(createElement(Harness, { ref: hook.ref }))
    })
    expect(hook.ref.current).toMatchObject({ phase: 'success', busy: false, confirmationUncertain: false, error: null })
    await act(async () => hook.ref.current!.reset())
    expect(hook.ref.current).toMatchObject({ phase: 'idle', hash: null })
    await act(async () => hook.renderer.unmount())
  })

  it('keeps an unconfirmed send locked after its dialog unmounts the hook, so reopening cannot send it twice', async () => {
    const first = await renderHook()
    await act(async () => {
      await first.ref.current!.send(request, reviewedByAlice)
    })
    mocks.receipt = { data: undefined, isError: true }
    await act(async () => {
      first.renderer.update(createElement(Harness, { ref: first.ref }))
    })
    expect(first.ref.current).toMatchObject({ phase: 'unconfirmed' })
    await act(async () => first.renderer.unmount())

    mocks.receipt = { data: undefined, isError: false }
    const reopened = await renderHook()
    await act(async () => {
      await expect(reopened.ref.current!.send(request, reviewedByAlice)).resolves.toBeNull()
    })
    expect(mocks.writeContract).toHaveBeenCalledOnce()
    expect(mocks.requestReview).toHaveBeenCalledTimes(1)
    expect(reopened.ref.current).toMatchObject({ phase: 'unconfirmed', busy: false, settled: true, hash: HASH })
    expect(heldNotice(reopened.ref.current!.error)).toMatchObject({ hash: HASH })
    // A different call is not held by it.
    await act(async () => {
      await reopened.ref.current!.send({ ...request, args: [BOB, 2n] }, reviewedByAlice)
    })
    expect(mocks.writeContract).toHaveBeenCalledTimes(2)
    await act(async () => reopened.renderer.unmount())
  })

  it('releases a held write the chain shows mined successfully, before finality, so the same call sends again', async () => {
    vi.useFakeTimers()
    try {
      const first = await renderHook()
      await act(async () => {
        await first.ref.current!.send(request, reviewedByAlice)
      })
      await act(async () => first.renderer.unmount())

      // The earlier transaction landed while no flow was open, at block 5, not final yet.
      const BLOCK = `0x${'55'.repeat(32)}` as Hex
      const mined = { hash: HASH, chainId: 10, from: ALICE, to: BOB, input: '0x', nonce: 3, blockHash: BLOCK, blockNumber: 5n, transactionIndex: 0 }
      const receipt = { status: 'success' as const, transactionHash: HASH, blockHash: BLOCK, blockNumber: 5n, from: ALICE, to: BOB, transactionIndex: 0, logs: [] }
      // Finality never arrives in this test: a verified success needs none.
      const finalized = 4n
      mocks.publicClient = {
        ...mocks.publicClient,
        getChainId: vi.fn(async () => 10),
        getTransaction: vi.fn(async () => mined),
        getTransactionReceipt: vi.fn(async () => receipt),
        getBlock: vi.fn(async (args: { blockTag?: string; blockNumber?: bigint }) => args.blockTag === 'finalized'
          ? { number: finalized, hash: `0x${'66'.repeat(32)}`, timestamp: 1n }
          : { number: args.blockNumber, hash: args.blockNumber === 5n ? BLOCK : `0x${'66'.repeat(32)}` }),
      } as typeof mocks.publicClient
      const reopened = await renderHook()
      mocks.writeContract.mockResolvedValueOnce(EXECUTION_HASH)
      // The chain shows it ran, before finality: sending the same call again is the user's new action.
      await act(async () => {
        await expect(reopened.ref.current!.send(request, reviewedByAlice)).resolves.toBe(EXECUTION_HASH)
      })
      expect(finalized).toBe(4n)
      expect(mocks.writeContract).toHaveBeenCalledTimes(2)
      await act(async () => reopened.renderer.unmount())
    } finally {
      vi.useRealTimers()
    }
  })

  it('holds a retry after a reverted receipt until a finalized block includes it, then sends it', async () => {
    vi.useFakeTimers()
    try {
      const BLOCK = `0x${'55'.repeat(32)}` as Hex
      const reverted = { status: 'reverted' as const, transactionHash: HASH, blockHash: BLOCK, blockNumber: 5n, from: ALICE, to: BOB, transactionIndex: 0, logs: [] }
      let finalized = 4n
      mocks.publicClient = {
        ...mocks.publicClient,
        getChainId: vi.fn(async () => 10),
        getTransaction: vi.fn(async () => ({ hash: HASH, chainId: 10, from: ALICE, to: BOB, input: '0x', nonce: 3, blockHash: BLOCK, blockNumber: 5n, transactionIndex: 0 })),
        getTransactionReceipt: vi.fn(async () => reverted),
        getBlock: vi.fn(async (args: { blockTag?: string; blockNumber?: bigint }) => args.blockTag === 'finalized'
          ? { number: finalized, hash: `0x${'66'.repeat(32)}`, timestamp: 1n }
          : { number: args.blockNumber, hash: args.blockNumber === 5n ? BLOCK : `0x${'66'.repeat(32)}` }),
      } as typeof mocks.publicClient
      const hook = await renderHook()
      await act(async () => { await hook.ref.current!.send(request, reviewedByAlice) })
      mocks.receipt = { data: reverted, isError: false }
      await act(async () => { hook.renderer.update(createElement(Harness, { ref: hook.ref })) })
      expect(hook.ref.current).toMatchObject({ phase: 'error' })

      // Not final yet: a reorg could bring it back, so the retry shows it again instead.
      mocks.receipt = { data: undefined, isError: false }
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      await act(async () => hook.ref.current!.reset())
      await act(async () => { await hook.ref.current!.send(request, reviewedByAlice) })
      expect(mocks.writeContract).toHaveBeenCalledOnce()

      finalized = 6n
      await act(async () => { await vi.advanceTimersByTimeAsync(16_000) })
      await act(async () => hook.ref.current!.reset())
      await act(async () => { await hook.ref.current!.send(request, reviewedByAlice) })
      expect(mocks.writeContract).toHaveBeenCalledTimes(2)
      await act(async () => hook.renderer.unmount())
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a reverted write held through a reorg until finality, so a retry sends nothing twice', async () => {
    const hook = await renderHook()
    await act(async () => {
      await hook.ref.current!.send(request, reviewedByAlice)
    })
    mocks.receipt = { data: { status: 'reverted', transactionHash: HASH, blockNumber: 5n }, isError: false }
    await act(async () => {
      hook.renderer.update(createElement(Harness, { ref: hook.ref }))
    })
    expect(hook.ref.current).toMatchObject({ phase: 'error' })

    // A reorg drops the block: the node no longer knows the transaction.
    mocks.receipt = { data: undefined, isError: false }
    mocks.publicClient = {
      ...mocks.publicClient,
      getChainId: vi.fn(async () => 10),
      getTransaction: vi.fn(async ({ hash }: { hash: Hex }) => { throw new TransactionNotFoundError({ hash }) }),
    } as typeof mocks.publicClient
    await act(async () => hook.ref.current!.reset())
    await act(async () => {
      await expect(hook.ref.current!.send(request, reviewedByAlice)).resolves.toBeNull()
    })
    expect(mocks.writeContract).toHaveBeenCalledOnce()
    expect(hook.ref.current).toMatchObject({ phase: 'unconfirmed', hash: HASH })
    await act(async () => hook.renderer.unmount())
  })

  it('tracks a hash still pending with one line and no exit', async () => {
    const hook = await renderHook()
    await act(async () => {
      await hook.ref.current!.send(request, reviewedByAlice)
    })
    mocks.receipt = { data: undefined, isError: true }
    await act(async () => {
      hook.renderer.update(createElement(Harness, { ref: hook.ref }))
    })
    expect(hook.ref.current).toMatchObject({ phase: 'unconfirmed', hash: HASH })
    expect(heldNotice(hook.ref.current!.error)).toMatchObject({ hash: HASH, onExit: undefined })

    // In the mempool on a later attempt: still tracked, still no exit.
    mocks.publicClient = {
      ...mocks.publicClient,
      getChainId: vi.fn(async () => 10),
      getTransaction: vi.fn(async () => ({ hash: HASH, from: ALICE, nonce: 3, blockNumber: null })),
    } as typeof mocks.publicClient
    const reopened = await renderHook()
    await act(async () => {
      await expect(reopened.ref.current!.send(request, reviewedByAlice)).resolves.toBeNull()
    })
    expect(mocks.writeContract).toHaveBeenCalledOnce()
    expect(reopened.ref.current).toMatchObject({ phase: 'unconfirmed', hash: HASH })
    expect(heldNotice(reopened.ref.current!.error).onExit).toBeUndefined()
    await act(async () => hook.renderer.unmount())
    await act(async () => reopened.renderer.unmount())
  })

  it('offers the exit only after a recheck, and keeps the hold when another tab saved a hash under the same record', async () => {
    mocks.writeContract.mockRejectedValueOnce(new Error('wallet transport disconnected'))
    const hook = await renderHook()
    await act(async () => {
      await hook.ref.current!.send(request, reviewedByAlice)
    })
    const shown = heldNotice(hook.ref.current!.error)
    expect(shown.onExit).toBeTypeOf('function')

    // Tab B records the wallet's hash for the same attempt.
    const OTHER = `0x${'ef'.repeat(32)}` as Hex
    const journal = createBrowserWriteRecovery({ chainId: 10, account: ALICE, safe: false, call: {
      to: BOB, data: encodeFunctionData({ abi: ABI, functionName: 'transfer', args: [BOB, 5n] }), value: 7n } }, { storage: createHeldWriteStorage() })
    await journal.withLock(async () => { journal.submitted(OTHER, journal.read()!) })

    await act(async () => { shown.onExit!() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(mocks.writeContract).toHaveBeenCalledOnce()
    expect(hook.ref.current).toMatchObject({ phase: 'unconfirmed', hash: OTHER })
    expect(heldNotice(hook.ref.current!.error)).toMatchObject({ hash: OTHER, onExit: undefined })
    await act(async () => hook.renderer.unmount())
  })

  it("says in the review when this browser can't remember pending writes, and still holds a repeat in this tab", async () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('SecurityError') } })
    mocks.writeContract.mockRejectedValueOnce(new Error('wallet transport disconnected'))
    const hook = await renderHook()
    await act(async () => {
      await hook.ref.current!.send(request, reviewedByAlice)
    })
    expect(mocks.requestReview).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      description: "This browser can't remember pending transactions. Check your wallet before repeating one.",
    }))
    await act(async () => hook.ref.current!.reset())
    await act(async () => {
      await expect(hook.ref.current!.send(request, reviewedByAlice)).resolves.toBeNull()
    })
    expect(mocks.writeContract).toHaveBeenCalledOnce()
    expect(hook.ref.current!.phase).toBe('unconfirmed')
    await act(async () => hook.renderer.unmount())
  })

  it("says in the review when this browser can't remember an app-journaled write", async () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('SecurityError') } })
    const hook = await renderHook()
    await act(async () => {
      await hook.ref.current!.send(request, { ...reviewedByAlice, journaled: true })
    })
    expect(mocks.requestReview).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      description: "This browser can't remember pending transactions. Check your wallet before repeating one.",
    }))
    await act(async () => hook.renderer.unmount())
  })

  it('holds a write the wallet may have sent without a hash, with one line and the exit that sends it again', async () => {
    mocks.writeContract.mockRejectedValueOnce(new Error('wallet transport disconnected'))
    const hook = await renderHook()
    await act(async () => {
      await expect(hook.ref.current!.send(request, reviewedByAlice)).resolves.toBeNull()
    })
    expect(hook.ref.current).toMatchObject({ phase: 'unconfirmed', busy: false, settled: true, hash: null, confirmationUncertain: true })
    const notice = heldNotice(hook.ref.current!.error)
    expect(notice).toMatchObject({ chainId: 10, hash: null, value: '7' })

    // Closing and reopening the flow does not release it.
    await act(async () => hook.ref.current!.reset())
    await act(async () => {
      await expect(hook.ref.current!.send(request, reviewedByAlice)).resolves.toBeNull()
    })
    expect(mocks.writeContract).toHaveBeenCalledOnce()
    expect(hook.ref.current!.phase).toBe('unconfirmed')

    // The user checked their wallet: the same send runs again.
    await act(async () => {
      heldNotice(hook.ref.current!.error).onExit!()
    })
    expect(mocks.writeContract).toHaveBeenCalledTimes(2)
    expect(hook.ref.current).toMatchObject({ phase: 'pending', hash: HASH })
    await act(async () => hook.renderer.unmount())
  })

  describe('a hold that settles while its exit is open', () => {
    const INPUT = () => ({ chainId: 10, account: ALICE, safe: false, call: {
      to: BOB, data: encodeFunctionData({ abi: ABI, functionName: 'transfer', args: [BOB, 5n] }), value: 7n } })
    /** Another tab, or the chain, ends the held write. */
    async function endElsewhere() {
      const journal = createBrowserWriteRecovery(INPUT(), { storage: createHeldWriteStorage() })
      await journal.withLock(async () => { journal.clear(journal.read()!) })
    }

    it('sends nothing when the hold clears before the exit is accepted', async () => {
      mocks.writeContract.mockRejectedValueOnce(new Error('wallet transport disconnected'))
      const hook = await renderHook()
      await act(async () => { await hook.ref.current!.send(request, reviewedByAlice) })
      const shown = heldNotice(hook.ref.current!.error)
      expect(shown.onExit).toBeTypeOf('function')
      await endElsewhere()
      // A look at the hold (a poll, another flow) sees it clear while the exit is open.
      await act(async () => { await writeHolds.open(INPUT()).state(mocks.publicClient as never) })
      // Released elsewhere with no settlement known: this flow claims no result.
      expect(hook.ref.current).toMatchObject({ phase: 'idle', notice: null })
      await act(async () => { shown.onExit!() })
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
      expect(mocks.writeContract).toHaveBeenCalledOnce()
      await act(async () => hook.renderer.unmount())
    })

    it('sends nothing when the hold has cleared by the time the exit is accepted', async () => {
      mocks.writeContract.mockRejectedValueOnce(new Error('wallet transport disconnected'))
      const hook = await renderHook()
      await act(async () => { await hook.ref.current!.send(request, reviewedByAlice) })
      const shown = heldNotice(hook.ref.current!.error)
      await endElsewhere()
      await act(async () => { shown.onExit!() })
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
      expect(mocks.writeContract).toHaveBeenCalledOnce()
      // Released elsewhere with no settlement known: this flow claims no result.
      expect(hook.ref.current).toMatchObject({ phase: 'idle', notice: null })
      await act(async () => hook.renderer.unmount())
    })
  })

  it('releases its hold when the wallet refuses the write', async () => {
    mocks.writeContract.mockRejectedValueOnce(new UserRejectedRequestError(new Error('User rejected')))
    const hook = await renderHook()
    await act(async () => {
      await hook.ref.current!.send(request, reviewedByAlice)
    })
    expect(hook.ref.current).toMatchObject({ phase: 'error', error: 'Transaction cancelled.' })
    await act(async () => {
      await hook.ref.current!.send(request, reviewedByAlice)
    })
    expect(mocks.writeContract).toHaveBeenCalledTimes(2)
    await act(async () => hook.renderer.unmount())
  })

  it('keeps checking slowly after the fast lookups end, so the hold clears by itself', async () => {
    vi.useFakeTimers()
    try {
      const getTransactionReceipt = vi.fn().mockResolvedValue(null)
      mocks.publicClient = { ...mocks.publicClient, getTransactionReceipt } as typeof mocks.publicClient
      const hook = await renderHook()
      await act(async () => {
        await hook.ref.current!.send(request, reviewedByAlice)
      })
      mocks.receipt = { data: undefined, isError: true }
      await act(async () => {
        hook.renderer.update(createElement(Harness, { ref: hook.ref }))
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(150 * 4_000 + 100)
      })
      const fast = getTransactionReceipt.mock.calls.length
      // The hook's 150 fast lookups.
      expect(fast).toBeGreaterThanOrEqual(150)
      expect(hook.ref.current).toMatchObject({ phase: 'unconfirmed' })

      getTransactionReceipt.mockResolvedValue(mined(hook.ref.current!.hash!))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000)
      })
      expect(getTransactionReceipt.mock.calls.length).toBeGreaterThan(fast)
      expect(hook.ref.current).toMatchObject({ phase: 'success', busy: false, error: null })
      await act(async () => hook.renderer.unmount())
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([
    ['success', 'success', null],
    ['reverted', 'error', /reverted onchain/i],
  ] as const)(
    'treats a %s receipt as a terminal state',
    async (status, phase, error) => {
      const hook = await renderHook()
      await act(async () => {
        await hook.ref.current!.send(request, reviewedByAlice)
      })

      mocks.receipt = { data: mined(HASH, status), isError: false }
      await act(async () => {
        hook.renderer.update(createElement(Harness, { ref: hook.ref }))
      })

      expect(hook.ref.current).toMatchObject({ phase, busy: false })
      if (error) expect(hook.ref.current!.error).toMatch(error)
      else expect(hook.ref.current!.error).toBeNull()
    },
  )

  it('does not confirm a new action using the previous successful receipt', async () => {
    const hook = await renderHook()
    await act(async () => { await hook.ref.current!.send(request, reviewedByAlice) })
    mocks.receipt = { data: mined(HASH), isError: false }
    await act(async () => { hook.renderer.update(createElement(Harness, { ref: hook.ref })) })
    expect(hook.ref.current!.phase).toBe('success')

    mocks.writeContract.mockResolvedValueOnce(EXECUTION_HASH)
    await act(async () => { await hook.ref.current!.send({ ...request, args: [BOB, 6n] }, reviewedByAlice) })
    expect(hook.ref.current).toMatchObject({
      phase: 'pending', busy: true, hash: EXECUTION_HASH, receipt: null,
    })

    mocks.receipt = { data: mined(EXECUTION_HASH), isError: false }
    await act(async () => { hook.renderer.update(createElement(Harness, { ref: hook.ref })) })
    expect(hook.ref.current!.phase).toBe('success')
  })

  it('confirms from a direct receipt lookup when the block watcher stalls', async () => {
    vi.useFakeTimers()
    try {
      const getTransactionReceipt = vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValue(mined(HASH))
      mocks.publicClient = {
        ...mocks.publicClient,
        getTransactionReceipt,
      } as typeof mocks.publicClient
      const hook = await renderHook()
      await act(async () => {
        await hook.ref.current!.send(request, reviewedByAlice)
      })
      expect(hook.ref.current).toMatchObject({ phase: 'pending', busy: true })

      // The watcher never answers; the interval lookup does.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4_100)
      })
      expect(getTransactionReceipt).toHaveBeenCalledTimes(1)
      expect(hook.ref.current).toMatchObject({ phase: 'pending' })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4_100)
      })
      // Two lookups, then the write hold's own read as it verifies the receipt.
      expect(getTransactionReceipt).toHaveBeenCalledTimes(3)
      expect(hook.ref.current).toMatchObject({ phase: 'success', busy: false, error: null })
      expect(hook.ref.current!.receipt).toMatchObject({ blockNumber: 5n })
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports a disconnected wallet and reset clears terminal state', async () => {
    mocks.connected = false
    const hook = await renderHook()

    await act(async () => {
      await hook.ref.current!.send(request, reviewedByAlice)
    })
    expect(hook.ref.current).toMatchObject({
      phase: 'error',
      error: 'Connect a wallet first.',
    })

    await act(async () => hook.ref.current!.reset())
    expect(hook.ref.current).toMatchObject({
      phase: 'idle',
      error: null,
      hash: null,
    })
  })

  it('reports a request it cannot encode as an error, and takes the next one', async () => {
    const hook = await renderHook()
    let result: Awaited<ReturnType<SafeTxValue['send']>> = 'unset' as never
    await act(async () => {
      result = await hook.ref.current!.send({ ...request, functionName: 'missing' }, reviewedByAlice)
    })
    expect(result).toBeNull()
    expect(hook.ref.current).toMatchObject({ phase: 'error', busy: false })
    expect(mocks.requestReview).not.toHaveBeenCalled()

    await act(async () => { await hook.ref.current!.send(request, reviewedByAlice) })
    expect(mocks.writeContract).toHaveBeenCalledOnce()
  })

  it('refuses a Center wallet before review, like view-as', async () => {
    mocks.centerWallet = true
    const hook = await renderHook()
    let result: Awaited<ReturnType<SafeTxValue['send']>> = 'unset' as never
    await act(async () => { result = await hook.ref.current!.send(request, reviewedByAlice) })
    expect(result).toBeNull()
    expect(hook.ref.current).toMatchObject({
      phase: 'error',
      error: 'This action needs an external wallet. Juicebox wallet payments use their own payment review.',
    })
    expect(mocks.requestReview).not.toHaveBeenCalled()
    expect(mocks.writeContract).not.toHaveBeenCalled()
  })

  it('names the chain the wallet could not switch to', async () => {
    mocks.switchChain.mockRejectedValueOnce(new Error('User rejected the switch'))
    const hook = await renderHook()
    await act(async () => { await hook.ref.current!.send(request, reviewedByAlice) })
    expect(hook.ref.current).toMatchObject({
      phase: 'error',
      error: 'Switch your wallet to Optimism to continue.',
    })
    expect(mocks.writeContract).not.toHaveBeenCalled()
  })

  it.each([
    ['becomes a Safe after review', false],
    ['stops being a Safe after review', true],
  ] as const)(
    'stops before the wallet when the connection %s',
    async (_, safeAtReview) => {
      mocks.safeConnection = safeAtReview
      mocks.requestReview.mockImplementationOnce(async () => {
        // A WalletConnect peer read lands mid-flow.
        mocks.safeConnection = !safeAtReview
        return true
      })
      const hook = await renderHook()
      const onBeforeWriteAborted = vi.fn()
      let result: Awaited<ReturnType<SafeTxValue['send']>> = 'unset' as never
      await act(async () => { result = await hook.ref.current!.send(request, { ...reviewedByAlice, onBeforeWriteAborted }) })
      expect(result).toBeNull()
      expect(hook.ref.current).toMatchObject({
        phase: 'error',
        error: 'Wallet connection changed. Review the transaction again.',
      })
      // The gas followed the reviewed connection, and nothing reached the wallet.
      expect(mocks.writeContract).not.toHaveBeenCalled()
      // Nothing was marked before the write, so nothing is withdrawn.
      expect(onBeforeWriteAborted).not.toHaveBeenCalled()
    },
  )

  it('withdraws the marker written before the write when the connection changes there', async () => {
    const events: string[] = []
    const hook = await renderHook()
    let result: Awaited<ReturnType<SafeTxValue['send']>> = 'unset' as never
    await act(async () => {
      result = await hook.ref.current!.send(request, {
        ...reviewedByAlice,
        beforeWrite: () => {
          events.push('marked')
          // A WalletConnect peer read lands between the marker and the write.
          mocks.safeConnection = true
        },
        onBeforeWriteAborted: () => { events.push('withdrawn') },
        onWriteRejected: () => { events.push('rejected') },
      })
    })
    expect(result).toBeNull()
    expect(events).toEqual(['marked', 'withdrawn'])
    expect(hook.ref.current).toMatchObject({
      phase: 'error',
      error: 'Wallet connection changed. Review the transaction again.',
    })
    expect(mocks.writeContract).not.toHaveBeenCalled()
  })

  it('sends the gas of the reviewed connection when a peer read flickers mid-flow', async () => {
    let simulated = false
    mocks.publicClient.simulateContract.mockImplementationOnce(async () => {
      mocks.safeConnection = true
      simulated = true
      return { request: { address: BOB, functionName: 'transfer', gas: 100n } }
    })
    // The account gate after simulation reads the peer again before the write.
    mocks.getAccount.mockImplementation(() => {
      if (simulated) mocks.safeConnection = false
      return { address: mocks.account, chainId: mocks.chainId }
    })
    // And once more after the wallet answered: the sent call is still an ordinary one.
    mocks.writeContract.mockImplementationOnce(async () => {
      mocks.safeConnection = true
      return HASH
    })
    const hook = await renderHook()
    await act(async () => { await hook.ref.current!.send(request, reviewedByAlice) })
    expect(mocks.writeContract).toHaveBeenCalledWith(expect.objectContaining({ gas: 100_000n }))
    expect(hook.ref.current).toMatchObject({ phase: 'pending', hash: HASH, safeProposalHash: null })
    expect(mocks.waitForSafeExecutionHash).not.toHaveBeenCalled()
  })

  it('passes the write-intent callbacks to the reviewed write boundary', async () => {
    const order: string[] = []
    mocks.writeContract.mockImplementationOnce(async () => {
      order.push('write')
      throw new UserRejectedRequestError(new Error('User rejected'))
    })
    const beforeWrite = vi.fn(() => { order.push('beforeWrite') })
    const onWriteRejected = vi.fn(() => { order.push('rejected') })
    const onBeforeWriteAborted = vi.fn()
    const hook = await renderHook()
    await act(async () => {
      await hook.ref.current!.send(request, { ...reviewedByAlice, beforeWrite, onWriteRejected, onBeforeWriteAborted })
    })
    expect(order).toEqual(['beforeWrite', 'write', 'rejected'])
    expect(onBeforeWriteAborted).not.toHaveBeenCalled()

    // An account change after the intent was persisted aborts it before the wallet.
    beforeWrite.mockImplementationOnce(() => { mocks.account = BOB })
    await act(async () => {
      await hook.ref.current!.send(request, { ...reviewedByAlice, beforeWrite, onWriteRejected, onBeforeWriteAborted })
    })
    expect(onBeforeWriteAborted).toHaveBeenCalledOnce()
    expect(mocks.writeContract).toHaveBeenCalledOnce()
  })
})
