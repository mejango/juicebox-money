// @vitest-environment jsdom

/**
 * A launch saved by an earlier visit, mounted as the create page restores it:
 * its saved submission is recovered through the launch's write hold (the shared
 * recovery rule), never sent again, and never a dead end.
 */

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { parseAbi, type Address, type Hex } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ALICE = '0x1111111111111111111111111111111111111111' as Address
const DEPLOYER = '0x2222222222222222222222222222222222222222' as Address
const HASH = `0x${'ab'.repeat(32)}` as Hex
const SALT = `0x${'5a'.repeat(32)}` as Hex

const m = vi.hoisted(() => ({
  writeContract: vi.fn(),
  review: vi.fn(),
  client: {} as Record<string, unknown>,
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
  waitForTransactionReceipt: vi.fn(() => new Promise(() => {})),
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
  getProjectCreationFee: async () => 0n,
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

const button = (label: string) => [...host.querySelectorAll('button')].find(item => item.textContent === label)

async function settle() {
  for (let i = 0; i < 20; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) })
}

beforeEach(() => {
  localStorage.clear()
  m.client = emptyNode()
  m.writeContract.mockReset()
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
    // Only the exit retires the saved submission; the resend then opens a fresh review (cancelled here).
    expect(loadLaunchSession()?.statuses[1]?.txHash).toBeUndefined()
    // Retired, it no longer keeps the launch from being cancelled.
    expect(button('Cancel deployment')).toBeDefined()
    expect(m.review).toHaveBeenCalled()
    expect(m.writeContract).not.toHaveBeenCalled()
  })
})
