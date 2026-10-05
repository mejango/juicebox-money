import { createElement } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { encodeFunctionData, toEventSelector, zeroAddress, type Address, type Hex } from 'viem'
import { encodeMultiSend, MULTI_SEND_CALL_ONLY } from '@bananapus/nana-sdk-core/safe'
import { SAFE_EXEC_ABI } from '@bananapus/nana-sdk-core/safe-service'
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

import {
  isSafeConnection,
  readSafeAppExecution,
  useSafeConnection,
  waitForSafeExecutionHash,
} from '@/lib/safe-connector'
import { watchSafeWalletPeer } from '@/lib/safe-wallet-peer'

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
    const chainClient = { getTransaction: vi.fn() }
    runtime.getPublicClient.mockReturnValue(chainClient)
    runtime.waitForSafeExecutionHash.mockResolvedValue(HASH)
    const signal = new AbortController().signal

    await expect(waitForSafeExecutionHash(10, HASH, { signal })).resolves.toBe(HASH)
    expect(runtime.getPublicClient).toHaveBeenCalledWith(config, { chainId: 10 })
    expect(runtime.waitForSafeExecutionHash).toHaveBeenLastCalledWith(10, HASH, {
      client: chainClient,
      signal,
    })

    await waitForSafeExecutionHash(1, HASH)
    expect(runtime.getPublicClient).toHaveBeenLastCalledWith(config, { chainId: 1 })
    expect(runtime.waitForSafeExecutionHash).toHaveBeenLastCalledWith(1, HASH, {
      client: chainClient,
    })
  })

  it('lets an explicit client win over the watched config', async () => {
    const client = { getTransaction: vi.fn() }
    runtime.waitForSafeExecutionHash.mockResolvedValue(HASH)

    await waitForSafeExecutionHash(10, HASH, { client })
    expect(runtime.waitForSafeExecutionHash).toHaveBeenLastCalledWith(10, HASH, { client })
    expect(runtime.getPublicClient).not.toHaveBeenCalled()
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
