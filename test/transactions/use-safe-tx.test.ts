import { QueryClient } from '@tanstack/react-query'
import { createElement, createRef, forwardRef, useImperativeHandle } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import {
  encodeFunctionData,
  parseAbi,
  UserRejectedRequestError,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem'
import { SAFE_EXEC_ABI } from '@bananapus/nana-sdk-core/safe-service'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
  publicClient: { simulateContract: vi.fn(), estimateContractGas: vi.fn(), getTransaction: vi.fn() },
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

import { browserWriteRecoveryModel } from '../support/write-recovery'
import { useSafeTx } from '@/hooks/useSafeTx'
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
  functionName: 'transfer' as const,
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

const Harness = forwardRef<SafeTxValue>(function Harness(_, ref) {
  const value = useSafeTx(10)
  useImperativeHandle(ref, () => value, [value])
  return null
})

const renderers: TestRenderer.ReactTestRenderer[] = []

async function renderHook() {
  const ref = createRef<SafeTxValue>()
  let renderer!: TestRenderer.ReactTestRenderer
  await act(async () => {
    renderer = TestRenderer.create(createElement(Harness, { ref }))
    renderers.push(renderer)
  })
  return { ref, renderer }
}

afterEach(async () => {
  await act(async () => { for (const renderer of renderers.splice(0)) renderer.unmount() })
})

beforeEach(() => {
  displayQueries.clear()
  mocks.publicClient = { simulateContract: vi.fn(), estimateContractGas: vi.fn(), getTransaction: vi.fn() }
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
  mocks.publicClient.getTransaction.mockImplementation(async ({ hash }: { hash: Hex }) => ({
    hash,
    from: BOB,
    to: ALICE,
    input: execTransaction(),
  }))
  mocks.publicClient.simulateContract.mockResolvedValue({
    request: { address: BOB, functionName: 'transfer', gas: 100n },
  })
  mocks.publicClient.estimateContractGas.mockResolvedValue(50_000n)
  mocks.writeContract.mockResolvedValue(HASH)
})

const BLOCK_HASH = `0x${'12'.repeat(32)}` as Hex

function proveReceipt(status: 'success' | 'reverted', hash: Hex = HASH, blockNumber = 100n) {
  const canonical = {
    transactionHash: hash, status, blockHash: BLOCK_HASH, blockNumber,
    transactionIndex: 0, from: ALICE, to: BOB, logs: [],
  }
  mocks.receipt = { data: canonical, isError: false }
  mocks.publicClient = {
    ...mocks.publicClient,
    getChainId: vi.fn().mockResolvedValue(10),
    getTransactionReceipt: vi.fn().mockResolvedValue(canonical),
    getBlock: vi.fn().mockResolvedValue({ number: blockNumber, hash: BLOCK_HASH, timestamp: 1n }),
    getTransaction: vi.fn().mockResolvedValue({
      hash, chainId: 10, from: ALICE, to: BOB, input: encodeFunctionData(request),
      blockHash: BLOCK_HASH, blockNumber, transactionIndex: 0,
    }),
  } as typeof mocks.publicClient
  return canonical
}

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
    proveReceipt('success', hook.ref.current!.hash!)
    await act(async () => { hook.renderer.update(createElement(Harness, { ref: hook.ref })) })
    expect(displayQueries.getQueryState(key)?.isInvalidated).toBe(true)
    expect(displayQueries.getQueryState(other)?.isInvalidated).toBe(false)
    await act(async () => hook.renderer.unmount())
  })

  it('keeps a receipt RPC error pending and prevents a duplicate send', async () => {
    const hook = await renderHook()
    await act(async () => {
      await hook.ref.current!.send(request, reviewedByAlice)
    })

    mocks.receipt = { data: undefined, isError: true }
    await act(async () => {
      hook.renderer.update(createElement(Harness, { ref: hook.ref }))
    })

    expect(hook.ref.current).toMatchObject({
      phase: 'pending',
      busy: true,
      confirmationUncertain: true,
    })
    expect(hook.ref.current!.error).toMatch(/do not submit it again/i)
    await act(async () => {
      await expect(hook.ref.current!.send(request, reviewedByAlice)).resolves.toBeNull()
    })
    expect(mocks.requestReview).toHaveBeenCalledTimes(1)
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

      proveReceipt(status)
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
    proveReceipt('success')
    await act(async () => { hook.renderer.update(createElement(Harness, { ref: hook.ref })) })
    expect(hook.ref.current!.phase).toBe('success')

    mocks.writeContract.mockResolvedValueOnce(EXECUTION_HASH)
    await act(async () => { await hook.ref.current!.send(request, reviewedByAlice) })
    expect(hook.ref.current).toMatchObject({
      phase: 'pending', busy: true, hash: EXECUTION_HASH, receipt: null,
    })

    proveReceipt('success', EXECUTION_HASH)
    await act(async () => { hook.renderer.update(createElement(Harness, { ref: hook.ref })) })
    expect(hook.ref.current!.phase).toBe('success')
  })

  it('confirms from a direct receipt lookup when the block watcher stalls', async () => {
    vi.useFakeTimers()
    try {
      const canonical = proveReceipt('success', HASH, 77n)
      mocks.receipt = { data: undefined, isError: false }
      const getTransactionReceipt = vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValue(canonical)
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
      // Polling found the receipt; canonical proof rereads its inclusion.
      expect(getTransactionReceipt).toHaveBeenCalledTimes(3)
      expect(hook.ref.current).toMatchObject({ phase: 'success', busy: false, error: null })
      expect(hook.ref.current!.receipt).toMatchObject({ blockNumber: 77n })
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


describe('durable ordinary-write recovery', () => {
  it('persists before the wallet and holds a lost reply through reset, remount, reload and a changed amount', async () => {
    mocks.writeContract.mockImplementationOnce(async () => {
      expect(localStorage.length).toBe(1)
      const saved = JSON.parse(localStorage.getItem(localStorage.key(0)!)!)
      expect(saved).toMatchObject({ chainId: 10, account: ALICE, safe: false })
      expect(saved.hash).toBeUndefined()
      throw new Error('Wallet response lost after broadcast')
    })
    const first = await renderHook()
    await act(async () => { await first.ref.current!.send(request, reviewedByAlice) })
    expect(first.ref.current).toMatchObject({ phase: 'submitted', settled: true, confirmationUncertain: true })
    await act(async () => {
      first.ref.current!.reset()
      await first.ref.current!.send(request, reviewedByAlice)
    })
    expect(mocks.writeContract).toHaveBeenCalledOnce()
    const entries = Array.from({ length: localStorage.length }, (_, index) => {
      const key = localStorage.key(index)!
      return [key, localStorage.getItem(key)!] as const
    })
    await act(async () => first.renderer.unmount())
    // A reload retains only serialized browser data, not the original journal.
    const reloaded = browserWriteRecoveryModel()
    for (const [key, value] of entries) reloaded.storage.setItem(key, value)
    vi.stubGlobal('localStorage', reloaded.storage)
    vi.stubGlobal('navigator', { locks: reloaded.locks })
    const next = await renderHook()
    await act(async () => {
      await next.ref.current!.send({ ...request, args: [BOB, 8n] }, reviewedByAlice)
    })
    expect(next.ref.current).toMatchObject({ phase: 'submitted', settled: true, receipt: null })
    expect(next.ref.current!.notice).toMatch(/cannot safely send/i)
    expect(mocks.requestReview).toHaveBeenCalledOnce()
    expect(mocks.writeContract).toHaveBeenCalledOnce()
  })

  it('resumes the wallet-returned hash after remount and clears only canonical evidence', async () => {
    const first = await renderHook()
    await act(async () => { await first.ref.current!.send(request, reviewedByAlice) })
    await act(async () => first.renderer.unmount())
    const resumed = await renderHook()
    await act(async () => { expect(await resumed.ref.current!.send(request, reviewedByAlice)).toBe(HASH) })
    expect(resumed.ref.current).toMatchObject({ phase: 'pending', hash: HASH })
    expect(mocks.writeContract).toHaveBeenCalledOnce()
    mocks.receipt = { data: { transactionHash: HASH, status: 'success' }, isError: false }
    await act(async () => resumed.renderer.update(createElement(Harness, { ref: resumed.ref })))
    expect(localStorage.length).toBe(1)
    proveReceipt('success')
    await act(async () => resumed.renderer.update(createElement(Harness, { ref: resumed.ref })))
    expect(localStorage.length).toBe(0)
    expect(mocks.writeContract).toHaveBeenCalledOnce()
  })

  it('never completes a changed amount with the earlier transaction receipt', async () => {
    const first = await renderHook()
    await act(async () => { await first.ref.current!.send(request, reviewedByAlice) })
    await act(async () => first.renderer.unmount())
    const changed = await renderHook()
    await act(async () => {
      expect(await changed.ref.current!.send({ ...request, args: [BOB, 8n] }, reviewedByAlice)).toBeNull()
    })
    proveReceipt('success')
    await act(async () => changed.renderer.update(createElement(Harness, { ref: changed.ref })))
    expect(changed.ref.current).toMatchObject({ phase: 'submitted', receipt: null, hash: null })
    expect(changed.ref.current!.notice).toMatch(/earlier transaction is confirmed/i)
    expect(mocks.writeContract).toHaveBeenCalledOnce()
    expect(localStorage.length).toBe(0)
  })

  it.each(['unavailable', 'not retained', 'locks unavailable'] as const)(
    'fails closed before wallet access when recovery is %s', async failure => {
      if (failure === 'unavailable') vi.stubGlobal('localStorage', undefined)
      else if (failure === 'not retained') vi.spyOn(localStorage, 'setItem').mockImplementation(() => {})
      else vi.stubGlobal('navigator', {})
      const flow = await renderHook()
      await act(async () => { await flow.ref.current!.send(request, reviewedByAlice) })
      expect(mocks.writeContract).not.toHaveBeenCalled()
      await act(async () => {
        flow.ref.current!.reset()
        await flow.ref.current!.send(request, reviewedByAlice)
      })
      expect(mocks.writeContract).not.toHaveBeenCalled()
    },
  )

  it('releases a typed wallet rejection but keeps an ordinary beforeWrite callback under generic protection', async () => {
    const beforeWrite = vi.fn()
    mocks.writeContract.mockRejectedValueOnce(new UserRejectedRequestError(new Error('rejected')))
    const flow = await renderHook()
    await act(async () => { await flow.ref.current!.send(request, { ...reviewedByAlice, beforeWrite }) })
    expect(localStorage.length).toBe(0)
    mocks.writeContract.mockRejectedValueOnce(new Error('lost reply'))
    await act(async () => { await flow.ref.current!.send(request, { ...reviewedByAlice, beforeWrite }) })
    expect(localStorage.length).toBe(1)
    await act(async () => {
      flow.ref.current!.reset()
      await flow.ref.current!.send(request, { ...reviewedByAlice, beforeWrite })
    })
    expect(beforeWrite).toHaveBeenCalledTimes(2)
    expect(mocks.writeContract).toHaveBeenCalledTimes(2)
  })

  it('keeps a returned hash checkable after storage fails during its handoff', async () => {
    const write = localStorage.setItem.bind(localStorage)
    const failure = vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      if (JSON.parse(value).hash) throw new Error('Storage temporarily unavailable')
      write(key, value)
    })
    const flow = await renderHook()
    await act(async () => { expect(await flow.ref.current!.send(request, reviewedByAlice)).toBe(HASH) })
    expect(flow.ref.current).toMatchObject({ phase: 'pending', hash: HASH })
    expect(JSON.parse(localStorage.getItem(localStorage.key(0)!)!).hash).toBeUndefined()
    await act(async () => flow.renderer.unmount())
    const reopened = await renderHook()
    await act(async () => { expect(await reopened.ref.current!.send(request, reviewedByAlice)).toBe(HASH) })
    expect(reopened.ref.current!.hash).toBe(HASH)
    expect(mocks.writeContract).toHaveBeenCalledOnce()
    failure.mockRestore()
    proveReceipt('success')
    await act(async () => reopened.renderer.update(createElement(Harness, { ref: reopened.ref })))
    expect(localStorage.length).toBe(0)
  })

  it('persists a late wallet hash after unmount without reviving the old flow', async () => {
    let release!: (hash: Hex) => void
    let started!: () => void
    const entered = new Promise<void>(resolve => { started = resolve })
    mocks.writeContract.mockImplementationOnce(() => {
      started()
      return new Promise<Hex>(resolve => { release = resolve })
    })
    const first = await renderHook()
    let sent!: ReturnType<SafeTxValue['send']>
    await act(async () => { sent = first.ref.current!.send(request, reviewedByAlice); await entered })
    await act(async () => first.renderer.unmount())
    await act(async () => { release(HASH); await sent })
    expect(JSON.parse(localStorage.getItem(localStorage.key(0)!)!).hash).toBe(HASH)
    const reopened = await renderHook()
    await act(async () => { expect(await reopened.ref.current!.send(request, reviewedByAlice)).toBe(HASH) })
    expect(reopened.ref.current).toMatchObject({ phase: 'pending', hash: HASH })
    expect(mocks.writeContract).toHaveBeenCalledOnce()
  })

  it('composes an explicit durable owner without creating a second reservation', async () => {
    const events: string[] = []
    const durableRecovery = {
      reserve: vi.fn(() => { events.push('reserved') }),
      releaseUnsubmitted: vi.fn(),
      submitted: vi.fn((hash: Hex, safe: boolean) => { events.push(`${hash}:${safe}`) }),
    }
    mocks.writeContract.mockImplementationOnce(async () => {
      expect(events).toEqual(['reserved'])
      expect(localStorage.length).toBe(0)
      return HASH
    })
    const flow = await renderHook()
    await act(async () => { await flow.ref.current!.send(request, { ...reviewedByAlice, durableRecovery }) })
    expect(durableRecovery.submitted).toHaveBeenCalledWith(HASH, false)
    expect(durableRecovery.releaseUnsubmitted).not.toHaveBeenCalled()
    expect(localStorage.length).toBe(0)
  })

  it('keeps a returned hash when the existing durable owner cannot finish its handoff', async () => {
    const durableRecovery = {
      reserve: vi.fn(), releaseUnsubmitted: vi.fn(),
      submitted: vi.fn().mockRejectedValue({ code: 4001 }),
    }
    const flow = await renderHook()
    await act(async () => {
      expect(await flow.ref.current!.send(request, { ...reviewedByAlice, durableRecovery })).toBe(HASH)
    })
    expect(flow.ref.current).toMatchObject({ phase: 'pending', hash: HASH })
    expect(durableRecovery.releaseUnsubmitted).not.toHaveBeenCalled()
    expect(mocks.writeContract).toHaveBeenCalledOnce()
  })

  it('withholds apparent success until canonical block evidence is available', async () => {
    vi.useFakeTimers()
    const flow = await renderHook()
    await act(async () => { await flow.ref.current!.send(request, reviewedByAlice) })
    proveReceipt('success')
    const client = mocks.publicClient as typeof mocks.publicClient & { getBlock: ReturnType<typeof vi.fn> }
    client.getBlock.mockResolvedValue({ number: 100n, hash: EXECUTION_HASH, timestamp: 1n })
    await act(async () => flow.renderer.update(createElement(Harness, { ref: flow.ref })))
    expect(flow.ref.current).toMatchObject({ phase: 'pending', settled: false, receipt: null, confirmationUncertain: true })
    expect(localStorage.length).toBe(1)
    client.getBlock.mockResolvedValue({ number: 100n, hash: BLOCK_HASH, timestamp: 1n })
    await act(async () => { await vi.advanceTimersByTimeAsync(4_100) })
    expect(flow.ref.current).toMatchObject({ phase: 'success', settled: true })
    expect(flow.ref.current!.receipt?.transactionHash).toBe(HASH)
    expect(localStorage.length).toBe(0)
    expect(mocks.writeContract).toHaveBeenCalledOnce()
  })

  it('withholds failure and retry until the reverted transaction is finalized', async () => {
    vi.useFakeTimers()
    const flow = await renderHook()
    await act(async () => { await flow.ref.current!.send(request, reviewedByAlice) })
    proveReceipt('reverted')
    let finalized = 99n
    const client = mocks.publicClient as typeof mocks.publicClient & { getBlock: ReturnType<typeof vi.fn> }
    client.getBlock.mockImplementation(async ({ blockNumber }: { blockNumber?: bigint }) => ({
      number: blockNumber ?? finalized, hash: BLOCK_HASH, timestamp: 1n,
    }))
    await act(async () => flow.renderer.update(createElement(Harness, { ref: flow.ref })))
    expect(flow.ref.current).toMatchObject({ phase: 'submitted', error: null, receipt: null, confirmationUncertain: true })
    expect(localStorage.length).toBe(1)
    await act(async () => { await flow.ref.current!.send(request, reviewedByAlice) })
    expect(mocks.writeContract).toHaveBeenCalledOnce()
    finalized = 100n
    await act(async () => { await vi.advanceTimersByTimeAsync(4_100) })
    expect(flow.ref.current!.phase).toBe('error')
    expect(flow.ref.current!.error).toMatch(/reverted onchain/i)
    expect(localStorage.length).toBe(0)
    expect(mocks.writeContract).toHaveBeenCalledOnce()
  })

  it('does not let an old proof complete a changed request that re-adopts the same reservation', async () => {
    const flow = await renderHook()
    await act(async () => { await flow.ref.current!.send(request, reviewedByAlice) })
    proveReceipt('success')
    let release!: () => void
    let started!: () => void
    const entered = new Promise<void>(resolve => { started = resolve })
    const paused = new Promise<void>(resolve => { release = resolve })
    const client = mocks.publicClient as typeof mocks.publicClient & { getBlock: ReturnType<typeof vi.fn> }
    client.getBlock.mockImplementationOnce(async () => {
      started()
      await paused
      return { number: 100n, hash: BLOCK_HASH, timestamp: 1n }
    })
    await act(async () => {
      flow.renderer.update(createElement(Harness, { ref: flow.ref }))
    })
    await entered
    await act(async () => {
      flow.ref.current!.reset()
      await flow.ref.current!.send({ ...request, args: [BOB, 8n] }, reviewedByAlice)
    })
    expect(flow.ref.current).toMatchObject({ phase: 'submitted', receipt: null })
    await act(async () => { release(); await Promise.resolve() })
    expect(flow.ref.current).toMatchObject({ phase: 'submitted', receipt: null })
    expect(mocks.writeContract).toHaveBeenCalledOnce()
  })

  it('does not reopen a reset review when the browser lock callback arrives late', async () => {
    let release!: () => void
    let started!: () => void
    const paused = new Promise<void>(resolve => { release = resolve })
    const entered = new Promise<void>(resolve => { started = resolve })
    vi.stubGlobal('navigator', { locks: {
      request: async (_name: string, _options: unknown, callback: (lock: object) => Promise<unknown>) => {
        started()
        await paused
        return callback({ name: 'reviewed-write' })
      },
    } })
    const flow = await renderHook()
    let sent!: ReturnType<SafeTxValue['send']>
    await act(async () => { sent = flow.ref.current!.send(request, reviewedByAlice); await entered })
    await act(async () => flow.ref.current!.reset())
    await act(async () => { release(); await sent })
    expect(flow.ref.current).toMatchObject({ phase: 'idle', hash: null })
    expect(mocks.requestReview).not.toHaveBeenCalled()
    expect(mocks.writeContract).not.toHaveBeenCalled()
  })

  it.each(['reset', 'unmount'] as const)('stops a delayed reviewed write after %s', async close => {
    let release!: () => void
    let started!: () => void
    const paused = new Promise<void>(resolve => { release = resolve })
    const entered = new Promise<void>(resolve => { started = resolve })
    const flow = await renderHook()
    let sent!: ReturnType<SafeTxValue['send']>
    await act(async () => {
      sent = flow.ref.current!.send(request, { ...reviewedByAlice, beforeWrite: async () => { started(); await paused } })
      await entered
    })
    await act(async () => {
      if (close === 'unmount') flow.renderer.unmount()
      else flow.ref.current!.reset()
    })
    await act(async () => {
      release()
      await sent
    })
    expect(mocks.writeContract).not.toHaveBeenCalled()
    expect(localStorage.length).toBe(0)
  })
})
