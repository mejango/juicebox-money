import { createElement } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import {
  encodeFunctionData,
  getAddress,
  toEventSelector,
  TransactionNotFoundError,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem'
import { encodeMultiSend, MULTI_SEND_CALL_ONLY } from '@bananapus/nana-sdk-core/safe'
import {
  canonicalSafeTxHash,
  SAFE_EXEC_ABI,
  safeProposalFor,
} from '@bananapus/nana-sdk-core/safe-service'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type FakeConnector = { id: string; name: string; getProvider?: () => Promise<unknown> }
type Account = { connector?: FakeConnector }

const runtime = vi.hoisted(() => ({
  connector: undefined as FakeConnector | undefined,
  onChange: (_account: Account) => {},
  unwatch: () => {},
  getPublicClient: vi.fn(),
  waitForSafeExecutionHash: vi.fn(),
}))

vi.mock('wagmi/actions', () => ({
  getAccount: () => ({ connector: runtime.connector }),
  getPublicClient: runtime.getPublicClient,
  watchAccount: (_config: unknown, { onChange }: { onChange: (account: Account) => void }) => {
    runtime.onChange = onChange
    return runtime.unwatch
  },
}))
vi.mock('@bananapus/nana-sdk-core/safe-service', async importOriginal => ({
  ...(await importOriginal<typeof import('@bananapus/nana-sdk-core/safe-service')>()),
  waitForSafeExecutionHash: runtime.waitForSafeExecutionHash,
}))

import type { TxRequest } from '@/hooks/useSafeTx'
import {
  findPendingSafeAppProposal,
  heldCall,
  isSafeConnection,
  readSafeAppExecution,
  reportedSafeExecution,
  stampedDeadline,
  useSafeConnection,
  waitForSafeExecutionHash,
  type SafeAppCall,
} from '@/lib/safe-connector'
import { watchSafeWalletPeer } from '@/lib/safe-wallet-peer'
import { revertsOnceStampPasses, STAMPED_CHAIN, STAMPED_SITES } from './support/stamped-sites'

const config = { tag: 'config' } as never
const HASH = `0x${'ab'.repeat(32)}` as Hex

function walletConnect(getProvider: () => Promise<unknown>): FakeConnector {
  return { id: 'walletConnect', name: 'WalletConnect', getProvider }
}

/** A WalletConnect connection whose session names `url` as the peer. */
function peer(url: string): FakeConnector {
  return walletConnect(async () => ({ session: { peer: { metadata: { url } } } }))
}

/** Connects `connector` and lets the watcher read its session. */
async function connect(connector: FakeConnector | undefined) {
  runtime.connector = connector
  await act(async () => {
    runtime.onChange({ connector })
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

beforeEach(() => {
  // Every test starts watching a disconnected wallet, with no peer recorded.
  runtime.connector = undefined
  watchSafeWalletPeer(config)
})

// The Safe service helpers are tested in @bananapus/nana-sdk-core/safe-service.
describe('Safe connector detection', () => {
  it('matches the Safe app by its connector id, not a name containing "safe"', () => {
    runtime.connector = { id: 'injected', name: 'SafePal' }
    expect(isSafeConnection(config)).toBe(false)
    runtime.connector = { id: 'app.safepal', name: 'SafePal Wallet' }
    expect(isSafeConnection(config)).toBe(false)
    runtime.connector = { id: 'safe', name: 'Safe' }
    expect(isSafeConnection(config)).toBe(true)
  })

  it('is Safe{Wallet} over WalletConnect, and no other peer', async () => {
    await connect(peer('https://app.safe.global'))
    expect(isSafeConnection(config)).toBe(true)
    await connect(peer('https://www.safepal.com'))
    expect(isSafeConnection(config)).toBe(false)
    await connect(peer('https://app.safe.global.example'))
    expect(isSafeConnection(config)).toBe(false)
  })

  it('checks the connection once when it starts watching, and returns the unwatch', async () => {
    runtime.connector = peer('https://app.safe.global')
    let unwatch!: () => void
    await act(async () => {
      unwatch = watchSafeWalletPeer(config)
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(isSafeConnection(config)).toBe(true)
    expect(unwatch).toBe(runtime.unwatch)
  })

  it('keeps Safe{Wallet} while it reads the session again', async () => {
    await connect(peer('https://app.safe.global'))
    // A gas choice made during the read must still be the Safe's.
    runtime.onChange({ connector: walletConnect(() => new Promise(() => {})) })
    expect(isSafeConnection(config)).toBe(true)
  })

  it('keeps the newest answer when an earlier session read finishes later', async () => {
    let finish!: (provider: unknown) => void
    runtime.onChange({
      connector: walletConnect(() => new Promise(resolve => { finish = resolve })),
    })
    await connect(peer('https://www.safepal.com'))
    await act(async () => {
      finish({ session: { peer: { metadata: { url: 'https://app.safe.global' } } } })
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(isSafeConnection(config)).toBe(false)
  })

  it('forgets Safe{Wallet} when a session cannot be read', async () => {
    await connect(peer('https://app.safe.global'))
    await connect(walletConnect(() => Promise.reject(new Error('Session expired'))))
    expect(isSafeConnection(config)).toBe(false)
  })

  it('renders again once Safe{Wallet} is recognized', async () => {
    const Probe = () => String(useSafeConnection(config))
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(Probe))
    })
    expect(renderer.toJSON()).toBe('false')
    await connect(peer('https://app.safe.global'))
    expect(renderer.toJSON()).toBe('true')
    await act(async () => renderer.unmount())
  })
})

describe('Safe execution wait', () => {
  it('passes the chain’s public client from the watched config', async () => {
    const chainClient = { getTransaction: vi.fn(async () => ({ hash: HASH })) }
    runtime.getPublicClient.mockReturnValue(chainClient)
    runtime.waitForSafeExecutionHash.mockResolvedValue(HASH)
    const signal = new AbortController().signal

    await expect(waitForSafeExecutionHash(10, HASH, { signal })).resolves.toBe(HASH)
    expect(runtime.getPublicClient).toHaveBeenCalledWith(config, { chainId: 10 })
    expect(runtime.waitForSafeExecutionHash).toHaveBeenLastCalledWith(10, HASH, {
      client: expect.objectContaining({ getTransaction: expect.any(Function) }),
      signal,
    })
    // The SDK reads the chain's own client.
    const [, , options] = runtime.waitForSafeExecutionHash.mock.lastCall!
    await options.client.getTransaction({ hash: HASH })
    expect(chainClient.getTransaction).toHaveBeenCalledWith({ hash: HASH })

    await waitForSafeExecutionHash(1, HASH)
    expect(runtime.getPublicClient).toHaveBeenLastCalledWith(config, { chainId: 1 })
  })

  it('lets an explicit client win over the watched config', async () => {
    const client = { getTransaction: vi.fn(async () => ({ hash: HASH })) }
    runtime.waitForSafeExecutionHash.mockResolvedValue(HASH)

    await waitForSafeExecutionHash(10, HASH, { client })
    const [, , options] = runtime.waitForSafeExecutionHash.mock.lastCall!
    await expect(options.client.getTransaction({ hash: HASH })).resolves.toEqual({ hash: HASH })
    expect(client.getTransaction).toHaveBeenCalledWith({ hash: HASH })
    expect(runtime.getPublicClient).not.toHaveBeenCalled()
  })

  it("hands the SDK only a real not-found: a node that can't answer is asked again", async () => {
    vi.useFakeTimers()
    const client = {
      getTransaction: vi
        .fn()
        .mockRejectedValueOnce(new Error('fetch failed'))
        .mockRejectedValueOnce(new Error('HTTP 503'))
        .mockResolvedValueOnce({ hash: HASH })
        .mockRejectedValue(new TransactionNotFoundError({ hash: HASH })),
    }
    runtime.waitForSafeExecutionHash.mockResolvedValue(HASH)
    await waitForSafeExecutionHash(11155420, HASH, { client })
    const [, , options] = runtime.waitForSafeExecutionHash.mock.lastCall!

    const look = options.client.getTransaction({ hash: HASH })
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(look).resolves.toEqual({ hash: HASH })
    expect(client.getTransaction).toHaveBeenCalledTimes(3)
    // A real not-found reaches the SDK at once.
    await expect(options.client.getTransaction({ hash: HASH })).rejects.toBeInstanceOf(TransactionNotFoundError)
  })

  it('stops asking when its wait is aborted', async () => {
    vi.useFakeTimers()
    const client = { getTransaction: vi.fn().mockRejectedValue(new Error('fetch failed')) }
    const controller = new AbortController()
    runtime.waitForSafeExecutionHash.mockResolvedValue(HASH)
    await waitForSafeExecutionHash(11155420, HASH, { client, signal: controller.signal })
    const [, , options] = runtime.waitForSafeExecutionHash.mock.lastCall!

    const look = options.client.getTransaction({ hash: HASH })
    const settled = expect(look).rejects.toThrow(/aborted/i)
    controller.abort()
    await settled
  })
})

describe('Safe app execution', () => {
  const SAFE = '0x1111111111111111111111111111111111111111' as Address
  const OWNER = '0x2222222222222222222222222222222222222222' as Address
  const TARGET = '0x5555555555555555555555555555555555555555' as Address
  const OTHER = '0x6666666666666666666666666666666666666666' as Address
  /** The execution's own transaction hash, which Safe{Wallet} returns when it executes at once. */
  const EXECUTION = `0x${'cd'.repeat(32)}` as Hex
  /** The safeTxHash the Safe's own event names. */
  const SAFE_TX = `0x${'ef'.repeat(32)}` as Hex
  const CALL = { to: TARGET, data: '0x1234' as Hex, value: 5n }
  const SECOND = { to: OTHER, data: '0x5678' as Hex, value: 0n }

  const receipt = (safeTxHash: Hex) => ({
    status: 'success' as const,
    transactionHash: EXECUTION,
    logs: [{
      address: SAFE,
      topics: [toEventSelector('ExecutionSuccess(bytes32,uint256)'), safeTxHash],
      data: `0x${'00'.repeat(32)}` as Hex,
    }],
  })
  const execTransaction = (to: Address, value: bigint, data: Hex, operation: number) =>
    encodeFunctionData({
      abi: SAFE_EXEC_ABI,
      functionName: 'execTransaction',
      args: [to, value, data, operation, 0n, 0n, 0n, zeroAddress, zeroAddress, '0x'],
    })
  /** A chain whose transaction EXECUTION calls `to` with `input`. */
  const chain = (input: Hex, to: Address | null = SAFE) => ({
    getTransaction: vi.fn(async () => ({ to, input, from: OWNER })),
  })
  const atOnce = (client: ReturnType<typeof chain>, calls: readonly (typeof CALL)[] = [CALL]) =>
    readSafeAppExecution({ client, receipt: receipt(SAFE_TX), safe: SAFE, proposalHash: EXECUTION, calls })

  it('binds an execution Safe{Wallet} returned at once to exactly the reviewed call', async () => {
    const client = chain(execTransaction(TARGET, 5n, '0x1234', 0))
    await expect(atOnce(client)).resolves.toMatchObject({ status: 'success' })
    expect(client.getTransaction).toHaveBeenCalledWith({ hash: EXECUTION })
  })

  it.each([
    ['other calldata', chain(execTransaction(TARGET, 5n, '0xdead', 0))],
    ['another value', chain(execTransaction(TARGET, 6n, '0x1234', 0))],
    ['another target', chain(execTransaction(OTHER, 5n, '0x1234', 0))],
    ['a DELEGATECALL of the call', chain(execTransaction(TARGET, 5n, '0x1234', 1))],
    ['a call to another contract', chain(execTransaction(TARGET, 5n, '0x1234', 0), OTHER)],
    ['a contract creation', chain(execTransaction(TARGET, 5n, '0x1234', 0), null)],
    ['something other than execTransaction', chain('0xd4d9bdcd' as Hex)],
  ])('leaves an execution returned at once unproven when it ran %s', async (_, client) => {
    await expect(atOnce(client)).resolves.toMatchObject({ status: 'unproven' })
  })

  it('leaves it unproven when the chain cannot show the execution', async () => {
    const client = { getTransaction: vi.fn(async () => { throw new Error('not found') }) }
    await expect(atOnce(client as unknown as ReturnType<typeof chain>)).resolves.toMatchObject({ status: 'unproven' })
  })

  it('binds a batch to MultiSendCallOnly running exactly the reviewed calls, in order', async () => {
    const batch = (calls: (typeof CALL)[], value = 0n) =>
      chain(execTransaction(MULTI_SEND_CALL_ONLY, value, encodeMultiSend(calls), 1))
    await expect(atOnce(batch([CALL, SECOND]), [CALL, SECOND])).resolves.toMatchObject({ status: 'success' })
    await expect(atOnce(batch([SECOND, CALL]), [CALL, SECOND])).resolves.toMatchObject({ status: 'unproven' })
    await expect(atOnce(batch([CALL]), [CALL, SECOND])).resolves.toMatchObject({ status: 'unproven' })
    await expect(atOnce(batch([CALL, SECOND], 1n), [CALL, SECOND])).resolves.toMatchObject({ status: 'unproven' })
  })

  it("reads a proposal executed later from the Safe's event for it, without the transaction", async () => {
    const client = chain('0x')
    await expect(
      readSafeAppExecution({ client, receipt: receipt(SAFE_TX), safe: SAFE, proposalHash: SAFE_TX, calls: [CALL] }),
    ).resolves.toMatchObject({ status: 'success' })
    expect(client.getTransaction).not.toHaveBeenCalled()
  })
})

/** The call a request makes. */
const callOf = (request: TxRequest): SafeAppCall => ({
  to: request.address,
  data: encodeFunctionData(request as Parameters<typeof encodeFunctionData>[0]),
  value: request.value,
})

/** A send's stamp, and the stamp the same action takes when it is sent 30 days later. */
const NOW = 1_800_000_000n
const LATER = NOW + 30n * 86_400n

describe('the call a Safe proposal holds', () => {
  it.each(STAMPED_SITES)('is %s whatever its send-time stamp', (_, build) => {
    const first = callOf(build(NOW))
    const later = callOf(build(LATER))
    expect(later.data).not.toBe(first.data)
    expect(heldCall(later)).toEqual(heldCall(first))
  })

  it.each(STAMPED_SITES)('tells %s apart by any other field', (_, build) => {
    expect(heldCall(callOf(build(NOW, 1n)))).not.toEqual(heldCall(callOf(build(NOW))))
  })

  it.each(STAMPED_SITES)(
    'names the deadline of %s only where the contract refuses the call once it passes',
    (site, build) => {
      expect(stampedDeadline(callOf(build(NOW)))).toBe(revertsOnceStampPasses(site) ? NOW : null)
    },
  )

  it('holds any other call, or a stamped call encoded any other way, exactly as sent', () => {
    const transfer = {
      to: '0x2222222222222222222222222222222222222222' as Address,
      data: '0xa9059cbb' as Hex,
      value: 0n,
    }
    expect(heldCall(transfer)).toEqual(transfer)
    expect(stampedDeadline(transfer)).toBeNull()
    const sale = callOf(STAMPED_SITES[0][1](NOW))
    const padded = { ...sale, data: `${sale.data}00` as Hex }
    expect(heldCall(padded)).toEqual(padded)
    expect(stampedDeadline(padded)).toBeNull()
  })
})

describe("the Safe's queue, asked before a proposal", () => {
  const SAFE = '0x1111111111111111111111111111111111111111' as Address
  const word = (value: bigint) => `0x${value.toString(16).padStart(64, '0')}`
  /** The chain, with the Safe at nonce 5 and its latest block at `timestamp`. */
  const chain = (timestamp = NOW) => ({
    request: vi.fn(async ({ method }: { method: string }) => {
      if (method !== 'eth_call') throw new Error(`unexpected ${method}`)
      return word(5n)
    }),
    getBlock: vi.fn(async () => ({ number: 100n, timestamp })),
  })
  /** Safe's service, queueing `calls` from nonce 5 on. */
  const queue = (calls: SafeAppCall[]) => ({
    fetch: vi.fn(async () =>
      new Response(
        JSON.stringify({
          next: null,
          results: calls.map((call, index) => {
            const tx = safeProposalFor(call, 5 + index)
            return { ...tx, safeTxHash: canonicalSafeTxHash(STAMPED_CHAIN, SAFE, tx) }
          }),
        }),
      ),
    ),
  })
  const lookup = (call: SafeAppCall, queued: SafeAppCall[], timestamp = NOW) =>
    findPendingSafeAppProposal(chain(timestamp) as never, STAMPED_CHAIN, SAFE, call, queue(queued))

  it.each(STAMPED_SITES)('finds %s queued with an older stamp', async (_, build) => {
    const queued = callOf(build(NOW + 600n))
    await expect(lookup(callOf(build(LATER)), [queued])).resolves.toMatchObject({
      tx: { nonce: 5 },
      proposalHash: canonicalSafeTxHash(STAMPED_CHAIN, SAFE, safeProposalFor(queued, 5)),
      call: { ...queued, to: getAddress(queued.to), value: queued.value ?? 0n },
    })
  })

  it.each(STAMPED_SITES)(
    'passes over %s queued with a deadline the chain passed, only where it reverts',
    async (site, build) => {
      const passed = callOf(build(NOW - 1n))
      const live = callOf(build(NOW + 600n))
      const found = await lookup(callOf(build(LATER)), [passed, live])
      expect(found?.call.data).toBe(revertsOnceStampPasses(site) ? live.data : passed.data)
      // A deadline the latest block only reached may still run in the next block.
      await expect(lookup(callOf(build(LATER)), [callOf(build(NOW))])).resolves.not.toBeNull()
    },
  )

  it.each(STAMPED_SITES)('never finds %s queued with any other field changed', async (_, build) => {
    await expect(lookup(callOf(build(LATER)), [callOf(build(NOW + 600n, 1n))])).resolves.toBeNull()
  })
})

describe("an execution Safe's service reports failed", () => {
  const SAFE = '0x1111111111111111111111111111111111111111' as Address
  const FAILED = new Error('Safe executed the proposal, but the onchain transaction failed.')
  const call = { to: '0x2222222222222222222222222222222222222222' as Address, data: '0x1234' as Hex, value: 0n }
  const tx = safeProposalFor(call, 5)
  const hash = canonicalSafeTxHash(STAMPED_CHAIN, SAFE, tx)
  const service = (record: Record<string, unknown>) => ({
    fetch: vi.fn(async () => new Response(JSON.stringify({ ...tx, safe: SAFE, safeTxHash: hash, ...record }))),
  })

  it("is the execution the service's authenticated record names, for its receipt to decide", async () => {
    const options = service({ isExecuted: true, isSuccessful: false, transactionHash: HASH })
    await expect(reportedSafeExecution(FAILED, STAMPED_CHAIN, SAFE, hash, options)).resolves.toBe(HASH)
  })

  it('is unknown when the record names none, or cannot be read', async () => {
    await expect(
      reportedSafeExecution(FAILED, STAMPED_CHAIN, SAFE, hash, service({ isExecuted: true, transactionHash: null })),
    ).resolves.toBeNull()
    const down = { fetch: vi.fn(async () => new Response('', { status: 503 })) }
    await expect(reportedSafeExecution(FAILED, STAMPED_CHAIN, SAFE, hash, down)).resolves.toBeNull()
  })

  it('is never read for any other error', async () => {
    const options = service({ isExecuted: true, transactionHash: HASH })
    await expect(
      reportedSafeExecution(new Error('Safe service unavailable'), STAMPED_CHAIN, SAFE, hash, options),
    ).resolves.toBeNull()
    expect(options.fetch).not.toHaveBeenCalled()
  })
})
