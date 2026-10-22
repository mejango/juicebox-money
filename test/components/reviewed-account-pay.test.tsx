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
import { encodeAbiParameters, encodeFunctionData, erc20Abi, zeroAddress, type Address } from 'viem'
import { QueryClient } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFIFA_RECOVERY_QUERY_PREFIX, defifaWriteNamespace, readDefifaWriteRecovery } from '@/lib/defifa-write-recovery'
import {
  buildDefifaPayMetadata,
  buildPayTx,
  PAY_QUOTE_FAILED_MESSAGE,
  PAY_SWAP_QUOTE_FAILED_MESSAGE,
  PaySwapQuoteFailedError,
} from '@bananapus/nana-sdk-core/v6'
import {
  HELD_AWAY_SUCCESS_LINE, HELD_CONFIRMING_LINE, HELD_EXIT_LABEL, HELD_RELEASED_ELSEWHERE_LINE, HELD_RELEASED_LINE, HELD_SEND_AGAIN_LABEL,
  SAVED_ATTEMPT_CHECK_LINE, SAVED_ATTEMPT_UNREADABLE_LINE, WRITE_HOLD_IN_TAB_LINE, WRITE_HOLD_PENDING_LINE,
} from '@bananapus/nana-sdk-core/review'

const ALICE = '0x1111111111111111111111111111111111111111' as Address
const BOB = '0x2222222222222222222222222222222222222222' as Address
const NATIVE = '0x000000000000000000000000000000000000EEEe' as Address
const USDC = '0x4444444444444444444444444444444444444444' as Address
const TERMINAL = '0x5555555555555555555555555555555555555555' as Address
const CHANGED = 'The connected account changed. Review again.'

const displayQueries = new QueryClient()
/** The app's query defaults (Providers), for the real prepareUserPay query. */
const prepareQueries = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false } } })

const PREPARED_DEFAULT = vi.hoisted(() => ({
  metadata: `0x${'ab'.repeat(32)}` as `0x${string}`,
  preview: { beneficiaryTokenCount: 10n ** 21n, reservedTokenCount: 0n },
  minReturnedTokens: 7n * 10n ** 20n,
}))
// Its minimum is deliberately not 99% of the preview: the panel sends what prepareUserPay returns.
const PREPARED = PREPARED_DEFAULT
const m = vi.hoisted(() => ({
  token: 'native' as 'native' | 'erc20',
  /** Connected as a Safe app, whose Safe is the account. */
  safe: false,
  waitForSafeExecutionHash: (() => Promise.reject(new Error('unset'))) as (...args: unknown[]) => Promise<unknown>,
  /** Ends nothing unless a test says so. */
  watchSafeProposal: (() => new Promise(() => {})) as (...args: unknown[]) => Promise<unknown>,
  /** Query answers a test sets in place of the defaults, by key. */
  queries: {} as Record<string, unknown>,
  realNativeRecovery: false,
  nativePrepared: null as unknown,
  /** The SDK's prepareUserPay, run by the real query. */
  prepareUserPay: (async () => PREPARED_DEFAULT) as (...args: unknown[]) => Promise<unknown>,
  /** Drive the real shop cart, not the empty stand-in. */
  realCart: false,
  /** Offer buying ETH with dollars in the token select. */
  onRamp: false,
  /** The onchain sucker group the SDK reads from the registries. */
  resolveSuckers: (async () => []) as (...args: unknown[]) => Promise<unknown>,
  /** The chain the fake wallet is on; a switch moves it. */
  walletChain: 1,
}))

vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('@wagmi/core', async importOriginal => {
  const { wallet } = await import('../support/fake-wallet')
  return {
    ...(await importOriginal<typeof import('@wagmi/core')>()),
    getAccount: () => ({ address: wallet.account, chainId: m.walletChain }),
  }
})
vi.mock('wagmi', async () => {
  const { walletHooks } = await import('../support/fake-wallet')
  return {
    ...walletHooks,
    useConfig: () => ({}),
    useSignTypedData: () => ({ signTypedDataAsync: vi.fn() }),
  }
})
vi.mock('@/hooks/useWallet', async () => {
  const { useFakeWallet } = await import('../support/fake-wallet')
  return { useWallet: useFakeWallet }
})
vi.mock('@/lib/transaction-review', async importOriginal => {
  const { wallet } = await import('../support/fake-wallet')
  return {
    ...(await importOriginal<typeof import('@/lib/transaction-review')>()),
    requestContractTransactionReview: wallet.requestReview,
  }
})
vi.mock('@/lib/safe-connector', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/safe-connector')>()),
  isSafeConnection: () => m.safe,
  useSafeConnection: () => m.safe,
  findPendingSafeAppProposal: async () => null,
  // The reply is the Safe app's proposal, never an execution.
  atOnceExecution: async () => null,
  waitForSafeExecutionHash: (...args: unknown[]) => m.waitForSafeExecutionHash(...args),
  watchSafeProposal: (...args: unknown[]) => m.watchSafeProposal(...args),
}))
vi.mock('@tanstack/react-query', async importOriginal => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>()
  return { ...actual, useQueryClient: () => displayQueries,
    useQuery: (options: Parameters<typeof actual.useQuery>[0]) => options.queryKey[0] === 'prepareUserPay'
      ? actual.useQuery(options, prepareQueries)
      : options.queryKey[0] === 'suckerGroup'
      ? actual.useQuery({ ...options, retry: false }, displayQueries)
      : m.realNativeRecovery && options.queryKey[0] === DEFIFA_RECOVERY_QUERY_PREFIX[0]
      ? actual.useQuery(options, displayQueries)
      : query(String(options.queryKey[0] === 'projectDisplay' ? options.queryKey[4] : options.queryKey[0])),
  }
})
vi.mock('@/hooks/useShop721', async original => ({
  ...(await original<typeof import('@/hooks/useShop721')>()),
  useShop721Media: () => ({ data: undefined }),
  useShop721: () => ({ data: null, isSuccess: true, ...m.queries.nativeInventory as object }),
}))
vi.mock('@bananapus/nana-sdk-core', async original => ({
  ...(await original<typeof import('@bananapus/nana-sdk-core')>()),
  resolveSuckers: (...args: unknown[]) => m.resolveSuckers(...args),
}))
vi.mock('@bananapus/nana-sdk-core/v6', async original => {
  const actual = await original<typeof import('@bananapus/nana-sdk-core/v6')>()
  return { ...actual, getProjectNftInventory: vi.fn(async () => null),
    prepareUserPay: (...args: unknown[]) => m.prepareUserPay(...args),
    prepareDefifaPay: (...args: Parameters<typeof actual.prepareDefifaPay>) => m.nativePrepared ? Promise.resolve(m.nativePrepared) : actual.prepareDefifaPay(...args),
  }
})
vi.mock('@/hooks/useProjectTokenSymbol', () => ({
  useProjectTokenSymbol: () => ({ data: { symbol: 'TKN' } }),
}))
vi.mock('@/hooks/useTokenBalance', () => ({ useTokenBalance: () => ({ balance: 10n ** 24n }) }))
vi.mock('@/hooks/useTokenBalances', () => ({
  useTokenBalances: () => ({
    balances: new Map([
      ['0x000000000000000000000000000000000000EEEe', 10n ** 24n],
      ['0x4444444444444444444444444444444444444444', 10n ** 24n],
    ]),
  }),
}))
vi.mock('@/components/GetFunds', () => ({ useOnRamp: () => ({ supported: m.onRamp, buy: () => {} }) }))
vi.mock('@/components/project/ShopCartProvider', async original => {
  const actual = await original<typeof import('@/components/project/ShopCartProvider')>()
  const empty = { quantities: {}, items: {}, count: 0, setQuantity: () => {}, registerItem: () => {}, clear: () => {} }
  return { ...actual, useShopCart: () => (m.realCart ? actual.useShopCart() : empty) }
})
vi.mock('@/providers/preload-para', () => ({ preloadParaHost: () => {} }))
vi.mock('@/components/project/MarketSection', () => ({ resolveMarket: vi.fn() }))
vi.mock('@/components/project/Tabs', () => ({ replaceProjectTabHash: () => {} }))
vi.mock('@/components/ui/ModalShell', () => ({
  ModalShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))
vi.mock('@/components/ui/TxConfirmDialog', () => ({
  TxConfirmDialog: ({ open, action, onConfirm, onClose, complete, error, status, notice, rows, children }: {
    open: boolean
    action: string
    onConfirm: () => void
    onClose: () => void
    complete?: boolean
    error?: ReactNode
    status?: ReactNode
    notice?: ReactNode
    rows?: { label: ReactNode; value: ReactNode }[]
    children?: ReactNode
  }) =>
    open ? (
      <section data-tx-confirm>
        {rows?.map((row, index) => <p key={index} data-row={String(row.label)}>{row.value}</p>)}
        <p data-status>{status}</p>
        <p data-error>{error}</p>
        {children}
        {notice}
        {!complete ? <button type="button" onClick={onClose}>Close review</button> : null}
        {complete ? (
          <button type="button" onClick={onClose}>Done</button>
        ) : (
          <button type="button" onClick={onConfirm}>{action}</button>
        )}
      </section>
    ) : null,
}))

const contextFor = (token: 'native' | 'erc20') =>
  token === 'native'
    ? { token: NATIVE, decimals: 18, currency: 61166, symbol: 'ETH', terminal: TERMINAL, viaRouter: false }
    : { token: USDC, decimals: 6, currency: 909516616, symbol: 'USDC', terminal: TERMINAL, viaRouter: false }

function query(key: string) {
  if (key in m.queries) return m.queries[key]
  switch (key) {
    case 'payNftProtocol':
      return { data: null, isSuccess: true, isError: false, refetch: vi.fn() }
    case 'paySurface':
      return {
        data: { contexts: [contextFor(m.token)], rulesetStart: 0, pausePay: false, terminals: [TERMINAL], unknown: [] },
        isError: false,
      }
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

import { sentHash, wallet } from '../support/fake-wallet'
import { PayPanel } from '@/components/project/PayPanel'
import { clearSuckerGroups } from '@/lib/sucker-group'

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  wallet.reset()
  wallet.connect(ALICE)
  m.token = 'native'
  m.safe = false
  m.queries = {}
  m.realNativeRecovery = false
  m.nativePrepared = null
  m.prepareUserPay = vi.fn(async () => PREPARED)
  m.realCart = false
  m.onRamp = false
  m.resolveSuckers = async () => []
  m.walletChain = 1
  clearSuckerGroups()
  displayQueries.clear()
  prepareQueries.clear()
  localStorage.clear()
  m.watchSafeProposal = () => new Promise(() => {})
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

/** Let timers, animation frames and effects run until `done` holds. */
async function waitUntil(done: () => boolean) {
  for (let attempt = 0; attempt < 40 && !done(); attempt++) {
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 25))
    })
  }
}

function button(label: string, required = true): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find(item => item.textContent === label)
  if (required) expect(found, label).toBeDefined()
  return found!
}

async function click(label: string) {
  await act(async () => button(label).click())
}

/**
 * Review a payment of `amount` as Alice: the sequence dialog opens on its
 * frozen actions. Proposals stay with the Safe for the page, so each Safe test
 * pays its own amount.
 */
async function reviewPayment(amount = '1', payDisclosure?: string) {
  await enterAmount(amount, payDisclosure)
  if (payDisclosure) expect(host.textContent).not.toContain(payDisclosure)
  await click('Pay')
  expect(host.querySelector('[data-tx-confirm]')).not.toBeNull()
}

/** Type `amount` as Alice and wait for its quote: Pay is ready. */
async function enterAmount(amount = '1', payDisclosure?: string) {
  await act(async () =>
    root.render(<PayPanel chainId={1} projectId={42} projectName="Project" isRevnet={false} chains={[[1, 42]]} payDisclosure={payDisclosure} />),
  )
  await typeAmount(amount)
  // The panel debounces the amount for 400 ms before it previews and quotes.
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 450))
  })
  // The real prepareUserPay query settles a tick later.
  await waitUntil(() => button('Pay', false)?.disabled === false)
}

/**
 * The SDK follower lost Safe's service for every proposal it follows: the hold takes each as unproven, with its exit,
 * and the page reads it again as it regains focus.
 */
async function loseService() {
  const { writeHolds } = await import('@/lib/write-holds')
  for (const { handle, record } of writeHolds.list({ account: ALICE, chainId: 1 })) {
    if (record.hash) await handle.onUnproven(wallet.client as never, record.hash)
  }
  await act(async () => { window.dispatchEvent(new Event('focus')) })
}

const dialogError = () => host.querySelector('[data-error]')?.textContent
const dialogStatus = () => host.querySelector('[data-status]')?.textContent

describe('a payment reviewed for one account', () => {
  it('wallet-action:pay-a-project never pays from an account switched to before confirming', async () => {
    await reviewPayment()
    await act(async () => wallet.connect(BOB))
    await click('Confirm & Pay')
    await waitUntil(() => !!dialogError() || wallet.writeContract.mock.calls.length > 0)

    expect(wallet.writeContract).not.toHaveBeenCalled()
    expect(wallet.requestReview).not.toHaveBeenCalled()
    expect(dialogError()).toBe(CHANGED)
  })

  it('wallet-action:approve-an-erc-20 never approves from an account switched to before confirming', async () => {
    m.token = 'erc20'
    await reviewPayment()
    await act(async () => wallet.connect(BOB))
    await click('Confirm & Pay')
    await waitUntil(() => !!dialogError() || wallet.writeContract.mock.calls.length > 0)

    expect(wallet.writeContract).not.toHaveBeenCalled()
    expect(wallet.requestReview).not.toHaveBeenCalled()
    expect(dialogError()).toBe(CHANGED)
  })

  it('stops after an approval when the account switches before the payment, and says why', async () => {
    m.token = 'erc20'
    await reviewPayment()
    await click('Confirm & Pay')
    await waitUntil(() => wallet.awaits(sentHash(1)))
    // Alice's approval reached her wallet and is confirming.
    expect(wallet.writes()).toEqual([{ functionName: 'approve', account: ALICE }])

    await act(async () => wallet.connect(BOB))
    await act(async () => wallet.confirm(sentHash(1)))
    await waitUntil(() => !!dialogError())

    expect(wallet.writes()).toEqual([{ functionName: 'approve', account: ALICE }])
    expect(dialogError()).toBe(CHANGED)
  })

  it('moves the project notice from the form into the payment confirmation', async () => {
    const notice = 'Project terms.\n\nContact the project after paying.'
    await reviewPayment('1', notice)
    const disclosure = host.querySelector('[data-tx-confirm] details')!
    expect(disclosure).not.toBeNull()
    expect(disclosure.querySelector('p')?.textContent).toBe(notice)
    expect(wallet.writeContract).not.toHaveBeenCalled()
  })

  it.each(['native', 'erc20'] as const)('clears progress when the %s wallet review is cancelled', async token => {
    m.token = token
    let answerReview!: (answer: boolean) => void
    wallet.requestReview.mockImplementationOnce(() => new Promise<boolean>(resolve => { answerReview = resolve }))
    await reviewPayment()
    await click('Confirm & Pay')
    await waitUntil(() => wallet.requestReview.mock.calls.length === 1)
    expect(host.querySelector('[data-status]')?.textContent).toBe(
      token === 'native' ? 'Review and execute the payment.' : 'Review and approve USDC access.',
    )
    await act(async () => answerReview(false))
    await waitUntil(() => !!host.querySelector('[data-error]')?.textContent?.includes('cancelled'))
    expect(host.querySelector('[data-status]')?.textContent).toBe('')
    expect(wallet.writeContract).not.toHaveBeenCalled()
  })

  it("pays from the account that reviewed it, as its beneficiary, with prepareUserPay's metadata and minimum", async () => {
    await reviewPayment()
    await click('Confirm & Pay')
    await waitUntil(() => wallet.writeContract.mock.calls.length > 0)

    expect(wallet.writes()).toEqual([{ functionName: 'pay', account: ALICE }])
    const [request] = wallet.writeContract.mock.calls[0] as unknown as [{ args: readonly unknown[] }]
    expect(request.args[3]).toBe(ALICE)
    expect(request.args[4]).toBe(PREPARED.minReturnedTokens)
    expect(request.args[6]).toBe(PREPARED.metadata)
  })
})

async function typeAmount(amount: string) {
  const input = host.querySelector<HTMLInputElement>('input[aria-label="Amount"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, amount)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 450)) })
const renderPanel = () => act(async () =>
  root.render(<PayPanel chainId={1} projectId={42} projectName="Project" isRevnet={false} chains={[[1, 42]]} />))
const preparedArgs = (call: number) => (vi.mocked(m.prepareUserPay).mock.calls[call] as unknown[])[1] as Record<string, unknown>

describe('a payment prepareUserPay prepares', () => {
  it('prepares the typed amount at the terminal entry for the payer', async () => {
    await reviewPayment('1')
    expect(preparedArgs(0)).toMatchObject({ chainId: 1, terminal: TERMINAL, projectId: 42n, token: NATIVE, amount: 10n ** 18n, beneficiary: ALICE, tiers: undefined })
  })

  it('approves the terminal entry for exactly the amount', async () => {
    m.token = 'erc20'
    await reviewPayment('7')
    await click('Confirm & Pay')
    await waitUntil(() => wallet.writeContract.mock.calls.length > 0 || !!dialogError())
    const [request] = wallet.writeContract.mock.calls[0] as unknown as [{ functionName: string; address: Address; args: readonly unknown[] }]
    expect(request.functionName).toBe('approve')
    expect(request.address).toBe(USDC)
    expect(request.args).toEqual([TERMINAL, 7_000_000n])
  })

  it('blocks paying while the preparation is pending', async () => {
    m.prepareUserPay = vi.fn(() => new Promise(() => {}))
    await renderPanel()
    await typeAmount('1')
    await settle()
    expect(m.prepareUserPay).toHaveBeenCalled()
    expect(button('Pay').disabled).toBe(true)
  })

  it('blocks paying when the preparation fails, and offers a retry', async () => {
    m.prepareUserPay = vi.fn(async () => { throw new Error('hookOf unreadable') })
    await renderPanel()
    await typeAmount('1')
    await waitUntil(() => host.textContent?.includes('Try again') ?? false)
    expect(button('Pay').disabled).toBe(true)
    await click('Try again')
    await waitUntil(() => vi.mocked(m.prepareUserPay).mock.calls.length > 1)
    expect(vi.mocked(m.prepareUserPay).mock.calls.length).toBeGreaterThan(1)
    expect(wallet.writeContract).not.toHaveBeenCalled()
  })

  it('shows a failed swap quote as one line with Retry, and never pays on it', async () => {
    m.prepareUserPay = vi.fn(async () => { throw new PaySwapQuoteFailedError(new Error('quoter unreadable')) })
    await renderPanel()
    await typeAmount('1')
    await waitUntil(() => host.textContent?.includes(PAY_SWAP_QUOTE_FAILED_MESSAGE) ?? false)
    const line = [...host.querySelectorAll('p')].find(p => p.textContent?.includes(PAY_SWAP_QUOTE_FAILED_MESSAGE))
    expect(line?.textContent).toBe(`${PAY_SWAP_QUOTE_FAILED_MESSAGE} Retry`)
    expect(host.textContent).not.toContain("Couldn't verify what this payment returns")
    expect(button('Pay').disabled).toBe(true)
    await click('Retry')
    await waitUntil(() => vi.mocked(m.prepareUserPay).mock.calls.length > 1)
    expect(wallet.writeContract).not.toHaveBeenCalled()
  })

  it('pays the amount typed now, not the one prepared before it changed', async () => {
    let release!: (value: unknown) => void
    m.prepareUserPay = vi.fn(async (_client: unknown, args: { amount: bigint }) =>
      args.amount === 10n ** 18n ? new Promise(resolve => { release = resolve }) : PREPARED) as never
    await renderPanel()
    await typeAmount('100')
    await waitUntil(() => button('Pay', false)?.disabled === false)
    expect(button('Pay').disabled).toBe(false)
    // Changed and clicked inside the debounce: nothing opens until 1 ETH is prepared.
    await typeAmount('1')
    await click('Pay')
    await waitUntil(() => vi.mocked(m.prepareUserPay).mock.calls.length > 1)
    expect(host.querySelector('[data-tx-confirm]')).toBeNull()
    await act(async () => release(PREPARED))
    await waitUntil(() => !!host.querySelector('[data-tx-confirm]'))
    await click('Confirm & Pay')
    await waitUntil(() => wallet.writeContract.mock.calls.length > 0)
    const [request] = wallet.writeContract.mock.calls[0] as unknown as [{ args: readonly unknown[]; value: bigint }]
    expect(request.args[2]).toBe(10n ** 18n)
    expect(request.value).toBe(10n ** 18n)
  })
})

const TERMINAL_2 = '0x6666666666666666666666666666666666666666' as Address
const OTHER_METADATA = `0x${'cd'.repeat(32)}` as `0x${string}`
const surfaceWith = (patch: Record<string, unknown>) => ({
  data: { contexts: [contextFor('native')], rulesetStart: 0, pausePay: false, terminals: [TERMINAL], unknown: [], ...patch },
  isError: false,
})
async function confirmAndSend() {
  await click('Pay')
  await waitUntil(() => !!host.querySelector('[data-tx-confirm]'))
  await click('Confirm & Pay')
  await waitUntil(() => wallet.writeContract.mock.calls.length > 0)
  return (wallet.writeContract.mock.calls[0] as unknown as [{ address: Address; args: readonly unknown[] }])[0]
}

describe('a form that changes while its payment is prepared', () => {
  const blockers: [string, () => void][] = [
    ['payments pause', () => { m.queries.paySurface = surfaceWith({ pausePay: true }) }],
    ['the accepted tokens become unreadable', () => { m.queries.paySurface = { ...surfaceWith({}), isError: true } }],
  ]
  for (const [name, block] of blockers) {
    it(`opens no review once ${name} during a queued preparation`, async () => {
      let release!: (value: unknown) => void
      m.prepareUserPay = vi.fn(async (_client: unknown, args: { amount: bigint }) =>
        args.amount === 10n ** 18n ? new Promise(resolve => { release = resolve }) : PREPARED) as never
      await renderPanel()
      await typeAmount('100')
      await waitUntil(() => button('Pay', false)?.disabled === false)
      await typeAmount('1')
      await click('Pay')
      await waitUntil(() => vi.mocked(m.prepareUserPay).mock.calls.length > 1)
      block()
      await renderPanel()
      await act(async () => release(PREPARED))
      await settle()
      expect(host.querySelector('[data-tx-confirm]')).toBeNull()
      expect(button('Pay').disabled).toBe(true)
      expect(wallet.writeContract).not.toHaveBeenCalled()
    })
  }

  it('prepares again for another terminal entry at the same amount, and pays that one', async () => {
    m.prepareUserPay = vi.fn(async (_client: unknown, args: { terminal: Address }) =>
      args.terminal === TERMINAL_2 ? { ...PREPARED, metadata: OTHER_METADATA, minReturnedTokens: 5n } : PREPARED) as never
    await renderPanel()
    await typeAmount('1')
    await waitUntil(() => button('Pay', false)?.disabled === false)
    m.queries.paySurface = surfaceWith({ contexts: [{ ...contextFor('native'), terminal: TERMINAL_2 }], terminals: [TERMINAL, TERMINAL_2] })
    await renderPanel()
    await waitUntil(() => vi.mocked(m.prepareUserPay).mock.calls.length > 1 && button('Pay', false)?.disabled === false)
    expect([preparedArgs(0).terminal, preparedArgs(1).terminal]).toEqual([TERMINAL, TERMINAL_2])
    const request = await confirmAndSend()
    expect(request.address).toBe(TERMINAL_2)
    expect(request.args[4]).toBe(5n)
    expect(request.args[6]).toBe(OTHER_METADATA)
  })

  it('blocks a cached preparation whose refresh fails, and pays the retried one', async () => {
    await renderPanel()
    await typeAmount('1')
    await waitUntil(() => button('Pay', false)?.disabled === false)
    m.prepareUserPay = vi.fn(async () => { throw new Error('hookOf unreadable') })
    await act(async () => { await prepareQueries.invalidateQueries().catch(() => {}) })
    await waitUntil(() => host.textContent?.includes('Try again') ?? false)
    expect(button('Pay').disabled).toBe(true)
    m.prepareUserPay = vi.fn(async () => ({ ...PREPARED, metadata: OTHER_METADATA, minReturnedTokens: 5n }))
    await click('Try again')
    await waitUntil(() => button('Pay', false)?.disabled === false)
    const request = await confirmAndSend()
    expect(request.args[4]).toBe(5n)
    expect(request.args[6]).toBe(OTHER_METADATA)
  })
})

describe('a reviewed payment whose form changes before the wallet', () => {
  const PAYMENT_CHANGED = 'This payment changed during review. Close it and pay again to review the new one.'
  const changes: [string, () => Promise<void>][] = [
    ['its preparation fails to refresh', async () => {
      m.prepareUserPay = vi.fn(async () => { throw new Error('hookOf unreadable') })
      await act(async () => { await prepareQueries.invalidateQueries().catch(() => {}) })
      await waitUntil(() => host.textContent?.includes('Try again') ?? false)
    }],
    ['its terminal entry changes', async () => {
      m.queries.paySurface = surfaceWith({ contexts: [{ ...contextFor('native'), terminal: TERMINAL_2 }], terminals: [TERMINAL, TERMINAL_2] })
      await renderPanel()
      await waitUntil(() => vi.mocked(m.prepareUserPay).mock.calls.some(call => ((call as unknown[])[1] as { terminal: Address }).terminal === TERMINAL_2))
    }],
    ['its amount is edited', async () => {
      await typeAmount('2')
    }],
  ]
  const waits: [string, () => () => void, () => boolean][] = [
    ['review', () => {
      let answer!: (value: boolean) => void
      wallet.requestReview.mockImplementationOnce(() => new Promise<boolean>(resolve => { answer = resolve }))
      return () => answer(true)
    }, () => wallet.requestReview.mock.calls.length === 1],
    ['simulation', () => {
      let finish!: () => void
      wallet.client.simulateContract.mockImplementationOnce(request => new Promise(resolve => { finish = () => resolve({ request }) }))
      return () => finish()
    }, () => wallet.client.simulateContract.mock.calls.length === 1],
  ]
  it('still sends a preparation older than 30 seconds that nothing changed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    await reviewPayment('1')
    const release = waits[0][1]()
    await click('Confirm & Pay')
    await waitUntil(waits[0][2])
    vi.setSystemTime(Date.now() + 5 * 60_000)
    await renderPanel()
    await act(async () => release())
    await waitUntil(() => wallet.writeContract.mock.calls.length > 0 || !!dialogError())
    expect(dialogError()).toBe('')
    expect(wallet.writes()).toEqual([{ functionName: 'pay', account: ALICE }])
    vi.useRealTimers()
  })

  it('says a wallet cancel with nothing changed is a cancel', async () => {
    await reviewPayment('1')
    wallet.requestReview.mockImplementationOnce(async () => false)
    await click('Confirm & Pay')
    await waitUntil(() => !!dialogError())
    expect(dialogError()).toBe('Payment was cancelled.')
    expect(wallet.writeContract).not.toHaveBeenCalled()
  })

  for (const [wait, hold, held] of waits) {
    for (const [name, change] of changes) {
      it(`sends nothing when ${name} during ${wait}`, async () => {
        await reviewPayment('1')
        const release = hold()
        await click('Confirm & Pay')
        await waitUntil(held)
        expect(held()).toBe(true)
        await change()
        await act(async () => release())
        await waitUntil(() => !!dialogError() || wallet.writeContract.mock.calls.length > 0)
        expect(wallet.writeContract).not.toHaveBeenCalled()
        expect(dialogError()).toBe(PAYMENT_CHANGED)
      })
    }
  }
})

describe('a payment whose receipt watch gives up', () => {
  it("shows the hold's line on the panel, and a second pay sends nothing until the payment settles", async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    wallet.watchGivesUp = true
    await reviewPayment()
    await click('Confirm & Pay')
    await waitUntil(() => host.textContent?.includes('Confirming your transaction.') ?? false)
    // Minutes later the wallet still holds it: the SDK says so, read again as the page regains focus.
    vi.setSystemTime(Date.now() + 3 * 60_000)
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    await waitUntil(() => host.textContent?.includes('Still pending in your wallet. Speed it up or cancel it there.') ?? false)
    expect(wallet.writes()).toEqual([{ functionName: 'pay', account: ALICE }])
    await click('Close review')
    expect(host.textContent).toContain('Still pending in your wallet. Speed it up or cancel it there.')
    await click('Pay')
    await click('Confirm & Pay')
    await waitUntil(() => host.textContent?.includes('Still pending in your wallet.') ?? false)
    expect(wallet.writes()).toEqual([{ functionName: 'pay', account: ALICE }])
    vi.useRealTimers()
  })
})

describe('a held payment whose token the app switched', () => {
  it('refuses the same typed amount in the currency the app fell back to, before the wallet', async () => {
    m.safe = true
    await reviewPayment('7')
    await click('Confirm & Pay')
    await waitUntil(() => [...host.querySelectorAll('button')].some(item => item.textContent === 'Done'))
    await click('Done')
    await loseService()
    const UNPROVEN = "This Safe transaction couldn't be confirmed here. Check your Safe, then send again."
    await waitUntil(() => host.textContent?.includes(UNPROVEN) ?? false)
    await click('Dismiss')
    // The ETH route went away: the panel falls back to USDC (6 decimals) on its own.
    m.token = 'erc20'
    m.queries.payAllowance = { data: 10n ** 30n, refetch: vi.fn(async () => ({ data: 10n ** 30n })) }
    await reviewPayment('7')
    await click('Confirm & Pay')
    await waitUntil(() => wallet.writeContract.mock.calls.length > 1 || (host.textContent?.includes(UNPROVEN) ?? false))
    expect(wallet.writes()).toEqual([{ functionName: 'pay', account: ALICE }])
  })
})

describe('a payment the last release left unresolved', () => {
  it('refuses the same payment under the new project key until its exit', async () => {
    // origin/main held this payment under its own key (token and typed amount), with its own calldata; the reply was lost.
    const { legacyPayKeys } = await import('@/lib/legacy-intents')
    const { writeHolds } = await import('@/lib/write-holds')
    const [oldKey] = legacyPayKeys({ mode: 'pay', chainId: 1, projectId: 42, amount: '1', token: NATIVE, cart: {}, checkoutReady: false, beneficiary: ALICE, memo: '' })
    const old = writeHolds.open({ chainId: 1, account: ALICE, safe: false, namespace: oldKey,
      call: { to: TERMINAL, data: '0x1234', value: 10n ** 18n } })
    await old.send(wallet.client as never, async gate => { await gate.beforeSend(); throw new Error('wallet transport disconnected') }).catch(() => null)
    await reviewPayment('1')
    await click('Confirm & Pay')
    await waitUntil(() => wallet.writeContract.mock.calls.length > 0 || (host.textContent?.includes('I checked my wallet') ?? false))
    expect(wallet.writeContract).not.toHaveBeenCalled()
  })
})

describe('a checkout whose items change at the same total', () => {
  it('prepares again for the new items and pays with their metadata', async () => {
    m.realCart = true
    const tier = (id: number) => ({
      id, price: 10n ** 15n, discountPercent: 0, remaining: 5, initial: 10, unlimited: false,
      cantBuyWithCredits: false, name: `Hat ${id}`, description: null, image: null,
    })
    m.queries.payShop = { data: { tiersComplete: true, hook: USDC, idTarget: USDC, pricingCurrency: 61166, pricingDecimals: 18, tiers: [tier(1), tier(2)] } }
    m.queries.payShopRoutes = { data: { [`${NATIVE.toLowerCase()}:false:${TERMINAL.toLowerCase()}`]: { supported: true, pricePerUnit: 10n ** 18n } }, isLoading: false }
    m.prepareUserPay = vi.fn(async (_client: unknown, args: { tiers?: { tierIdsToMint: bigint[] } }) =>
      args.tiers?.tierIdsToMint[0] === 2n ? { ...PREPARED, metadata: OTHER_METADATA } : PREPARED) as never
    const { ShopCartProvider, useShopCart } = await vi.importActual<typeof import('@/components/project/ShopCartProvider')>('@/components/project/ShopCartProvider')
    let cart!: ReturnType<typeof useShopCart>
    function Probe() {
      cart = useShopCart()
      return null
    }
    await act(async () => root.render(
      <ShopCartProvider>
        <Probe />
        <PayPanel chainId={1} projectId={42} projectName="Project" isRevnet={false} chains={[[1, 42]]} />
      </ShopCartProvider>,
    ))
    const tierCalls = () => vi.mocked(m.prepareUserPay).mock.calls
      .map(call => (call as unknown[])[1] as { amount: bigint; tiers?: { tierIdsToMint: bigint[] } })
      .filter(args => args.tiers && args.amount > 0n)
      .map(args => args.tiers!.tierIdsToMint)
    await act(async () => cart.setQuantity(1, 1))
    await waitUntil(() => tierCalls().length > 0 && button('Pay', false)?.disabled === false)
    await act(async () => { cart.setQuantity(1, 0); cart.setQuantity(2, 1) })
    await waitUntil(() => tierCalls().some(ids => ids[0] === 2n) && button('Pay', false)?.disabled === false)
    expect(tierCalls()[0]).toEqual([1n])
    expect(tierCalls().at(-1)).toEqual([2n])
    const request = await confirmAndSend()
    expect(request.args[2]).toBe(10n ** 15n)
    expect(request.args[6]).toBe(OTHER_METADATA)
  })

  it('prepares again when the shop id target changes for the same items', async () => {
    m.realCart = true
    const tier = { id: 1, price: 10n ** 15n, discountPercent: 0, remaining: 5, initial: 10, unlimited: false,
      cantBuyWithCredits: false, name: 'Hat', description: null, image: null }
    const shopAt = (idTarget: Address) => ({ data: { tiersComplete: true, hook: USDC, idTarget, pricingCurrency: 61166, pricingDecimals: 18, tiers: [tier] } })
    m.queries.payShop = shopAt(USDC)
    m.queries.payShopRoutes = { data: { [`${NATIVE.toLowerCase()}:false:${TERMINAL.toLowerCase()}`]: { supported: true, pricePerUnit: 10n ** 18n } }, isLoading: false }
    m.prepareUserPay = vi.fn(async (_client: unknown, args: { tiers?: { metadataIdTarget: Address } }) =>
      args.tiers?.metadataIdTarget === TERMINAL_2 ? { ...PREPARED, metadata: OTHER_METADATA } : PREPARED) as never
    const { ShopCartProvider, useShopCart } = await vi.importActual<typeof import('@/components/project/ShopCartProvider')>('@/components/project/ShopCartProvider')
    let cart!: ReturnType<typeof useShopCart>
    function Probe() {
      cart = useShopCart()
      return null
    }
    const render = () => act(async () => root.render(
      <ShopCartProvider>
        <Probe />
        <PayPanel chainId={1} projectId={42} projectName="Project" isRevnet={false} chains={[[1, 42]]} />
      </ShopCartProvider>,
    ))
    await render()
    await act(async () => cart.setQuantity(1, 1))
    await waitUntil(() => button('Pay', false)?.disabled === false)
    m.queries.payShop = shopAt(TERMINAL_2)
    await render()
    const targets = () => vi.mocked(m.prepareUserPay).mock.calls
      .map(call => ((call as unknown[])[1] as { tiers?: { metadataIdTarget: Address } }).tiers?.metadataIdTarget)
    await waitUntil(() => targets().includes(TERMINAL_2) && button('Pay', false)?.disabled === false)
    const request = await confirmAndSend()
    expect(request.args[6]).toBe(OTHER_METADATA)
  })
})

describe('a checkout whose items are all gone', () => {
  it('just pays, under the same project key, once the cart is emptied', async () => {
    m.realCart = true
    const tier = (remaining: number) => ({
      id: 1, price: 10n ** 15n, discountPercent: 0, remaining, initial: 10, unlimited: false,
      cantBuyWithCredits: false, name: 'Hat', description: null, image: null,
    })
    const shopWith = (remaining: number) => ({
      data: { tiersComplete: true, hook: USDC, idTarget: USDC, pricingCurrency: 61166, pricingDecimals: 18, tiers: [tier(remaining)] },
    })
    m.queries.payShop = shopWith(5)
    m.queries.payShopRoutes = { data: { [`${NATIVE.toLowerCase()}:false:${TERMINAL.toLowerCase()}`]: { supported: true, pricePerUnit: 10n ** 18n } }, isLoading: false }
    const { ShopCartProvider, useShopCart } = await vi.importActual<typeof import('@/components/project/ShopCartProvider')>('@/components/project/ShopCartProvider')
    let cart!: ReturnType<typeof useShopCart>
    function Probe() {
      cart = useShopCart()
      return null
    }
    const panel = () => (
      <ShopCartProvider>
        <Probe />
        <PayPanel chainId={1} projectId={42} projectName="Project" isRevnet={false} chains={[[1, 42]]} />
      </ShopCartProvider>
    )
    await act(async () => root.render(panel()))
    await act(async () => cart.setQuantity(1, 2))
    // A checkout prepares with its tiers: the hook's id target and one id per item.
    const withTiers = () => vi.mocked(m.prepareUserPay).mock.calls.map(call => (call as unknown[])[1] as { tiers?: unknown }).find(args => args.tiers)
    await waitUntil(() => !!withTiers())
    expect(withTiers()).toMatchObject({ tiers: { metadataIdTarget: USDC, tierIdsToMint: [1n, 1n] } })
    // Every hat sold elsewhere: the cart is pruned, the choice kept. Then the shop stops resolving.
    m.queries.payShop = shopWith(0)
    await act(async () => root.render(panel()))
    m.queries.payShop = { data: null }
    m.queries.payShopRoutes = { data: undefined, isLoading: false }
    await act(async () => root.render(panel()))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 450)) })
    expect(cart.count).toBe(0)
    // Nothing blocks: the amount pays as a plain payment, held by the project's one payment key.
    const pay = [...host.querySelectorAll('button')].find(item => item.textContent === 'Pay')!
    expect(pay.disabled).toBe(false)
  })
})

describe('a payment from a Safe', () => {
  /** Two pay panels for the same project, as when one is open beside another. */
  async function reviewInTwoPanels() {
    await act(async () =>
      root.render(
        <>
          {['first', 'second'].map(name => (
            <div key={name} data-panel={name}>
              <PayPanel chainId={1} projectId={42} projectName="Project" isRevnet={false} chains={[[1, 42]]} />
            </div>
          ))}
        </>,
      ),
    )
    for (const name of ['first', 'second']) {
      const input = panel(name).querySelector<HTMLInputElement>('input[aria-label="Amount"]')!
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '3')
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 450))
    })
    await waitUntil(() => ['first', 'second'].every(name => panelButton(name, 'Pay')?.disabled === false))
  }
  const panel = (name: string) => host.querySelector<HTMLElement>(`[data-panel="${name}"]`)!
  const panelButton = (name: string, label: string) =>
    [...panel(name).querySelectorAll('button')].find(item => item.textContent === label)
  const clickIn = (name: string, label: string) => act(async () => panelButton(name, label)!.click())

  const AWAITING = 'Proposed to your Safe. Its other signers can approve it there.'
  /** The write hold's line for a proposal its follower couldn't prove. */
  const UNPROVEN = "This Safe transaction couldn't be confirmed here. Check your Safe, then send again."
  const EXIT = 'I checked my wallet'
  const panelSays = (line: string) => host.textContent?.includes(line) ?? false

  it("keeps a proposed payment's line on the panel after Done, and once it can't be proven shows the hold's line, where only the exit pays again", async () => {
    m.safe = true
    await reviewPayment('2')
    await click('Confirm & Pay')
    await waitUntil(() => [...host.querySelectorAll('button')].some(item => item.textContent === 'Done'))
    expect(wallet.writes()).toEqual([{ functionName: 'pay', account: ALICE }])
    // The dialog says what the panel will.
    expect(dialogStatus()).toBe(AWAITING)

    await click('Done')
    expect(host.querySelector('[data-tx-confirm]')).toBeNull()
    // The signers decide: the payment stays held, with its line, and nothing to dismiss.
    await waitUntil(() => panelSays(AWAITING))
    expect(panelSays(AWAITING)).toBe(true)
    expect(button('Pay').disabled).toBe(true)
    expect([...host.querySelectorAll('button')].some(item => item.textContent === 'Dismiss')).toBe(false)

    // Safe's service is lost before its execution can be read: the hold's line and its exit.
    await loseService()
    await waitUntil(() => panelSays(UNPROVEN))
    expect(panelSays(UNPROVEN)).toBe(true)
    expect([...host.querySelectorAll('button')].some(item => item.textContent === EXIT)).toBe(true)

    // Dismissing frees the panel, but paying again proposes nothing: only the exit does.
    await click('Dismiss')
    expect(button('Pay').disabled).toBe(false)
    await click('Pay')
    await click('Confirm & Pay')
    await waitUntil(() => panelSays(UNPROVEN))
    expect(wallet.writes()).toEqual([{ functionName: 'pay', account: ALICE }])
    await click(EXIT)
    await waitUntil(() => wallet.writeContract.mock.calls.length > 1)
    expect(wallet.writes()).toEqual([{ functionName: 'pay', account: ALICE }, { functionName: 'pay', account: ALICE }])
  })

  it('frees a panel whose proposed payment another panel dismissed, by its own Dismiss', async () => {
    m.safe = true
    await reviewInTwoPanels()
    await clickIn('first', 'Pay')
    await clickIn('first', 'Confirm & Pay')
    await waitUntil(() => !!panelButton('first', 'Done'))
    await clickIn('first', 'Done')

    // The second panel's same payment is the first's proposal, never a second one.
    await clickIn('second', 'Pay')
    await clickIn('second', 'Confirm & Pay')
    await waitUntil(() => !!panelButton('second', 'Done'))
    expect(wallet.writes()).toEqual([{ functionName: 'pay', account: ALICE }])
    await loseService()
    await waitUntil(() => panel('second').textContent?.includes(UNPROVEN) ?? false)
    // Held with its exit, the review closes as it is.
    await clickIn('second', panelButton('second', 'Done') ? 'Done' : 'Close review')

    // Both panels show the hold's line, and dismissing frees a panel without proposing again.
    await waitUntil(() => !!panelButton('first', 'Dismiss'))
    expect(panel('first').textContent).toContain(UNPROVEN)
    await clickIn('first', 'Dismiss')
    expect(panelButton('first', 'Pay')!.disabled).toBe(false)
    expect(wallet.writes()).toEqual([{ functionName: 'pay', account: ALICE }])
  })

  it("ends an approval whose result can't be proven on Done, freeing the panel, and keeps the call held", async () => {
    m.safe = true
    m.token = 'erc20'
    await reviewPayment()
    await click('Confirm & Pay')
    await waitUntil(() => [...host.querySelectorAll('button')].some(item => item.textContent === 'Done'))
    // Safe's service is lost before the approval's execution can be read.
    await loseService()
    await waitUntil(() => panelSays(UNPROVEN))
    expect(wallet.writes()).toEqual([{ functionName: 'approve', account: ALICE }])

    await click(button('Done', false) ? 'Done' : 'Close review')
    expect(host.querySelector('[data-tx-confirm]')).toBeNull()
    expect(button('Pay').disabled).toBe(false)

    // The write hold still holds the same approval: it is not proposed again.
    await click('Pay')
    await click('Confirm & Pay')
    await waitUntil(() => panelSays(UNPROVEN))
    expect(wallet.writes()).toEqual([{ functionName: 'approve', account: ALICE }])
  })
})


describe('native market payment guard', () => {
  it('shows the payment-form shimmer while protocol identity loads and uses cached success during refresh', async () => {
    m.queries.payNftProtocol = { data: undefined, isSuccess: false, isError: false }
    const panel = <PayPanel chainId={1} projectId={42} projectName="Project" isRevnet={false} chains={[[1, 42]]} />
    await act(async () => root.render(panel))
    expect(host.querySelector('[role="status"]')?.getAttribute('aria-label')).toBe('Loading payment details')
    expect(host.querySelectorAll('.skeleton-shimmer').length).toBeGreaterThan(0)
    expect(host.textContent).not.toContain('NFT protocol')
    expect(host.querySelector('button')).toBeNull()
    expect(wallet.writeContract).not.toHaveBeenCalled()
    m.queries.payNftProtocol = { data: null, isSuccess: true, isError: false, isFetching: true }
    await act(async () => root.render(<PayPanel chainId={1} projectId={42} projectName="Project" isRevnet={false} chains={[[1, 42]]} />))
    expect(host.querySelector('[aria-label="Amount"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="Loading payment details"]')).toBeNull()
    expect(wallet.writeContract).not.toHaveBeenCalled()
  })

  it('allows ordinary payment after verified identity even when cosmetic full-shop reads fail', async () => {
    m.queries.nativeInventory = { data: null, isSuccess: false, isError: true }
    m.queries.payShop = { data: null, isError: true }
    m.queries.payNftProtocol = { data: { protocol: 'jb721' }, isSuccess: true }
    await act(async () => { root.render(<PayPanel chainId={1} projectId={42} projectName="Project" isRevnet={false} chains={[[1, 42]]} />) })
    expect(host.querySelector('input[aria-label="Amount"]')).not.toBeNull()
  })

  it('blocks payment when protocol identity cannot be verified', async () => {
    m.queries.payNftProtocol = { data: null, isSuccess: false, isError: true, refetch: vi.fn() }
    await act(async () => { root.render(<PayPanel chainId={1} projectId={42} projectName="Project" isRevnet={false} chains={[[1, 42]]} />) })
    expect(host.textContent).toContain('Could not verify')
    expect(host.querySelector('input[aria-label="Amount"]')).toBeNull()
  })

  it('uses the same shimmer while a verified native market loads its inventory', async () => {
    m.queries.payNftProtocol = { data: { protocol: 'defifa' }, isSuccess: true }
    m.queries.nativeInventory = { data: undefined, isSuccess: false, isError: false }
    await act(async () => root.render(<PayPanel chainId={1} projectId={42} projectName="Market" isRevnet={false} chains={[[1, 42]]} />))
    expect(host.querySelector('[aria-label="Loading payment details"]')).not.toBeNull()
    expect(host.querySelector('input[aria-label="Amount"]')).toBeNull()
    expect(wallet.writeContract).not.toHaveBeenCalled()
  })

  it('keeps native payment blocked if full inventory fails', async () => {
    m.queries.payNftProtocol = { data: { protocol: 'defifa' }, isSuccess: true }
    m.queries.nativeInventory = { data: null, isSuccess: false, isError: true, refetch: vi.fn() }
    await act(async () => { root.render(<PayPanel chainId={1} projectId={42} projectName="Market" isRevnet={false} chains={[[1, 42]]} />) })
    expect(host.textContent).toContain('Could not read Defifa NFT tiers')
    expect(host.querySelector('input[aria-label="Amount"]')).toBeNull()
  })

  it('refuses a stale generic inventory when identity proves a native market', async () => {
    m.queries.payNftProtocol = { data: { protocol: 'defifa' }, isSuccess: true }
    m.queries.nativeInventory = { data: { protocol: 'jb721' }, isSuccess: true, refetch: vi.fn() }
    await act(async () => { root.render(<PayPanel chainId={1} projectId={42} projectName="Market" isRevnet={false} chains={[[1, 42]]} />) })
    expect(host.textContent).toContain('Could not read Defifa NFT tiers')
    expect(host.querySelector('input[aria-label="Amount"]')).toBeNull()
  })

  it('uses the compact native shop without generic payment controls or a duplicate inventory table', async () => {
    m.realNativeRecovery = true
    m.queries.payNftProtocol = { data: { protocol: 'defifa' }, isSuccess: true }
    m.queries.nativeInventory = { data: {
      protocol: 'defifa', hook: TERMINAL, capabilities: { genericPay: false, genericCashOut: false, manageTiers: false },
      pricing: { currency: 1, decimals: 6, symbol: 'USDC' },
      phase: 4, tiers: [{ id: 1, name: 'Crab', price: 1250000n, discountPercent: 0, remaining: 100, currentSupply: 7n }],
    } }
    await act(async () => {
      root.render(<PayPanel chainId={1} projectId={42} projectName="Market" isRevnet={false} chains={[[1, 42]]} />)
    })
    await waitUntil(() => !!host.querySelector('[title="Add Crab to cart"]'))
    expect(host.querySelector('[title="Add Crab to cart"]')).not.toBeNull()
    expect(host.textContent).toContain('1.25 USDC')
    expect(host.querySelector('a[href^="https://metalog.money"]')).toBeNull()
    expect(host.querySelector('table')).toBeNull()
    expect(host.textContent).toContain('Protocol phase: Complete')
    expect(host.querySelector('input[aria-label="Amount"]')).toBeNull()
    expect(button('Add to balance').disabled).toBe(false)
  })
})


describe('compatible basic funding', () => {
  it.each(['native mint', 'payment approval'])('cancels an unsent %s when funding mode unmounts checkout during simulation', async leg => {
    m.realNativeRecovery = true
    vi.stubGlobal('navigator', { locks: { request: (_key: string, _options: unknown, run: (lock: object) => Promise<unknown>) => run({}) } })
    const token = leg === 'native mint' ? NATIVE : USDC
    m.queries.payNftProtocol = { data: { protocol: 'defifa' }, isSuccess: true }
    m.queries.nativeInventory = { data: {
      protocol: 'defifa', hook: TERMINAL, phase: 1, capabilities: { genericPay: false, genericCashOut: false, manageTiers: false },
      pricing: { token, currency: 1, decimals: 18, symbol: 'ETH' },
      tiers: [{ id: 1, name: 'Home team', price: 100n, remaining: 100, initial: 100, discountPercent: 0 }],
    } }
    m.nativePrepared = {
      inventory: { implementation: TERMINAL, pricing: { token, decimals: 18 } },
      transaction: buildPayTx({ chainId: 1, terminal: TERMINAL, projectId: 42n, token, amount: 100n, beneficiary: ALICE, metadata: buildDefifaPayMetadata({ metadataIdTarget: TERMINAL, tierIdsToMint: [1n] }) }),
      amount: 100n, selectedTiers: [{ tierId: 1n, count: 1n, unitPrice: 100n }], attestationDelegate: zeroAddress,
      effectiveAttestationDelegate: ALICE, effectiveDelegates: [{ tierId: 1n, delegate: ALICE }],
    }
    wallet.client.readContract.mockImplementation(async () => 0n)
    let finish!: () => void
    wallet.client.simulateContract.mockImplementationOnce(request => new Promise(resolve => { finish = () => resolve({ request }) }))
    await act(async () => root.render(<PayPanel chainId={1} projectId={42} projectName="Project" isRevnet={false} chains={[[1, 42]]} />))
    await waitUntil(() => !!host.querySelector('[title="Add Home team to cart"]'))
    await act(async () => host.querySelector<HTMLButtonElement>('[title="Add Home team to cart"]')!.click())
    await click('Review mint'); await click(leg === 'native mint' ? 'Confirm mint' : 'Approve payment')
    await waitUntil(() => wallet.client.simulateContract.mock.calls.length === 1)
    await click('Add to balance')
    expect(host.querySelector('input[aria-label="Amount"]')).not.toBeNull()
    await act(async () => { finish(); await new Promise(resolve => setTimeout(resolve, 20)) })
    expect(wallet.writeContract).not.toHaveBeenCalled()
    expect(readDefifaWriteRecovery({ chainId: 1, projectId: 42, account: ALICE, action: 'pay' })).toBeNull()
    expect(host.querySelector('input[aria-label="Amount"]')).not.toBeNull()
  })

  it('dismisses a nonbusy unknown mint to its saved pending card and makes funding directly usable', async () => {
    m.realNativeRecovery = true
    vi.stubGlobal('navigator', { locks: { request: (_key: string, _options: unknown, run: (lock: object) => Promise<unknown>) => run({}) } })
    m.queries.payNftProtocol = { data: { protocol: 'defifa' }, isSuccess: true }
    m.queries.nativeInventory = { data: {
      protocol: 'defifa', hook: TERMINAL, phase: 1, capabilities: { genericPay: false, genericCashOut: false, manageTiers: false },
      pricing: { token: NATIVE, currency: 1, decimals: 18, symbol: 'ETH' },
      tiers: [{ id: 1, name: 'Home team', price: 100n, currentSupply: 7n, remaining: 100, initial: 100, discountPercent: 0 }],
    } }
    m.nativePrepared = {
      inventory: { implementation: TERMINAL, pricing: { token: NATIVE, decimals: 18 } },
      transaction: buildPayTx({ chainId: 1, terminal: TERMINAL, projectId: 42n, token: NATIVE, amount: 100n, beneficiary: ALICE, metadata: buildDefifaPayMetadata({ metadataIdTarget: TERMINAL, tierIdsToMint: [1n] }) }),
      amount: 100n, selectedTiers: [{ tierId: 1n, count: 1n, unitPrice: 100n }], attestationDelegate: zeroAddress,
      effectiveAttestationDelegate: ALICE, effectiveDelegates: [{ tierId: 1n, delegate: ALICE }],
    }
    await act(async () => root.render(<PayPanel chainId={1} projectId={42} projectName="Project" isRevnet={false} chains={[[1, 42]]} />))
    await waitUntil(() => !!host.querySelector('[title="Add Home team to cart"]'))
    await act(async () => host.querySelector<HTMLButtonElement>('[title="Add Home team to cart"]')!.click())
    await click('Review mint')
    wallet.writeContract.mockRejectedValueOnce(new Error('Wallet connection dropped after invocation'))
    await click('Confirm mint')
    await waitUntil(() => !!host.textContent?.includes('wallet submission is unconfirmed'))
    const scope = { chainId: 1, projectId: 42, account: ALICE, action: 'pay' as const }
    const original = readDefifaWriteRecovery(scope)!
    expect(original.hash).toBeUndefined()
    await click('Close review')
    await waitUntil(() => !!host.textContent?.includes("Your earlier NFT mint hasn't confirmed yet."))
    expect(host.querySelector('[data-tx-confirm]')).toBeNull()
    expect(readDefifaWriteRecovery(scope)?.id).toBe(original.id)
    await click('Add to balance')
    expect(host.querySelector('input[aria-label="Amount"]')).not.toBeNull()
    expect(wallet.writeContract).toHaveBeenCalledOnce()
    expect(readDefifaWriteRecovery(scope)?.id).toBe(original.id)
  })

  it('retains the original unknown native intent through funding mode and payment-panel remount', async () => {
    m.realNativeRecovery = true
    vi.stubGlobal('navigator', { locks: { request: (_key: string, _options: unknown, run: (lock: object) => Promise<unknown>) => run({}) } })
    const scope = { chainId: 1, projectId: 42, account: ALICE, action: 'pay' as const }
    // The approval leg of a native mint, sent under the SDK hold of its namespace; its wallet reply was lost.
    const { writeHolds } = await import('@/lib/write-holds')
    const approval = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [TERMINAL, 7n] })
    await writeHolds.open({ chainId: 1, account: ALICE, safe: false, namespace: defifaWriteNamespace(scope), call: { to: USDC, data: approval, value: 0n } })
      .send(wallet.client as never, async gate => { await gate.beforeSend(); throw new Error('The wallet reply was lost.') }).catch(() => undefined)
    const original = readDefifaWriteRecovery(scope)!
    m.queries.payNftProtocol = { data: { protocol: 'defifa' }, isSuccess: true }
    m.queries.nativeInventory = { data: {
      protocol: 'defifa', hook: TERMINAL, phase: 1, capabilities: { genericPay: false, genericCashOut: false, manageTiers: false },
      pricing: { token: NATIVE, currency: 1, decimals: 18, symbol: 'ETH' },
      tiers: [{ id: 1, name: 'Home team', price: 1n, currentSupply: 7n, remaining: 100, initial: 100, discountPercent: 0 }],
    } }
    const panel = <PayPanel chainId={1} projectId={42} projectName="Project" isRevnet={false} chains={[[1, 42]]} />
    await act(async () => root.render(panel))
    await waitUntil(() => !!host.textContent?.includes("Your earlier NFT mint hasn't confirmed yet. Check your wallet."))
    expect(host.textContent).toContain('I checked my wallet')
    await click('Add to balance')
    expect(host.querySelector('input[aria-label="Amount"]')).not.toBeNull()
    const mode = host.querySelector<HTMLSelectElement>('select[aria-label="Payment mode"]')!
    await act(async () => { mode.value = 'pay'; mode.dispatchEvent(new Event('change', { bubbles: true })) })
    await waitUntil(() => !!host.textContent?.includes("Your earlier NFT mint hasn't confirmed yet."))
    expect(readDefifaWriteRecovery(scope)?.id).toBe(original.id)
    await act(async () => root.unmount())
    root = createRoot(host)
    await act(async () => root.render(panel))
    await waitUntil(() => !!host.textContent?.includes("Your earlier NFT mint hasn't confirmed yet."))
    expect(readDefifaWriteRecovery(scope)?.id).toBe(original.id)
    expect(wallet.writeContract).not.toHaveBeenCalled()
    // The user checked their wallet: the hold ends and the NFT form returns.
    await click('I checked my wallet')
    await waitUntil(() => !host.textContent?.includes("Your earlier NFT mint hasn't confirmed yet."))
    expect(readDefifaWriteRecovery(scope)).toBeNull()
  })

  for (const identity of ['defifa', 'unknown'] as const) {
    it(`adds to balance for ${identity} identity without native pay metadata or a mint preview`, async () => {
      m.queries.payNftProtocol = identity === 'defifa'
        ? { data: { protocol: 'defifa' }, isSuccess: true }
        : { data: null, isSuccess: false, isError: true, refetch: vi.fn() }
      m.queries.nativeInventory = { data: null, isSuccess: false, isError: true, refetch: vi.fn() }
      m.prepareUserPay = vi.fn(async () => { throw new Error('unreadable') })
      m.queries.paySurface = { data: { contexts: [contextFor('native')], rulesetStart: Math.floor(Date.now() / 1000) + 3600, pausePay: true, terminals: [TERMINAL], unknown: [] }, isError: false }
      await act(async () => root.render(<PayPanel chainId={1} projectId={42} projectName="Project" isRevnet={false} chains={[[1, 42]]} />))
      expect(host.querySelector('input[aria-label="Amount"]')).toBeNull()
      await click('Add to balance')
      const input = host.querySelector<HTMLInputElement>('input[aria-label="Amount"]')!
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '1')
        input.dispatchEvent(new Event('input', { bubbles: true }))
        await new Promise(resolve => setTimeout(resolve, 450))
      })
      expect(button('Add').disabled).toBe(false)
      expect(host.textContent).not.toContain('Starts in')
      await click('Add')
      expect(host.querySelector('[data-tx-confirm]')).not.toBeNull()
      await click('Confirm & Add')
      await waitUntil(() => wallet.writeContract.mock.calls.length > 0 || !!dialogError())
      expect(dialogError()).toBe('')
      expect(wallet.writes()).toEqual([{ functionName: 'addToBalanceOf', account: ALICE }])
      const [request] = wallet.writeContract.mock.calls[0] as unknown as [{ args: readonly unknown[] }]
      expect(request.args[0]).toBe(42n)
      expect(request.args.at(-1)).toBe('0x')
    })
  }
})

/** Any line or label the SDK's hold or recovery shows: the normal path shows none of them. */
const HOLD_COPY = [
  HELD_CONFIRMING_LINE, HELD_AWAY_SUCCESS_LINE, HELD_RELEASED_LINE, HELD_RELEASED_ELSEWHERE_LINE, HELD_EXIT_LABEL, HELD_SEND_AGAIN_LABEL,
  SAVED_ATTEMPT_CHECK_LINE, SAVED_ATTEMPT_UNREADABLE_LINE, WRITE_HOLD_PENDING_LINE, WRITE_HOLD_IN_TAB_LINE,
]
const holdCopyShown = () => HOLD_COPY.filter(line => host.textContent?.includes(line))

describe('the normal path, click for click as main', () => {
  it('pays with Pay, then Confirm & Pay: one review, one wallet prompt, its result, and no hold or recovery notice, twice in a row', async () => {
    for (const round of [1, 2]) {
      const clicksBefore = wallet.requestReview.mock.calls.length
      await reviewPayment(String(round))
      await click('Confirm & Pay')
      await waitUntil(() => wallet.writeContract.mock.calls.length === round)
      expect(wallet.requestReview.mock.calls.length - clicksBefore).toBe(1)
      expect(holdCopyShown()).toEqual([])
      await act(async () => wallet.confirm(sentHash(round)))
      await waitUntil(() => !!button('Done', false))
      expect(button('Done', false), 'the confirmed payment ends on Done').toBeDefined()
      expect(holdCopyShown()).toEqual([])
      await click('Done')
    }
    expect(wallet.writes()).toEqual([{ functionName: 'pay', account: ALICE }, { functionName: 'pay', account: ALICE }])
  })
})

/** A revert as viem reports it: the terminal's or the hook's error with its arguments in `data`. */
const shortfall = (selector: '0x6b2bb382' | '0xe2d708a9', received: bigint, minimum: bigint) =>
  Object.assign(new Error('Execution reverted.'), {
    shortMessage: 'Execution reverted.',
    data: `${selector}${encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [received, minimum]).slice(2)}`,
  })
const UNDER_MIN_LINE = 'This payment would get fewer tokens than your minimum, so lower your minimum or try again.'
const allowedDecrease = () => host.querySelector<HTMLInputElement>('[data-tx-confirm] input[type="number"]')

describe('a payment that falls short of its minimum', () => {
  it('says why, offers a looser minimum, and pays the minimum prepared and reviewed with it', async () => {
    // 6.5% short of the minimum prepareUserPay set at its default 1%.
    wallet.client.simulateContract.mockRejectedValueOnce(shortfall('0x6b2bb382', 935n, 1_000n))
    const LOOSER = { ...PREPARED, minReturnedTokens: 6n * 10n ** 20n }
    m.prepareUserPay = vi.fn(async (_client: unknown, args: { slippageBps?: bigint }) =>
      args.slippageBps === undefined ? PREPARED : LOOSER) as never
    await reviewPayment()
    // The default preparation takes the SDK's own tolerance.
    expect('slippageBps' in preparedArgs(0)).toBe(false)
    await click('Confirm & Pay')
    await waitUntil(() => dialogError() === UNDER_MIN_LINE)

    expect(dialogError()).toBe(UNDER_MIN_LINE)
    expect(wallet.writeContract).not.toHaveBeenCalled()
    // 1% plus the 6.5% shortfall, rounded up to a half percent.
    expect(allowedDecrease()?.value).toBe('7.5')
    await click('Review again')
    await waitUntil(() => button('Confirm & Pay', false) !== undefined)

    const calls = vi.mocked(m.prepareUserPay).mock.calls
    expect(preparedArgs(calls.length - 1).slippageBps).toBe(750n)
    // The review shows the minimum it sends.
    expect(host.querySelector('[data-row="You get at least"]')?.textContent).toBe('600 TKN')
    expect(allowedDecrease()).toBeNull()
    await click('Confirm & Pay')
    await waitUntil(() => wallet.writeContract.mock.calls.length > 0)
    const [request] = wallet.writeContract.mock.calls[0] as unknown as [{ args: readonly unknown[] }]
    expect(request.args[4]).toBe(LOOSER.minReturnedTokens)
  })

  it('takes the allowed decrease the payer types, below half', async () => {
    wallet.client.simulateContract.mockRejectedValueOnce(shortfall('0xe2d708a9', 90n, 100n))
    await reviewPayment()
    await click('Confirm & Pay')
    await waitUntil(() => !!allowedDecrease())
    const input = allowedDecrease()!
    const type = (typed: string) => act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, typed)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    // 80%, and 49.999% (which rounds to the 50% limit), are refused; 3% is kept.
    await type('80')
    expect(allowedDecrease()?.value).toBe('11')
    await type('49.999')
    expect(allowedDecrease()?.value).toBe('11')
    await type('3')
    expect(allowedDecrease()?.value).toBe('3')
    await click('Review again')
    await waitUntil(() => button('Confirm & Pay', false) !== undefined)
    const calls = vi.mocked(m.prepareUserPay).mock.calls
    expect(preparedArgs(calls.length - 1).slippageBps).toBe(300n)
  })

  it('uses a loosened tolerance for one review only', async () => {
    wallet.client.simulateContract.mockRejectedValueOnce(shortfall('0x6b2bb382', 935n, 1_000n))
    const LOOSER = { ...PREPARED, minReturnedTokens: 6n * 10n ** 20n }
    m.prepareUserPay = vi.fn(async (_client: unknown, args: { slippageBps?: bigint }) =>
      args.slippageBps === undefined ? PREPARED : LOOSER) as never
    await reviewPayment()
    await click('Confirm & Pay')
    await waitUntil(() => !!allowedDecrease())
    await click('Review again')
    await waitUntil(() => host.querySelector('[data-row="You get at least"]')?.textContent === '600 TKN')
    await click('Close review')
    await click('Pay')
    await waitUntil(() => !!host.querySelector('[data-tx-confirm]'))
    // Closed without paying: the next review is the default one again.
    expect(host.querySelector('[data-row="You get at least"]')?.textContent).toBe('700 TKN')
    await click('Confirm & Pay')
    await waitUntil(() => wallet.writeContract.mock.calls.length > 0)
    const [request] = wallet.writeContract.mock.calls[0] as unknown as [{ args: readonly unknown[] }]
    expect(request.args[4]).toBe(PREPARED.minReturnedTokens)
  })

  it('says an onchain revert reverted, and reviews it again from a fresh quote and simulation', async () => {
    await reviewPayment()
    await click('Confirm & Pay')
    await waitUntil(() => wallet.awaits(sentHash(1)))
    const simulations = wallet.client.simulateContract.mock.calls.length
    await act(async () => wallet.confirm(sentHash(1), 12n, 'reverted'))
    await waitUntil(() => dialogError() === 'The payment reverted.')

    expect(dialogError()).toBe('The payment reverted.')
    // No replay at the receipt's block: its end state is not what the payment reverted on.
    expect(wallet.client.simulateContract.mock.calls.length).toBe(simulations)
    expect(allowedDecrease()).toBeNull()
    await click('Review again')
    await waitUntil(() => button('Confirm & Pay', false) !== undefined)
    expect(dialogError()).toBe('')
    // The hold lets a canonical revert go: the fresh review sends at once, simulated at the latest block.
    await click('Confirm & Pay')
    await waitUntil(() => wallet.writeContract.mock.calls.length > 1)
    expect(wallet.writes()).toEqual([{ functionName: 'pay', account: ALICE }, { functionName: 'pay', account: ALICE }])
    const simulated = wallet.client.simulateContract.mock.calls.at(-1)![0] as { blockNumber?: bigint }
    expect(simulated.blockNumber).toBeUndefined()
  })

  it('shows a reason that a lower minimum cannot fix without the retry', async () => {
    // The hook's TWAP floor: waiting, not a lower minimum, is the fix.
    wallet.client.simulateContract.mockRejectedValueOnce(Object.assign(new Error('Execution reverted.'), {
      shortMessage: 'Execution reverted.',
      data: `0xe490a239${encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [1n, 2n]).slice(2)}`,
    }))
    await reviewPayment()
    await click('Confirm & Pay')
    await waitUntil(() => !!dialogError())
    expect(dialogError()).toBe("The token's price moved too fast to buy safely, so wait a few minutes and try again.")
    expect(allowedDecrease()).toBeNull()
    expect(button('Confirm & Pay')).toBeDefined()
  })

  it('says a payment that would return no tokens, with no looser minimum to try', async () => {
    wallet.client.simulateContract.mockRejectedValueOnce(shortfall('0x6b2bb382', 0n, 100n))
    await reviewPayment()
    await click('Confirm & Pay')
    await waitUntil(() => !!dialogError())
    expect(dialogError()).toBe('This payment would return no tokens.')
    expect(allowedDecrease()).toBeNull()
    expect(button('Confirm & Pay')).toBeDefined()
  })

  it('keeps the old line for a failure it cannot read', async () => {
    wallet.client.simulateContract.mockRejectedValueOnce(new Error('header not found'))
    await reviewPayment()
    await click('Confirm & Pay')
    await waitUntil(() => !!dialogError())
    expect(dialogError()).toBe('Payment was cancelled.')
    expect(allowedDecrease()).toBeNull()
  })
})

describe("a payment whose pool price couldn't be read", () => {
  const FAILED = { ...PREPARED, minReturnedTokens: 5n * 10n ** 20n, quoteFailed: true }
  const panelNotice = () => [...host.querySelectorAll('p')].some(p =>
    !p.closest('[data-tx-confirm]') && p.textContent?.includes(PAY_QUOTE_FAILED_MESSAGE))
  const reviewNotice = () => !!host.querySelector('[data-tx-confirm]')?.textContent?.includes(PAY_QUOTE_FAILED_MESSAGE)

  it('says so in the review it signs, beside the minimum it sends, and stops saying so once sent', async () => {
    m.prepareUserPay = vi.fn(async () => FAILED)
    await enterAmount()
    expect(panelNotice()).toBe(true)
    await click('Pay')

    expect(reviewNotice()).toBe(true)
    expect(panelNotice()).toBe(false)
    expect(host.querySelector('[data-row="You get at least"]')?.textContent).toBe('500 TKN')
    await click('Confirm & Pay')
    await waitUntil(() => wallet.writeContract.mock.calls.length > 0)
    const [request] = wallet.writeContract.mock.calls[0] as unknown as [{ args: readonly unknown[] }]
    expect(request.args[4]).toBe(FAILED.minReturnedTokens)
    expect(reviewNotice()).toBe(false)
    expect(panelNotice()).toBe(false)
  })

  it('says nothing in the review of a payment its pool priced', async () => {
    await reviewPayment()
    expect(reviewNotice()).toBe(false)
  })

  it('shows Refreshing while Try again reads the pool, then the fresh result', async () => {
    let answer!: (value: unknown) => void
    m.prepareUserPay = vi.fn()
      .mockResolvedValueOnce(FAILED)
      .mockReturnValueOnce(new Promise(resolve => { answer = resolve })) as never
    await enterAmount()
    await click('Try again')
    await waitUntil(() => !!host.textContent?.includes('Refreshing…'))

    expect(host.textContent).toContain('Refreshing…')
    expect(panelNotice()).toBe(false)
    expect(button('Try again', false)).toBeUndefined()
    await act(async () => answer(PREPARED))
    await waitUntil(() => !host.textContent?.includes('Refreshing…'))
    expect(panelNotice()).toBe(false)
  })

  it('keeps the notice, not Refreshing, through a refetch the payer did not ask for', async () => {
    let answer!: (value: unknown) => void
    m.prepareUserPay = vi.fn()
      .mockResolvedValueOnce(FAILED)
      .mockReturnValueOnce(new Promise(resolve => { answer = resolve })) as never
    await enterAmount()
    await act(async () => { void prepareQueries.refetchQueries({ queryKey: ['prepareUserPay'] }) })
    await waitUntil(() => vi.mocked(m.prepareUserPay).mock.calls.length === 2)
    // Let the panel render the fetch in flight.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)) })
    expect(prepareQueries.isFetching()).toBe(1)

    expect(panelNotice()).toBe(true)
    expect(host.textContent).not.toContain('Refreshing…')
    await act(async () => answer(FAILED))
    await waitUntil(() => false)
    expect(panelNotice()).toBe(true)
    expect(host.textContent).not.toContain('Refreshing…')
  })

  it("drops the warning as the amount changes, until the new amount's own quote says so", async () => {
    let answer!: (value: unknown) => void
    m.prepareUserPay = vi.fn()
      .mockResolvedValueOnce(FAILED)
      .mockReturnValueOnce(new Promise(resolve => { answer = resolve })) as never
    await enterAmount('1')
    expect(panelNotice()).toBe(true)

    await typeAmount('2')
    // Still debouncing: the warning was the old amount's.
    expect(panelNotice()).toBe(false)
    await waitUntil(() => vi.mocked(m.prepareUserPay).mock.calls.length === 2)
    // Quoting the new amount over the old one's placeholder: no warning, no Refreshing.
    expect(panelNotice()).toBe(false)
    expect(host.textContent).not.toContain('Refreshing…')

    await act(async () => answer(FAILED))
    await waitUntil(panelNotice)
    expect(panelNotice()).toBe(true)
  })

  it('says nothing while the payer buys ETH with dollars', async () => {
    m.onRamp = true
    m.prepareUserPay = vi.fn(async () => FAILED)
    await enterAmount()
    expect(panelNotice()).toBe(true)
    const select = host.querySelector<HTMLSelectElement>('select[aria-label="Payment token"]')!
    await act(async () => {
      select.value = 'buy'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    // The choice sticks for a payer who holds the token too.
    expect(select.value).toBe('buy')
    expect(panelNotice()).toBe(false)
  })

  it('drops the review warning beside an error the review shows', async () => {
    m.prepareUserPay = vi.fn(async () => FAILED)
    await reviewPayment()
    expect(reviewNotice()).toBe(true)
    await act(async () => wallet.connect(BOB))
    await click('Confirm & Pay')
    await waitUntil(() => !!dialogError())

    expect(dialogError()).toBe(CHANGED)
    expect(reviewNotice()).toBe(false)
  })

  it('stays out of the way of an error a fresh price cannot fix', async () => {
    m.prepareUserPay = vi.fn(async () => FAILED)
    m.queries.paySurface = {
      data: { contexts: [contextFor('native')], rulesetStart: 0, pausePay: true, terminals: [TERMINAL], unknown: [] },
      isError: false,
    }
    await act(async () =>
      root.render(<PayPanel chainId={1} projectId={42} projectName="Project" isRevnet={false} chains={[[1, 42]]} />),
    )
    await typeAmount('1')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 450)) })
    await waitUntil(() => vi.mocked(m.prepareUserPay).mock.calls.length > 0)
    await waitUntil(() => false)

    expect(host.textContent).toContain('Payments are paused under the current rules.')
    expect(panelNotice()).toBe(false)
  })
})

describe("paying another chain's deployment", () => {
  const renderGroup = () => act(async () =>
    root.render(<PayPanel chainId={1} projectId={42} projectName="Project" isRevnet={false} chains={[[1, 42], [8453, 7]]} />))
  async function pickBase() {
    const select = host.querySelector<HTMLSelectElement>('select[aria-label="Chain"]')!
    await act(async () => { select.value = '8453'; select.dispatchEvent(new Event('change', { bubbles: true })) })
  }
  const BASE_LINKED = [{ peerChainId: 1, projectId: 42n }, { peerChainId: 8453, projectId: 7n }]

  it('pays the Base project the registry links, with one review and no added step', async () => {
    m.resolveSuckers = vi.fn(async () => BASE_LINKED)
    wallet.switchChain.mockImplementation((async ({ chainId }: { chainId: number }) => { m.walletChain = chainId }) as never)
    await renderGroup(); await pickBase()
    await typeAmount('1'); await settle()
    await waitUntil(() => button('Pay', false)?.disabled === false)
    expect(m.resolveSuckers).toHaveBeenCalledWith(expect.objectContaining({ chainId: 1, projectId: 42n, version: 6 }))
    await click('Pay')
    const reviews = wallet.requestReview.mock.calls.length
    await click('Confirm & Pay')
    await waitUntil(() => wallet.writeContract.mock.calls.length === 1)
    expect(wallet.requestReview.mock.calls.length - reviews).toBe(1)
    const [request] = wallet.writeContract.mock.calls[0] as unknown as [{ functionName: string; args: readonly unknown[] }]
    expect(request.functionName).toBe('pay')
    expect(request.args[0]).toBe(7n)
  })

  it('refuses a Base project the registry does not link, with one line and no write', async () => {
    m.resolveSuckers = vi.fn(async () => [{ peerChainId: 1, projectId: 42n }, { peerChainId: 8453, projectId: 8n }])
    await renderGroup(); await pickBase()
    await typeAmount('1'); await settle()
    await waitUntil(() => !!host.textContent?.includes("The Base project listed here isn't linked onchain."))
    expect(host.textContent).toContain("The Base project listed here isn't linked onchain.")
    expect(button('Pay').disabled).toBe(true)
    await click('Pay')
    expect(host.querySelector('[data-tx-confirm]')).toBeNull()
    expect(wallet.writeContract).not.toHaveBeenCalled()
  })

  it('says it could not confirm Base when the registry read fails', async () => {
    m.resolveSuckers = vi.fn(async () => { throw new Error('rpc down') })
    await renderGroup(); await pickBase()
    await typeAmount('1'); await settle()
    await waitUntil(() => !!host.textContent?.includes("Couldn't confirm Base belongs to this project."))
    expect(host.textContent).toContain("Couldn't confirm Base belongs to this project.")
    expect(button('Pay').disabled).toBe(true)
  })

  it('shows the button loading while the registry read is pending', async () => {
    m.resolveSuckers = () => new Promise(() => {})
    await renderGroup(); await pickBase()
    await typeAmount('1'); await settle()
    expect(button('Checking…').disabled).toBe(true)
    expect(host.querySelector('[role="alert"]')).toBeNull()
  })

  it("pays the page's own deployment without waiting for the registry", async () => {
    m.resolveSuckers = () => new Promise(() => {})
    await renderGroup()
    await typeAmount('1'); await settle()
    await waitUntil(() => button('Pay', false)?.disabled === false)
    expect(button('Pay').disabled).toBe(false)
  })
})
