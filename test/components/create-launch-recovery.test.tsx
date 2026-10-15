// @vitest-environment jsdom

/**
 * A launch saved by an earlier visit, mounted as the create page restores it:
 * its saved submission is recovered through the launch's write hold (the shared
 * recovery rule), never sent again, and never a dead end.
 */

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { encodeFunctionData, parseAbi, type Address, type Hex } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
  buildLaunchRequest: () => ({
    chainId: 1, address: DEPLOYER, abi: parseAbi(['function launch(uint256 salt)']), functionName: 'launch', args: [1n], value: 0n,
  }),
}))
vi.mock('@/lib/transaction-review', async original => ({
  ...(await original<typeof import('@/lib/transaction-review')>()),
  requireContractTransactionReview: m.review,
}))
vi.mock('@/components/ui/TxConfirmDialog', () => ({
  TxConfirmDialog: ({ open, action, onConfirm, error, children }: {
    open: boolean; action: string; onConfirm: () => void; error?: ReactNode; children?: ReactNode
  }) => open ? (
    <section data-tx-confirm>
      <p data-error>{error}</p>
      {children}
      <button type="button" onClick={onConfirm}>{action}</button>
    </section>
  ) : null,
}))

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { CreateForm } from '@/components/create/CreateForm'
import { LAUNCH_SESSION_KEY, loadLaunchSession } from '@/lib/launch-session'
import { launchHold } from '@/lib/launch-hold'

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

describe('a saved launch restored on the create page', () => {
  it("is held, never sent; past the window the hold's exit appears, and only it retires the saved submission", async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    saveEarlierLaunch()
    const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    await act(async () => root.render(<QueryClientProvider client={queries}><CreateForm /></QueryClientProvider>))
    await settle()
    const check = button('Check again') ?? button('Try again')
    expect(check, 'the restored launch offers its check').toBeDefined()
    await act(async () => check!.click())
    await settle()
    // The saved hash went to the launch's hold: held, nothing sent, and it isn't an error dead end.
    expect(m.writeContract).not.toHaveBeenCalled()
    expect(button('I checked my wallet. Send again')).toBeUndefined()
    expect(loadLaunchSession()?.statuses[1]?.txHash).toBe(HASH)

    // Past the hold's window with the hash never found, its warned exit appears.
    await act(async () => { vi.setSystemTime(Date.now() + 31 * 60_000); vi.advanceTimersByTime(60_000) })
    await settle()
    const exit = button('I checked my wallet. Send again')
    expect(exit, 'the warned exit').toBeDefined()
    await act(async () => exit!.click())
    await settle()
    // Only the exit retires the saved submission, and with it the retired attempt's launch
    // (its salt): the form reopens, and launching again is a new launch with a fresh salt.
    expect(loadLaunchSession()).toBeNull()
    expect(host.querySelector('[data-tx-confirm]')).toBeNull()
    expect(m.review).not.toHaveBeenCalled()
    expect(m.writeContract).not.toHaveBeenCalled()
  })

  it("retires a launch the user checked, even on a single chain, so launching again uses a fresh salt", async () => {
    // An earlier visit was signing with no hold of its own: the user is asked to check it.
    localStorage.setItem(LAUNCH_SESSION_KEY, JSON.stringify({
      transport: 'direct', account: ALICE, salt: SALT, projectUri: 'ipfs://launch', store: {},
      plans: { 1: { projectName: 'Launch' } }, chains: [1],
      statuses: { 1: { phase: 'signing' } }, createdAt: Date.now(),
    }))
    await mount()
    await act(async () => (button('Check again') ?? button('Try again'))!.click())
    await settle()
    const checked = button('I checked it. Launch again')
    expect(checked, 'the check').toBeDefined()
    await act(async () => checked!.click())
    await settle()
    // The retired attempt's salt is never reused: its launch record is gone, the form reopens.
    expect(loadLaunchSession()).toBeNull()
    expect(host.querySelector('[data-tx-confirm]')).toBeNull()
    expect(m.review).not.toHaveBeenCalled()
    expect(m.writeContract).not.toHaveBeenCalled()
  })

  it('follows a launch whose settlement lands during the exit: no send, and the saved submission is never released', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    saveEarlierLaunch()
    await mount()
    await act(async () => (button('Check again') ?? button('Try again'))!.click())
    await settle()
    await act(async () => { vi.setSystemTime(Date.now() + 31 * 60_000); vi.advanceTimersByTime(60_000) })
    await settle()
    const exit = button('I checked my wallet. Send again')
    expect(exit, 'the warned exit').toBeDefined()
    // The launch mines just as the user takes the exit: the exit's own check settles it.
    m.client = minedNode(HASH)
    await act(async () => exit!.click())
    await settle()
    // Recovery follows the settled launch into its domain checks: its receipt, never a new send.
    expect(m.waitReceipt).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ hash: HASH }))
    expect(m.review).not.toHaveBeenCalled()
    expect(m.writeContract).not.toHaveBeenCalled()
    expect(loadLaunchSession()?.statuses[1]).toMatchObject({ phase: 'confirming', txHash: HASH })
    // It follows once: one resume, not one per report of the settled hold.
    expect(m.waitReceipt).toHaveBeenCalledOnce()
  })

  it("saves a settled launch's hash into the journal before its domain checks run", async () => {
    // The hold saved and settled this launch's hash; the page reloaded before the journal saved it.
    const NEW_HASH = `0x${'ef'.repeat(32)}` as Hex
    m.client = minedNode(NEW_HASH)
    const hold = launchHold({ chainId: 1, account: ALICE, safe: false, salt: SALT, projectUri: 'ipfs://launch', call: LAUNCH_CALL })
    await hold.send(m.client as never, async gate => { await gate.beforeSend(); gate.afterSubmit(NEW_HASH); return NEW_HASH })
    await hold.state(m.client as never)
    localStorage.setItem(LAUNCH_SESSION_KEY, JSON.stringify({
      transport: 'direct', account: ALICE, salt: SALT, projectUri: 'ipfs://launch', store: {},
      plans: { 1: { projectName: 'Launch' } }, chains: [1],
      statuses: { 1: { phase: 'signing', held: true } }, createdAt: Date.now(),
    }))
    let journalAtChecks: unknown
    m.waitReceipt.mockImplementation(() => {
      journalAtChecks = loadLaunchSession()?.statuses[1]
      return new Promise(() => {})
    })
    await mount()
    await act(async () => (button('Check again') ?? button('Try again'))!.click())
    await settle()
    expect(m.waitReceipt).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ hash: NEW_HASH }))
    expect(journalAtChecks).toEqual({ phase: 'confirming', txHash: NEW_HASH, held: true, settled: true })
    expect(m.writeContract).not.toHaveBeenCalled()
  })

  it("reaches a saved launch's recovery even when the fee a fresh send needs can't be read", async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    m.fee.mockRejectedValue(new Error('fee read failed'))
    saveEarlierLaunch()
    await mount()
    await act(async () => (button('Check again') ?? button('Try again'))!.click())
    await settle()
    await act(async () => { vi.setSystemTime(Date.now() + 31 * 60_000); vi.advanceTimersByTime(60_000) })
    await settle()
    // The hold decides, with its exit, whatever preparation for a fresh send can't do.
    expect(button('I checked my wallet. Send again'), 'the warned exit').toBeDefined()
    expect(m.writeContract).not.toHaveBeenCalled()
  })

  it("keeps a settled launch whose project can't be read confirming: only Check again, never a check, discard or resend", async () => {
    const NEW_HASH = `0x${'ef'.repeat(32)}` as Hex
    m.client = minedNode(NEW_HASH)
    const hold = launchHold({ chainId: 1, account: ALICE, safe: false, salt: SALT, projectUri: 'ipfs://launch', call: LAUNCH_CALL })
    await hold.send(m.client as never, async gate => { await gate.beforeSend(); gate.afterSubmit(NEW_HASH); return NEW_HASH })
    await hold.state(m.client as never)
    localStorage.setItem(LAUNCH_SESSION_KEY, JSON.stringify({
      transport: 'direct', account: ALICE, salt: SALT, projectUri: 'ipfs://launch', store: {},
      plans: { 1: { projectName: 'Launch' } }, chains: [1],
      statuses: { 1: { phase: 'signing', held: true } }, createdAt: Date.now(),
    }))
    // Its receipt names no project.
    m.waitReceipt.mockResolvedValue({ transactionHash: NEW_HASH, status: 'success', blockNumber: 1n, logs: [] })
    await mount()
    await act(async () => (button('Check again') ?? button('Try again'))!.click())
    await settle()
    expect(host.textContent).toContain('Your launch went through. Its project is still confirming.')
    expect(button('Check again')).toBeDefined()
    expect(button('I checked it. Launch again')).toBeUndefined()
    expect(button('I checked my wallet. Send again')).toBeUndefined()
    expect(button('Cancel deployment')).toBeUndefined()
    expect(loadLaunchSession()?.statuses[1]).toMatchObject({ txHash: NEW_HASH })
    expect(m.writeContract).not.toHaveBeenCalled()
  })

  it('keeps the journal of a launch with a completed chain when another chain is retired through the check: the rest resumes as the same project', async () => {
    // Chain 1 launched; chain 10 was signing with no hold of its own when the page closed.
    localStorage.setItem(LAUNCH_SESSION_KEY, JSON.stringify({
      transport: 'direct', account: ALICE, salt: SALT, projectUri: 'ipfs://launch', store: {},
      plans: { 1: { projectName: 'Launch' }, 10: { projectName: 'Launch' } }, chains: [1, 10],
      statuses: { 1: { phase: 'done', projectId: 5 }, 10: { phase: 'signing' } }, createdAt: Date.now(),
    }))
    await mount()
    await act(async () => (button('Check again') ?? button('Try again'))!.click())
    await settle()
    await act(async () => button('I checked it. Launch again')!.click())
    await settle()
    // A journal holding a completed chain is never deleted: chain 1 keeps its project, chain 10 is retired.
    const journal = loadLaunchSession()
    expect(journal?.salt).toBe(SALT)
    expect(journal?.statuses[1]).toMatchObject({ phase: 'done', projectId: 5 })
    expect(journal?.statuses[10]).toMatchObject({ phase: 'failed' })
    expect(journal?.statuses[10]?.txHash).toBeUndefined()
    expect(m.writeContract).not.toHaveBeenCalled()
  })

  it('refuses a stale check once another tab completed that chain, even saved as done without settled, and keeps the journal', async () => {
    localStorage.setItem(LAUNCH_SESSION_KEY, JSON.stringify({
      transport: 'direct', account: ALICE, salt: SALT, projectUri: 'ipfs://launch', store: {},
      plans: { 1: { projectName: 'Launch' }, 10: { projectName: 'Launch' } }, chains: [1, 10],
      statuses: { 1: { phase: 'signing' }, 10: { phase: 'signing' } }, createdAt: Date.now(),
    }))
    await mount()
    await act(async () => (button('Check again') ?? button('Try again'))!.click())
    await settle()
    const checked = button('I checked it. Launch again')
    expect(checked, 'the check').toBeDefined()
    // Meanwhile another tab completed chain 1 (a main-era success: done, no settled flag) and chain 10 failed.
    const session = JSON.parse(localStorage.getItem(LAUNCH_SESSION_KEY)!)
    session.statuses = { 1: { phase: 'done', projectId: 5 }, 10: { phase: 'failed' } }
    localStorage.setItem(LAUNCH_SESSION_KEY, JSON.stringify(session))
    await act(async () => checked!.click())
    await settle()
    const journal = loadLaunchSession()
    expect(journal, 'the journal').not.toBeNull()
    expect(journal?.statuses[1]).toMatchObject({ phase: 'done', projectId: 5 })
    expect(m.writeContract).not.toHaveBeenCalled()
  })

  it('keeps a launch whose success was saved confirming after a reload, even when its settlement can no longer be read', async () => {
    // The hold proved this launch before the reload; its record is gone and the node can't answer now.
    localStorage.setItem(LAUNCH_SESSION_KEY, JSON.stringify({
      transport: 'direct', account: ALICE, salt: SALT, projectUri: 'ipfs://launch', store: {},
      plans: { 1: { projectName: 'Launch' } }, chains: [1],
      statuses: { 1: { phase: 'confirming', txHash: HASH, settled: true } }, createdAt: Date.now(),
    }))
    m.client = { ...emptyNode(), getTransaction: async () => { throw new Error('node down') }, getChainId: async () => { throw new Error('node down') } }
    m.waitReceipt.mockRejectedValue(new Error('node down'))
    await mount()
    await act(async () => (button('Check again') ?? button('Try again'))!.click())
    await settle()
    expect(host.textContent).toContain('Your launch went through. Its project is still confirming.')
    expect(button('I checked it. Launch again')).toBeUndefined()
    expect(button('I checked my wallet. Send again')).toBeUndefined()
    expect(loadLaunchSession()?.statuses[1]).toMatchObject({ txHash: HASH, settled: true })
    expect(m.writeContract).not.toHaveBeenCalled()
  })

  it('refuses a stale check action once another tab saved the launch as a success', async () => {
    localStorage.setItem(LAUNCH_SESSION_KEY, JSON.stringify({
      transport: 'direct', account: ALICE, salt: SALT, projectUri: 'ipfs://launch', store: {},
      plans: { 1: { projectName: 'Launch' } }, chains: [1],
      statuses: { 1: { phase: 'signing' } }, createdAt: Date.now(),
    }))
    await mount()
    await act(async () => (button('Check again') ?? button('Try again'))!.click())
    await settle()
    const checked = button('I checked it. Launch again')
    expect(checked, 'the check').toBeDefined()
    // Meanwhile another tab proved the launch and saved its success.
    const session = JSON.parse(localStorage.getItem(LAUNCH_SESSION_KEY)!)
    session.statuses[1] = { phase: 'confirming', txHash: HASH, settled: true }
    localStorage.setItem(LAUNCH_SESSION_KEY, JSON.stringify(session))
    await act(async () => checked!.click())
    await settle()
    // A saved success is never retired: the launch record and its hash stay.
    expect(loadLaunchSession()?.statuses[1]).toMatchObject({ txHash: HASH, settled: true })
    expect(m.writeContract).not.toHaveBeenCalled()
  })

  it("refuses a check while the journal can't be read, keeping the attempt, its button and a success another tab saved", async () => {
    localStorage.setItem(LAUNCH_SESSION_KEY, JSON.stringify({
      transport: 'direct', account: ALICE, salt: SALT, projectUri: 'ipfs://launch', store: {},
      plans: { 1: { projectName: 'Launch' } }, chains: [1],
      statuses: { 1: { phase: 'signing' } }, createdAt: Date.now(),
    }))
    await mount()
    await act(async () => (button('Check again') ?? button('Try again'))!.click())
    await settle()
    // Another tab saves the launch's success; then this tab's read of the journal fails.
    const session = JSON.parse(localStorage.getItem(LAUNCH_SESSION_KEY)!)
    session.statuses[1] = { phase: 'confirming', txHash: HASH, settled: true }
    localStorage.setItem(LAUNCH_SESSION_KEY, JSON.stringify(session))
    const read = Storage.prototype.getItem
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key: string) {
      if (key === LAUNCH_SESSION_KEY) throw new Error('storage unavailable')
      return read.call(this, key)
    })
    await act(async () => button('I checked it. Launch again')!.click())
    await settle()
    expect(host.textContent).toContain("Couldn't check this transaction. Try again.")
    expect(button('I checked it. Launch again')).toBeDefined()
    vi.mocked(Storage.prototype.getItem).mockRestore()
    // Nothing was written over the saved success.
    expect(loadLaunchSession()?.statuses[1]).toMatchObject({ phase: 'confirming', txHash: HASH, settled: true })
  })

  it("after a failed read, offers a warned Continue anyway that discards the unreadable record and reopens the form", async () => {
    localStorage.setItem(LAUNCH_SESSION_KEY, JSON.stringify({
      transport: 'direct', account: ALICE, salt: SALT, projectUri: 'ipfs://launch', store: {},
      plans: { 1: { projectName: 'Launch' } }, chains: [1],
      statuses: { 1: { phase: 'signing' } }, createdAt: Date.now(),
    }))
    await mount()
    await act(async () => (button('Check again') ?? button('Try again'))!.click())
    await settle()
    // Never offered first.
    expect(button('I checked my wallet. Continue anyway')).toBeUndefined()
    const read = Storage.prototype.getItem
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key: string) {
      if (key === LAUNCH_SESSION_KEY) throw new Error('storage unavailable')
      return read.call(this, key)
    })
    await act(async () => button('I checked it. Launch again')!.click())
    await settle()
    expect(host.textContent).toContain("Couldn't check this transaction. Try again.")
    expect(host.textContent).toContain("This browser can't read its saved transactions. Check your wallet before sending again.")
    const anyway = button('I checked my wallet. Continue anyway')
    expect(anyway, 'the warned continue').toBeDefined()
    await act(async () => anyway!.click())
    await settle()
    vi.mocked(Storage.prototype.getItem).mockRestore()
    // The unreadable record is gone and the form reopens: the next launch pins a fresh salt.
    expect(loadLaunchSession()).toBeNull()
    expect(host.querySelector('[data-tx-confirm]')).toBeNull()
    expect(m.writeContract).not.toHaveBeenCalled()
  })
})

