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
import { encodeFunctionData, erc20Abi, zeroAddress, type Address } from 'viem'
import { QueryClient } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFIFA_RECOVERY_QUERY_PREFIX, defifaWriteNamespace, readDefifaWriteRecovery } from '@/lib/defifa-write-recovery'
import { buildDefifaPayMetadata, buildPayTx } from '@bananapus/nana-sdk-core/v6'
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
  /** Drive the real shop cart, not the empty stand-in. */
  realCart: false,
}))

vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('@wagmi/core', async importOriginal => {
  const { wallet } = await import('../support/fake-wallet')
  return {
    ...(await importOriginal<typeof import('@wagmi/core')>()),
    getAccount: () => ({ address: wallet.account, chainId: 1 }),
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
    useQuery: (options: Parameters<typeof actual.useQuery>[0]) => m.realNativeRecovery && options.queryKey[0] === DEFIFA_RECOVERY_QUERY_PREFIX[0]
      ? actual.useQuery(options, displayQueries)
      : query(String(options.queryKey[0] === 'projectDisplay' ? options.queryKey[4] : options.queryKey[0])),
  }
})
vi.mock('@/hooks/useShop721', async original => ({
  ...(await original<typeof import('@/hooks/useShop721')>()),
  useShop721Media: () => ({ data: undefined }),
  useShop721: () => ({ data: null, isSuccess: true, ...m.queries.nativeInventory as object }),
}))
vi.mock('@bananapus/nana-sdk-core/v6', async original => {
  const actual = await original<typeof import('@bananapus/nana-sdk-core/v6')>()
  return { ...actual, getProjectNftInventory: vi.fn(async () => null),
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
vi.mock('@/components/GetFunds', () => ({ useOnRamp: () => ({ supported: false, buy: () => {} }) }))
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
  TxConfirmDialog: ({ open, action, onConfirm, onClose, complete, error, status, notice }: {
    open: boolean
    action: string
    onConfirm: () => void
    onClose: () => void
    complete?: boolean
    error?: ReactNode
    status?: ReactNode
    notice?: ReactNode
  }) =>
    open ? (
      <section data-tx-confirm>
        <p data-status>{status}</p>
        <p data-error>{error}</p>
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

import { sentHash, wallet } from '../support/fake-wallet'
import { PayPanel } from '@/components/project/PayPanel'

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
  m.realCart = false
  displayQueries.clear()
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
  await act(async () =>
    root.render(<PayPanel chainId={1} projectId={42} projectName="Project" isRevnet={false} chains={[[1, 42]]} payDisclosure={payDisclosure} />),
  )
  const input = host.querySelector<HTMLInputElement>('input[aria-label="Amount"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, amount)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  // The panel debounces the amount for 400 ms before it previews and quotes.
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 450))
  })
  if (payDisclosure) expect(host.textContent).not.toContain(payDisclosure)
  await click('Pay')
  expect(host.querySelector('[data-tx-confirm]')).not.toBeNull()
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

  it('pays from the account that reviewed it, as its beneficiary', async () => {
    await reviewPayment()
    await click('Confirm & Pay')
    await waitUntil(() => wallet.writeContract.mock.calls.length > 0)

    expect(wallet.writes()).toEqual([{ functionName: 'pay', account: ALICE }])
    const [request] = wallet.writeContract.mock.calls[0] as unknown as [{ args: readonly unknown[] }]
    expect(request.args[3]).toBe(ALICE)
  })
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

  it("keeps a router authorization proposed to the Safe on the panel after Done, held while the Safe has it", async () => {
    m.safe = true
    m.token = 'erc20'
    // A direct swap from USDC, which Permit2 has not authorized the router to spend.
    const poolKey = { currency0: USDC, currency1: TERMINAL, fee: 3000, tickSpacing: 60, hooks: zeroAddress }
    const quote = {
      kind: 'direct-swap',
      poolKey,
      zeroForOne: true,
      quotedTokenCount: 10n ** 21n,
      minimumTokenCount: 10n ** 21n,
      beneficiaryTokenCount: 10n ** 21n,
      reservedTokenCount: 0n,
      inputRoute: { kind: 'single-v4' },
    }
    m.queries = {
      payMarket: { data: { status: 'pool', poolId: `0x${'12'.repeat(32)}`, key: poolKey, pairIsC0: true } },
      directPaySwapQuote: {
        data: quote, isFetching: false, isError: false, isPlaceholderData: false, isStale: false,
        refetch: vi.fn(async () => ({ data: quote })),
      },
      payAllowance: { data: 10n ** 30n, refetch: vi.fn(async () => ({ data: 10n ** 30n })) },
      payPermit2Allowance: { data: [0n, 0, 0], isFetched: true, refetch: vi.fn(async () => ({ data: [0n, 0, 0] })) },
      payWalletBytecode: { data: '0x1234', isFetched: true, isError: false },
    }
    await reviewPayment('4')
    await click('Confirm & Pay')
    await waitUntil(() => [...host.querySelectorAll('button')].some(item => item.textContent === 'Done'))
    expect(wallet.writes()).toEqual([{ functionName: 'approve', account: ALICE }])
    await click('Done')
    await waitUntil(() => panelSays(AWAITING))
    // The SDK's follower decides how it ends (executed, replaced or unproven); until then it is never proposed again.
    expect(panelSays(AWAITING)).toBe(true)
    expect(button('Pay').disabled).toBe(true)
    expect(wallet.writes()).toEqual([{ functionName: 'approve', account: ALICE }])
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
      m.queries.previewPay = { data: null, isError: true }
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
