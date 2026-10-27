// @vitest-environment jsdom

/**
 * A launch saved by an earlier visit, mounted as the create page restores it:
 * its saved submission is recovered through the launch's write hold (the shared
 * recovery rule), never sent again, and never a dead end.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { encodeFunctionData, parseAbi, type Address, type Hex } from 'viem'
import { beforeAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ALICE = '0x1111111111111111111111111111111111111111' as Address
const DEPLOYER = '0x2222222222222222222222222222222222222222' as Address
const HASH = `0x${'ab'.repeat(32)}` as Hex
const SALT = `0x${'5a'.repeat(32)}` as Hex

const m = vi.hoisted(() => ({
  writeContract: vi.fn(),
  review: vi.fn(),
  client: {} as Record<string, unknown>,
  /** The domain checks' first read of a launch it follows: its receipt. */
  waitReceipt: vi.fn(),
  /** The creation fee read a fresh send needs (never recovery). */
  fee: vi.fn(),
}))

vi.mock('next/image', () => ({ default: () => null }))
vi.mock('@/providers/Providers', async () => {
  const chains = await import('viem/chains')
  return { wagmiConfig: {}, SUPPORTED_CHAINS: [chains.mainnet, chains.optimism, chains.base, chains.arbitrum] }
})
vi.mock('wagmi', () => ({
  useConfig: () => ({}),
  useSwitchChain: () => ({ switchChainAsync: vi.fn() }),
  useWriteContract: () => ({ writeContractAsync: m.writeContract }),
}))
vi.mock('wagmi/actions', async original => ({
  ...(await original<typeof import('wagmi/actions')>()),
  getAccount: () => ({ address: ALICE, chainId: 1, connector: { uid: 'reviewed-wallet' } }),
  getPublicClient: () => m.client,
  waitForTransactionReceipt: (...args: unknown[]) => m.waitReceipt(...args),
}))
vi.mock('@wagmi/core', async original => ({
  ...(await original<typeof import('@wagmi/core')>()),
  getAccount: () => ({ address: ALICE, chainId: 1, connector: { uid: 'reviewed-wallet' } }),
  getPublicClient: () => m.client,
  // Core's reviewed send: what reaches the wallet is `m.writeContract`.
  getWalletClient: async () => (await import('../support/viem-wallet')).viemWallet(tx => m.writeContract(tx), () => 1),
  switchChain: async () => undefined,
}))
vi.mock('@/lib/wallet-core', async original => ({
  ...(await original<typeof import('@/lib/wallet-core')>()),
  publicClient: () => m.client,
}))
vi.mock('@/hooks/useWallet', () => ({
  useWallet: () => ({ isConnected: true, address: ALICE, openSignIn: () => {} }),
}))
vi.mock('@/lib/safe-connector', async original => ({
  ...(await original<typeof import('@/lib/safe-connector')>()),
  isSafeConnection: () => false,
  useSafeConnection: () => false,
}))
vi.mock('@bananapus/nana-sdk-core/v6', async original => ({
  ...(await original<typeof import('@bananapus/nana-sdk-core/v6')>()),
  getProjectCreationFee: (...args: unknown[]) => m.fee(...args),
}))
vi.mock('@/lib/launch', async original => ({
  ...(await original<typeof import('@/lib/launch')>()),
  launchCallForRecovery: (_args: unknown, tx: { to: string; input: string; value: bigint }) => ({ to: tx.to, data: tx.input, value: tx.value }),
  buildLaunchRequest: () => ({
    chainId: 1, address: DEPLOYER, abi: parseAbi(['function launch(uint256 salt)']), functionName: 'launch', args: [1n], value: 0n,
  }),
}))
vi.mock('@/components/ui/TxProgress', async original =>
  (await import('../support/tx-progress')).testTxProgress(await original<typeof import('@/components/ui/TxProgress')>()))

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { CreateForm } from '@/components/create/CreateForm'
import { LAUNCH_SESSION_KEY, loadLaunchSession } from '@/lib/launch-session'
import { writeHolds } from '@/lib/write-holds'
import { launchNamespace } from '@/lib/launch-attempt'
import { registerReviewHandler } from '@bananapus/nana-sdk-core/review'

// The app's review, as core's reviewed send asks it: `m.review` rejecting is a cancel.
beforeAll(() => {
  registerReviewHandler(async prompt => {
    try {
      await m.review(prompt.model)
      return prompt.confirmation
    } catch {
      return null
    }
  })
})

/** The launch's SDK hold, as a fresh send opens it. */
const launchHold = () => writeHolds.open({ chainId: 1, account: ALICE, safe: false, namespace: launchNamespace({ chainId: 1, account: ALICE, salt: SALT, projectUri: 'ipfs://launch' }), call: LAUNCH_CALL })

let host: HTMLDivElement
let root: Root

/** A node that knows no transaction: the saved hash is never found. */
function emptyNode() {
  const missing = (name: string) => async () => { throw Object.assign(new Error('not found'), { name }) }
  return {
    getChainId: async () => 1,
    getBlockNumber: async () => 100n,
    getTransactionCount: async () => 3,
    getTransaction: missing('TransactionNotFoundError'),
    getTransactionReceipt: missing('TransactionReceiptNotFoundError'),
    getBlock: async () => ({ number: 100n, hash: `0x${'f1'.repeat(32)}`, timestamp: 1n }),
    request: async () => null,
  }
}

/** The launch an earlier visit saved: chain 1 submitted as HASH, by the last release (no hold of its own). */
function saveEarlierLaunch() {
  localStorage.setItem(LAUNCH_SESSION_KEY, JSON.stringify({
    transport: 'direct', account: ALICE, salt: SALT, projectUri: 'ipfs://launch', store: {},
    plans: { 1: { projectName: 'Launch' } }, chains: [1],
    statuses: { 1: { phase: 'uncertain', txHash: HASH } }, createdAt: Date.now(),
  }))
}

const BLOCK = `0x${'b1'.repeat(32)}` as Hex
/** The launch call the form builds (buildLaunchRequest is mocked above). */
const LAUNCH_CALL = { to: DEPLOYER, data: encodeFunctionData({ abi: parseAbi(['function launch(uint256 salt)']), functionName: 'launch', args: [1n] }), value: 0n }

/** A node that shows `hash` mined, successfully, in its canonical block. */
function minedNode(hash: Hex) {
  const known = async ({ hash: asked }: { hash: Hex }) => asked.toLowerCase() === hash.toLowerCase()
  return {
    getChainId: async () => 1,
    getBlockNumber: async () => 100n,
    getTransactionCount: async () => 4,
    getTransaction: async (args: { hash: Hex }) => {
      if (!await known(args)) throw Object.assign(new Error('not found'), { name: 'TransactionNotFoundError' })
      return { hash, chainId: 1, from: ALICE, to: DEPLOYER, input: LAUNCH_CALL.data, value: 0n, nonce: 3, blockHash: BLOCK, blockNumber: 1n, transactionIndex: 0 }
    },
    getTransactionReceipt: async (args: { hash: Hex }) => {
      if (!await known(args)) throw Object.assign(new Error('missing'), { name: 'TransactionReceiptNotFoundError' })
      return { transactionHash: hash, status: 'success', blockHash: BLOCK, blockNumber: 1n, transactionIndex: 0, from: ALICE, to: DEPLOYER, logs: [] }
    },
    getBlock: async ({ blockTag, blockNumber }: { blockTag?: string; blockNumber?: bigint } = {}) =>
      blockTag === 'finalized'
        ? { number: 100n, hash: `0x${'f1'.repeat(32)}`, timestamp: 1n }
        : { number: blockNumber ?? 100n, hash: blockNumber === 1n ? BLOCK : `0x${'f2'.repeat(32)}` },
    request: async () => null,
  }
}

async function mount() {
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => root.render(<QueryClientProvider client={queries}><CreateForm /></QueryClientProvider>))
  await settle()
}

const button = (label: string) =>
  [...host.querySelectorAll('[data-tx-confirm] button'), ...host.querySelectorAll('button')]
    .find(item => item.textContent === label) as HTMLButtonElement | undefined

async function settle() {
  for (let i = 0; i < 20; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) })
}

beforeEach(() => {
  localStorage.clear()
  m.client = emptyNode()
  m.writeContract.mockReset()
  m.waitReceipt.mockReset().mockImplementation(() => new Promise(() => {}))
  m.fee.mockReset().mockResolvedValue(0n)
  m.review.mockReset().mockRejectedValue(Object.assign(new Error('Review cancelled.'), { name: 'TransactionReviewCancelledError' }))
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

const EXIT = 'I checked my wallet'
const CHECK = 'I checked it. Launch again.'
const SETTLED = 'Your launch went through. Its project is still confirming.'
const resume = async () => {
  await act(async () => (button('Check again') ?? button('Try again'))!.click())
  await settle()
}
const journal = (statuses: Record<number, unknown>, chains = Object.keys(statuses).map(Number)) =>
  localStorage.setItem(LAUNCH_SESSION_KEY, JSON.stringify({
    transport: 'direct', account: ALICE, salt: SALT, projectUri: 'ipfs://launch', store: {},
    // The mocked launch call has one immediate ruleset; include that metadata for schedule admission.
    plans: Object.fromEntries(chains.map(chain => [chain, { projectName: 'Launch', stages: [{ duration: 0 }], afterMode: 'cycle' }])), chains, statuses, createdAt: Date.now(),
  }))

describe('a saved launch restored on the create page', () => {
  it("is held, never sent; past the window the hold's exit appears, and only it retires the saved submission, keeping the salt", async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    saveEarlierLaunch()
    await mount()
    await resume()
    // The saved hash went to the launch's hold: held, nothing sent, and it isn't an error dead end.
    expect(m.writeContract).not.toHaveBeenCalled()
    expect(button(EXIT)).toBeUndefined()
    expect(loadLaunchSession()?.statuses[1]?.txHash).toBe(HASH)

    // Past the hold's window with the hash never found, its warned exit appears.
    await act(async () => { vi.setSystemTime(Date.now() + 31 * 60_000); vi.advanceTimersByTime(60_000) })
    for (let i = 0; i < 40 && !button(EXIT); i++) await settle()
    const exit = button(EXIT)
    expect(exit, 'the warned exit').toBeDefined()
    await act(async () => exit!.click())
    await settle()
    // Only the exit retires the saved submission. The launch keeps its salt (as Homerun): launching again
    // reviews the same launch, so one that did land makes the retry revert instead of a second project.
    expect(loadLaunchSession()?.salt).toBe(SALT)
    expect(loadLaunchSession()?.statuses[1]?.txHash).toBeUndefined()
    expect(m.review).toHaveBeenCalledOnce()
    expect(m.writeContract).not.toHaveBeenCalled()
  })

  it('gives a launch an earlier release left signing the one check; only it retires it, and the same launch is reviewed again', async () => {
    journal({ 1: { phase: 'signing' } })
    await mount()
    await resume()
    expect(host.textContent).toContain('This transaction may already be in your wallet')
    const checked = button(CHECK)
    expect(checked, 'the check').toBeDefined()
    expect(m.review).not.toHaveBeenCalled()
    await act(async () => checked!.click())
    await settle()
    expect(loadLaunchSession()?.salt).toBe(SALT)
    expect(loadLaunchSession()?.statuses[1]).toMatchObject({ phase: 'failed' })
    expect(m.review).toHaveBeenCalledOnce()
    expect(m.writeContract).not.toHaveBeenCalled()
  })

  it('follows a launch whose settlement lands during the exit: no send, and the saved submission is never released', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    saveEarlierLaunch()
    await mount()
    await resume()
    await act(async () => { vi.setSystemTime(Date.now() + 31 * 60_000); vi.advanceTimersByTime(60_000) })
    for (let i = 0; i < 40 && !button(EXIT); i++) await settle()
    const exit = button(EXIT)
    expect(exit, 'the warned exit').toBeDefined()
    // The launch mines just as the user takes the exit: the exit's own check settles it.
    Object.assign(m.client, minedNode(HASH))
    await act(async () => exit!.click())
    await settle()
    // Recovery follows the settled launch into its domain checks: its receipt, never a new send.
    expect(m.waitReceipt).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ hash: HASH }))
    expect(m.review).not.toHaveBeenCalled()
    expect(m.writeContract).not.toHaveBeenCalled()
    expect(loadLaunchSession()?.statuses[1]).toMatchObject({ phase: 'confirming', txHash: HASH })
    expect(m.waitReceipt).toHaveBeenCalledOnce()
  })

  it("saves a settled launch's hash into the journal before its domain checks run (a reload between the hold and the journal)", async () => {
    const NEW_HASH = `0x${'ef'.repeat(32)}` as Hex
    m.client = minedNode(NEW_HASH)
    const hold = launchHold()
    await hold.send(m.client as never, async gate => { await gate.beforeSend(); gate.afterSubmit(NEW_HASH); return NEW_HASH })
    await hold.state(m.client as never)
    journal({ 1: { phase: 'signing', held: true } })
    let journalAtChecks: unknown
    m.waitReceipt.mockImplementation(() => {
      journalAtChecks = loadLaunchSession()?.statuses[1]
      return new Promise(() => {})
    })
    await mount()
    await resume()
    expect(m.waitReceipt).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ hash: NEW_HASH }))
    expect(journalAtChecks).toMatchObject({ phase: 'confirming', txHash: NEW_HASH, settled: true })
    expect(m.writeContract).not.toHaveBeenCalled()
  })

  it("reaches a saved launch's recovery even when the fee a fresh send needs can't be read", async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    m.fee.mockRejectedValue(new Error('fee read failed'))
    saveEarlierLaunch()
    await mount()
    await resume()
    await act(async () => { vi.setSystemTime(Date.now() + 31 * 60_000); vi.advanceTimersByTime(60_000) })
    await settle()
    expect(button(EXIT), 'the warned exit').toBeDefined()
    expect(m.writeContract).not.toHaveBeenCalled()
  })

  it("keeps a settled launch whose project can't be read confirming: only Check again, never a check, discard or resend", async () => {
    const NEW_HASH = `0x${'ef'.repeat(32)}` as Hex
    m.client = minedNode(NEW_HASH)
    const hold = launchHold()
    await hold.send(m.client as never, async gate => { await gate.beforeSend(); gate.afterSubmit(NEW_HASH); return NEW_HASH })
    await hold.state(m.client as never)
    journal({ 1: { phase: 'signing', held: true } })
    // Its receipt names no project.
    m.waitReceipt.mockResolvedValue({ transactionHash: NEW_HASH, status: 'success', blockNumber: 1n, logs: [] })
    await mount()
    await resume()
    expect(host.textContent).toContain(SETTLED)
    expect(button('Check again')).toBeDefined()
    expect(button(CHECK)).toBeUndefined()
    expect(button(EXIT)).toBeUndefined()
    expect(button('Cancel deployment')).toBeUndefined()
    expect(loadLaunchSession()?.statuses[1]).toMatchObject({ txHash: NEW_HASH })
    expect(m.writeContract).not.toHaveBeenCalled()
  })

  it('keeps the journal of a launch with a completed chain when another chain is retired through the check: the rest resumes as the same project', async () => {
    journal({ 1: { phase: 'done', projectId: 5 }, 10: { phase: 'signing' } })
    await mount()
    await resume()
    await act(async () => button(CHECK)!.click())
    await settle()
    const saved = loadLaunchSession()
    expect(saved?.salt).toBe(SALT)
    expect(saved?.statuses[1]).toMatchObject({ phase: 'done', projectId: 5 })
    expect(saved?.statuses[10]).toMatchObject({ phase: 'failed' })
    expect(saved?.statuses[10]?.txHash).toBeUndefined()
    expect(m.writeContract).not.toHaveBeenCalled()
  })

  it('refuses a stale check once another tab completed that chain, even saved as done without settled, and keeps the journal', async () => {
    journal({ 1: { phase: 'signing' }, 10: { phase: 'signing' } })
    await mount()
    await resume()
    const checked = button(CHECK)
    expect(checked, 'the check').toBeDefined()
    // Meanwhile another tab completed chain 1 (a main-era success: done, no settled flag) and chain 10 failed.
    const session = JSON.parse(localStorage.getItem(LAUNCH_SESSION_KEY)!)
    session.statuses = { 1: { phase: 'done', projectId: 5 }, 10: { phase: 'failed' } }
    localStorage.setItem(LAUNCH_SESSION_KEY, JSON.stringify(session))
    await act(async () => checked!.click())
    await settle()
    expect(loadLaunchSession()?.statuses[1]).toMatchObject({ phase: 'done', projectId: 5 })
    expect(m.review).not.toHaveBeenCalled()
    expect(m.writeContract).not.toHaveBeenCalled()
  })

  it('keeps a launch whose success was saved confirming after a reload, even when its settlement can no longer be read', async () => {
    journal({ 1: { phase: 'confirming', txHash: HASH, settled: true } })
    m.client = { ...emptyNode(), getTransaction: async () => { throw new Error('node down') }, getChainId: async () => { throw new Error('node down') } }
    m.waitReceipt.mockRejectedValue(new Error('node down'))
    await mount()
    await resume()
    expect(host.textContent).toContain(SETTLED)
    expect(button(CHECK)).toBeUndefined()
    expect(button(EXIT)).toBeUndefined()
    expect(loadLaunchSession()?.statuses[1]).toMatchObject({ txHash: HASH, settled: true })
    expect(m.writeContract).not.toHaveBeenCalled()
  })

  it('refuses a stale check action once another tab saved the launch as a success', async () => {
    journal({ 1: { phase: 'signing' } })
    await mount()
    await resume()
    const checked = button(CHECK)
    expect(checked, 'the check').toBeDefined()
    const session = JSON.parse(localStorage.getItem(LAUNCH_SESSION_KEY)!)
    session.statuses[1] = { phase: 'confirming', txHash: HASH, settled: true }
    localStorage.setItem(LAUNCH_SESSION_KEY, JSON.stringify(session))
    await act(async () => checked!.click())
    await settle()
    expect(loadLaunchSession()?.statuses[1]).toMatchObject({ txHash: HASH, settled: true })
    expect(m.writeContract).not.toHaveBeenCalled()
  })

  it("refuses a check while the journal can't be read, keeping the attempt, its button and a success another tab saved", async () => {
    journal({ 1: { phase: 'signing' } })
    await mount()
    await resume()
    const session = JSON.parse(localStorage.getItem(LAUNCH_SESSION_KEY)!)
    session.statuses[1] = { phase: 'confirming', txHash: HASH, settled: true }
    localStorage.setItem(LAUNCH_SESSION_KEY, JSON.stringify(session))
    const read = Storage.prototype.getItem
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key: string) {
      if (key === LAUNCH_SESSION_KEY) throw new Error('storage unavailable')
      return read.call(this, key)
    })
    await act(async () => button(CHECK)!.click())
    await settle()
    expect(button(CHECK)).toBeDefined()
    vi.mocked(Storage.prototype.getItem).mockRestore()
    expect(loadLaunchSession()?.statuses[1]).toMatchObject({ phase: 'confirming', txHash: HASH, settled: true })
  })

  it("over storage that can't be read, offers the SDK's warned Continue anyway, which drops the record and reopens the form", async () => {
    journal({ 1: { phase: 'signing' } })
    await mount()
    await resume()
    expect(button('I checked my wallet. Continue anyway')).toBeUndefined()
    const read = Storage.prototype.getItem
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key: string) {
      if (key === LAUNCH_SESSION_KEY || key.startsWith('nana-sdk:')) throw new Error('storage unavailable')
      return read.call(this, key)
    })
    await act(async () => button(CHECK)!.click())
    await settle()
    expect(host.textContent).toContain("This browser can't read its saved transactions. Check your wallet before sending again.")
    const anyway = button('I checked my wallet. Continue anyway')
    expect(anyway, 'the warned continue').toBeDefined()
    await act(async () => anyway!.click())
    await settle()
    vi.mocked(Storage.prototype.getItem).mockRestore()
    expect(loadLaunchSession()).toBeNull()
    expect(host.querySelector('[data-tx-confirm]')).toBeNull()
    expect(m.writeContract).not.toHaveBeenCalled()
  })
})

describe('the normal path, click for click as main', () => {
  it('launches a chain with nothing out with one press: one review, one wallet prompt, and no hold or recovery notice', async () => {
    journal({ 1: { phase: 'pending' } })
    m.review.mockReset().mockResolvedValue(undefined)
    m.writeContract.mockResolvedValue(HASH)
    // The node shows the launch mined, so the hold verifies it before the launch reads done.
    m.client = minedNode(HASH)
    Object.assign(m.client, {
      // Core's simulation: the launch's eth_call returns.
      request: async ({ method }: { method: string }) => method === 'eth_call' ? '0x' : null,
      estimateGas: async () => 100_000n,
      // Core's own receipt wait; the form's domain checks then wait on `m.waitReceipt`.
      waitForTransactionReceipt: async () => ({ transactionHash: HASH, status: 'success', blockHash: BLOCK, blockNumber: 1n, transactionIndex: 0, from: ALICE, to: DEPLOYER, logs: [] }),
    })
    await mount()
    await resume()
    expect(m.review).toHaveBeenCalledOnce()
    expect(m.writeContract).toHaveBeenCalledOnce()
    for (const line of [EXIT, CHECK, 'This transaction may already be in your wallet', "This browser can't read its saved transactions", 'Confirming your transaction.']) {
      expect(host.textContent).not.toContain(line)
    }
    expect(loadLaunchSession()?.statuses[1]).toMatchObject({ phase: 'confirming', txHash: HASH })
  })
})
