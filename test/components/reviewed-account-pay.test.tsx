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
import { zeroAddress, type Address } from 'viem'
import { QueryClient } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
vi.mock('@tanstack/react-query', async importOriginal => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
    useQueryClient: () => displayQueries,
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => query(String(queryKey[0] === 'projectDisplay' ? queryKey[4] : queryKey[0])),
}))
vi.mock('@/hooks/useShop721', () => ({
  useShop721: () => ({ data: null, isSuccess: true, ...m.queries.nativeInventory as object }),
}))
vi.mock('@bananapus/nana-sdk-core/v6', async original => ({
  ...await original(), getProjectNftInventory: vi.fn(async () => null),
}))
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
  TxConfirmDialog: ({ open, action, onConfirm, onClose, complete, error, status }: {
    open: boolean
    action: string
    onConfirm: () => void
    onClose: () => void
    complete?: boolean
    error?: ReactNode
    status?: ReactNode
  }) =>
    open ? (
      <section data-tx-confirm>
        <p data-status>{status}</p>
        <p data-error>{error}</p>
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

function button(label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find(item => item.textContent === label)
  expect(found, label).toBeDefined()
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
async function reviewPayment(amount = '1') {
  await act(async () =>
    root.render(<PayPanel chainId={1} projectId={42} projectName="Project" isRevnet={false} chains={[[1, 42]]} />),
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
  await click('Pay')
  expect(host.querySelector('[data-tx-confirm]')).not.toBeNull()
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

  it('pays from the account that reviewed it, as its beneficiary', async () => {
    await reviewPayment()
    await click('Confirm & Pay')
    await waitUntil(() => wallet.writeContract.mock.calls.length > 0)

    expect(wallet.writes()).toEqual([{ functionName: 'pay', account: ALICE }])
    const [request] = wallet.writeContract.mock.calls[0] as unknown as [{ args: readonly unknown[] }]
    expect(request.args[3]).toBe(ALICE)
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
  const REPLACED = 'Safe moved past this proposal without running it. Review it again.'
  const UNCONFIRMED =
    'Safe proposal submitted, but confirmation is unavailable. Check Safe before taking another action.'
  const panelSays = (line: string) => host.textContent?.includes(line) ?? false

  it("keeps a proposed payment's line on the panel after Done, and frees the panel by Dismiss once it can't be proven", async () => {
    m.safe = true
    let lose!: (reason: Error) => void
    m.waitForSafeExecutionHash = () => new Promise((_, reject) => (lose = reject))
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

    // Safe's service is lost before its execution can be read.
    await act(async () => lose(new Error('Safe service unavailable')))
    await waitUntil(() => panelSays('Safe service unavailable'))
    expect(panelSays(`${UNCONFIRMED} Safe service unavailable`)).toBe(true)
    expect(button('Pay').disabled).toBe(true)

    await click('Dismiss')
    expect(panelSays(UNCONFIRMED)).toBe(false)
    expect(button('Pay').disabled).toBe(false)
  })

  it('frees a panel whose proposed payment another panel dismissed, by its own Dismiss', async () => {
    m.safe = true
    let lose!: (reason: Error) => void
    m.waitForSafeExecutionHash = () => new Promise((_, reject) => (lose = reject))
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
    await act(async () => lose(new Error('Safe service unavailable')))
    await waitUntil(() => panel('second').textContent?.includes('Safe service unavailable') ?? false)
    await clickIn('second', 'Done')
    expect(panelButton('second', 'Pay')!.disabled).toBe(false)

    // Released there, the first panel's stage is lost: its line says so, and Dismiss frees it.
    await waitUntil(() => !!panelButton('first', 'Dismiss'))
    expect(panel('first').textContent).toContain(UNCONFIRMED)
    expect(panelButton('first', 'Pay')!.disabled).toBe(true)
    await clickIn('first', 'Dismiss')
    expect(panelButton('first', 'Pay')!.disabled).toBe(false)
  })

  it("shows on the panel why a router authorization proposed to the Safe ended after Done", async () => {
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
    m.waitForSafeExecutionHash = () => new Promise(() => {})
    let end!: (outcome: string) => void
    m.watchSafeProposal = () => new Promise(resolve => (end = resolve))
    await reviewPayment('4')
    await click('Confirm & Pay')
    await waitUntil(() => [...host.querySelectorAll('button')].some(item => item.textContent === 'Done'))
    expect(wallet.writes()).toEqual([{ functionName: 'approve', account: ALICE }])
    await click('Done')
    await waitUntil(() => panelSays(AWAITING))

    // The Safe moved past the authorization without running it.
    await act(async () => end('replaced'))
    await waitUntil(() => panelSays(REPLACED))
    expect(panelSays(REPLACED)).toBe(true)
    expect(button('Pay').disabled).toBe(false)
  })

  it("ends an approval whose result can't be proven on Done, freeing the panel and the call", async () => {
    m.safe = true
    m.token = 'erc20'
    // Safe's service is lost before the approval's execution can be read.
    m.waitForSafeExecutionHash = () => Promise.reject(new Error('Safe service unavailable'))
    await reviewPayment()
    await click('Confirm & Pay')
    await waitUntil(() => dialogStatus()?.includes('Safe service unavailable') ?? false)
    expect(wallet.writes()).toEqual([{ functionName: 'approve', account: ALICE }])
    expect(dialogStatus()).toBe(
      'Safe proposal submitted, but confirmation is unavailable. Check Safe before taking another action. Safe service unavailable',
    )

    await click('Done')
    expect(host.querySelector('[data-tx-confirm]')).toBeNull()
    expect(button('Pay').disabled).toBe(false)

    // Dismissed after its line, the same approval can be proposed again.
    await click('Pay')
    await click('Confirm & Pay')
    await waitUntil(() => wallet.writeContract.mock.calls.length > 1)
    expect(wallet.writes()).toEqual([
      { functionName: 'approve', account: ALICE },
      { functionName: 'approve', account: ALICE },
    ])
  })
})


describe('native market payment guard', () => {
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

  it('keeps native payment blocked if full inventory fails', async () => {
    m.queries.payNftProtocol = { data: { protocol: 'defifa' }, isSuccess: true }
    m.queries.nativeInventory = { data: null, isSuccess: false, isError: true, refetch: vi.fn() }
    await act(async () => { root.render(<PayPanel chainId={1} projectId={42} projectName="Market" isRevnet={false} chains={[[1, 42]]} />) })
    expect(host.textContent).toContain('Could not read market positions')
    expect(host.querySelector('input[aria-label="Amount"]')).toBeNull()
  })

  it('refuses a stale generic inventory when identity proves a native market', async () => {
    m.queries.payNftProtocol = { data: { protocol: 'defifa' }, isSuccess: true }
    m.queries.nativeInventory = { data: { protocol: 'jb721' }, isSuccess: true, refetch: vi.fn() }
    await act(async () => { root.render(<PayPanel chainId={1} projectId={42} projectName="Market" isRevnet={false} chains={[[1, 42]]} />) })
    expect(host.textContent).toContain('Could not read market positions')
    expect(host.querySelector('input[aria-label="Amount"]')).toBeNull()
  })

  it('shows native inventory instead of generic payment or cart controls', async () => {
    m.queries.payNftProtocol = { data: { protocol: 'defifa' }, isSuccess: true }
    m.queries.nativeInventory = { data: {
      protocol: 'defifa', hook: TERMINAL, capabilities: { genericPay: false, genericCashOut: false, manageTiers: false },
      pricing: { currency: 1, decimals: 6, symbol: 'USDC' },
      tiers: [{ id: 1, name: 'Crab', price: 1250000n, currentSupply: 7n }],
    } }
    await act(async () => {
      root.render(<PayPanel chainId={1} projectId={42} projectName="Market" isRevnet={false} chains={[[1, 42]]} />)
    })
    expect(host.textContent).toContain('Crab')
    expect(host.textContent).toContain('1.25 USDC')
    expect(host.querySelector('a')?.getAttribute('href')).toBe('https://metalog.money/markets/1/42')
    expect(host.querySelector('input[aria-label="Amount"]')).toBeNull()
    expect(host.querySelector('button')).toBeNull()
  })
})
