// @vitest-environment jsdom

/**
 * A payment is built for the account that reviewed it: its beneficiary or swap
 * recipient, and the owner of its approvals. When the wallet switches to
 * another account before the payment is confirmed, that account must not pay
 * for the first one's tokens. Nothing reaches the wallet, and the payment
 * dialog says why.
 *
 * The real useSafeTx and the SDK's reviewed write run here; only the wallet,
 * the RPC and the app review are fakes.
 */

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Address, Hex } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ALICE = '0x1111111111111111111111111111111111111111' as Address
const BOB = '0x2222222222222222222222222222222222222222' as Address
const NATIVE = '0x000000000000000000000000000000000000EEEe' as Address
const USDC = '0x4444444444444444444444444444444444444444' as Address
const TERMINAL = '0x5555555555555555555555555555555555555555' as Address
const APPROVAL = `0x${'a1'.repeat(32)}` as Hex
const PAYMENT = `0x${'a2'.repeat(32)}` as Hex
const CHANGED = 'The connected account changed. Review again.'

const w = vi.hoisted(() => ({
  account: '' as string,
  token: 'native' as 'native' | 'erc20',
  writeContract: vi.fn(),
  requestReview: vi.fn(),
  switchChain: vi.fn(),
  /** Resolves the approval's receipt; set while the sequence waits on it. */
  confirmApproval: null as null | (() => void),
}))

vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('@wagmi/core', async importOriginal => ({
  ...(await importOriginal<typeof import('@wagmi/core')>()),
  getAccount: () => ({ address: w.account, chainId: 1 }),
}))
vi.mock('wagmi', () => ({
  usePublicClient: () => client,
  useWriteContract: () => ({ writeContractAsync: w.writeContract }),
  useSwitchChain: () => ({ switchChainAsync: w.switchChain }),
  useWaitForTransactionReceipt: () => ({ data: undefined, isError: false }),
  useConfig: () => ({}),
  useSignTypedData: () => ({ signTypedDataAsync: vi.fn() }),
}))
vi.mock('@/hooks/useWallet', () => ({
  useWallet: () => ({ isConnected: true, address: w.account, openSignIn: () => {}, isCenterWallet: false }),
}))
vi.mock('@/lib/transaction-review', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/transaction-review')>()),
  requestContractTransactionReview: w.requestReview,
}))
vi.mock('@/lib/safe-connector', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/safe-connector')>()),
  isSafeConnection: () => false,
  useSafeConnection: () => false,
}))
vi.mock('@tanstack/react-query', async importOriginal => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => query(String(queryKey[0])),
}))
vi.mock('@/hooks/useProjectTokenSymbol', () => ({
  useProjectTokenSymbol: () => ({ data: { symbol: 'TKN' } }),
}))
vi.mock('@/hooks/useTokenBalance', () => ({ useTokenBalance: () => ({ balance: 10n ** 24n }) }))
vi.mock('@/hooks/useTokenBalances', () => ({
  useTokenBalances: () => ({ balances: new Map([[NATIVE, 10n ** 24n], [USDC, 10n ** 24n]]) }),
}))
vi.mock('@/components/GetFunds', () => ({ useOnRamp: () => ({ supported: false, buy: () => {} }) }))
vi.mock('@/components/project/ShopCartProvider', () => ({
  useShopCart: () => ({ quantities: {}, items: {}, count: 0, setQuantity: () => {}, registerItem: () => {}, clear: () => {} }),
}))
vi.mock('@/providers/preload-para', () => ({ preloadParaHost: () => {} }))
vi.mock('@/components/project/MarketSection', () => ({ resolveMarket: vi.fn() }))
vi.mock('@/components/project/Tabs', () => ({ replaceProjectTabHash: () => {} }))
vi.mock('@/components/ui/ModalShell', () => ({
  ModalShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))
vi.mock('@/components/ui/TxConfirmDialog', () => ({
  TxConfirmDialog: ({ open, action, onConfirm, error, status }: {
    open: boolean
    action: string
    onConfirm: () => void
    error?: ReactNode
    status?: ReactNode
  }) =>
    open ? (
      <section data-tx-confirm>
        <p data-status>{status}</p>
        <p data-error>{error}</p>
        <button type="button" onClick={onConfirm}>{action}</button>
      </section>
    ) : null,
}))

const contextFor = (token: 'native' | 'erc20') =>
  token === 'native'
    ? { token: NATIVE, decimals: 18, currency: 61166, symbol: 'ETH', terminal: TERMINAL, viaRouter: false }
    : { token: USDC, decimals: 6, currency: 909516616, symbol: 'USDC', terminal: TERMINAL, viaRouter: false }

function query(key: string) {
  switch (key) {
    case 'paySurface':
      return {
        data: { contexts: [contextFor(w.token)], rulesetStart: 0, pausePay: false, terminals: [TERMINAL], unknown: [] },
        isError: false,
      }
    case 'previewPay':
      return {
        data: { beneficiaryTokenCount: 10n ** 21n, reservedTokenCount: 0n },
        isFetching: false, isError: false, isPlaceholderData: false, isStale: false, refetch: vi.fn(),
      }
    case 'payMarket':
      return { data: { status: 'none' } }
    case 'payAllowance':
      return { data: 0n, refetch: vi.fn(async () => ({ data: 10n ** 30n })) }
    case 'payShopCredits':
      return { data: 0n, isLoading: false }
    default:
      return {
        data: undefined, isFetching: false, isFetched: false, isError: false, isLoading: false,
        isPlaceholderData: false, isStale: false, refetch: vi.fn(async () => ({})),
      }
  }
}

const client = {
  simulateContract: vi.fn(async (args: Record<string, unknown>) => ({ request: { ...args } })),
  estimateContractGas: vi.fn(async () => 50_000n),
  waitForTransactionReceipt: vi.fn(
    ({ hash }: { hash: Hex }) =>
      new Promise(resolve => {
        w.confirmApproval = () => resolve({ status: 'success', blockNumber: 10n, transactionHash: hash })
      }),
  ),
  getTransactionReceipt: vi.fn(async () => null),
}

import { PayPanel } from '@/components/project/PayPanel'

let host: HTMLDivElement
let root: Root

const panel = () => (
  <PayPanel chainId={1} projectId={42} projectName="Project" isRevnet={false} chains={[[1, 42]]} />
)

beforeEach(() => {
  w.account = ALICE
  w.token = 'native'
  w.confirmApproval = null
  w.requestReview.mockResolvedValue(true)
  w.switchChain.mockResolvedValue(undefined)
  w.writeContract.mockImplementation(async () => (w.writeContract.mock.calls.length === 1 ? APPROVAL : PAYMENT))
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

async function render() {
  await act(async () => root.render(panel()))
}

/** The wallet switches account; the panel sees it on its next render. */
async function switchAccount(account: Address) {
  w.account = account
  await act(async () => root.render(panel()))
}

/** Let timers, animation frames and effects run until `done` holds. */
async function waitUntil(done: () => boolean) {
  for (let attempt = 0; attempt < 40 && !done(); attempt++) {
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 25))
    })
  }
}

function button(label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find(item => item.textContent === label)
  expect(found, label).toBeDefined()
  return found!
}

async function click(label: string) {
  await act(async () => button(label).click())
}

/** Type an amount and let the panel's 400 ms debounce settle. */
async function enterAmount(value: string) {
  const input = host.querySelector<HTMLInputElement>('input[aria-label="Amount"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 450))
  })
}

/** Review a payment as Alice: the sequence dialog opens on its frozen actions. */
async function reviewPayment() {
  await render()
  await enterAmount('1')
  await click('Pay')
  expect(host.querySelector('[data-tx-confirm]')).not.toBeNull()
}

const dialogError = () => host.querySelector('[data-error]')?.textContent

describe('a payment reviewed for one account', () => {
  it('wallet-action:pay-a-project never pays from an account switched to before confirming', async () => {
    await reviewPayment()
    await switchAccount(BOB)
    await click('Confirm & Pay')
    await waitUntil(() => !!dialogError() || w.writeContract.mock.calls.length > 0)

    expect(w.writeContract).not.toHaveBeenCalled()
    expect(w.requestReview).not.toHaveBeenCalled()
    expect(dialogError()).toBe(CHANGED)
  })

  it('wallet-action:approve-an-erc-20 never approves from an account switched to before confirming', async () => {
    w.token = 'erc20'
    await reviewPayment()
    await switchAccount(BOB)
    await click('Confirm & Pay')
    await waitUntil(() => !!dialogError() || w.writeContract.mock.calls.length > 0)

    expect(w.writeContract).not.toHaveBeenCalled()
    expect(w.requestReview).not.toHaveBeenCalled()
    expect(dialogError()).toBe(CHANGED)
  })

  it('stops after an approval when the account switches before the payment, and says why', async () => {
    w.token = 'erc20'
    await reviewPayment()
    await click('Confirm & Pay')
    await waitUntil(() => !!w.confirmApproval)
    // Alice's approval reached her wallet and is confirming.
    expect(w.writeContract).toHaveBeenCalledOnce()
    expect(w.writeContract.mock.calls[0][0]).toMatchObject({ functionName: 'approve', account: ALICE })

    await switchAccount(BOB)
    await act(async () => w.confirmApproval!())
    await waitUntil(() => !!dialogError())

    expect(w.writeContract).toHaveBeenCalledOnce()
    expect(dialogError()).toBe(CHANGED)
  })

  it('pays from the account that reviewed it, as its beneficiary', async () => {
    await reviewPayment()
    await click('Confirm & Pay')
    await waitUntil(() => w.writeContract.mock.calls.length > 0)

    expect(w.writeContract).toHaveBeenCalledOnce()
    const sent = w.writeContract.mock.calls[0][0] as { functionName: string; args: readonly unknown[]; account: unknown }
    expect(sent.functionName).toBe('pay')
    expect(sent.account).toBe(ALICE)
    expect(sent.args[3]).toBe(ALICE)
  })
})
