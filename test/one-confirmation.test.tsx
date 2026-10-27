// @vitest-environment jsdom

/**
 * One in-app confirmation per user action: the site's own review dialog opens
 * once for the whole action, and every step it covers then reaches the wallet
 * with no other dialog or click. The real useReviewedAction, core's reviewed
 * run and the site's TransactionReviewProvider run here; only the wallet, the
 * RPC and the flows' reads are fakes.
 */

import { act, createElement, type ReactNode } from 'react'
import { QueryClient } from '@tanstack/react-query'
import { zeroAddress, type Address } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const displayQueries = new QueryClient()

const ALICE = '0x1111111111111111111111111111111111111111' as Address
const PROJECT_TOKEN = '0x3333333333333333333333333333333333333333' as Address
const RECLAIM_TOKEN = '0x4444444444444444444444444444444444444444' as Address
const TERMINAL = '0x5555555555555555555555555555555555555555' as Address
const CONTROLLER = '0x6666666666666666666666666666666666666666' as Address
const NATIVE = '0x000000000000000000000000000000000000EEEe' as Address

const m = vi.hoisted(() => ({
  borrowable: vi.fn(),
  hasPermissions: vi.fn(),
}))
/** The app's query defaults (Providers), for the real prepareUserPay query. */
const prepareQueries = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false } } })
const USDC = '0x7777777777777777777777777777777777777777' as Address

vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('@wagmi/core', async importOriginal => {
  const { wallet, walletActions } = await import('./support/fake-wallet')
  return {
    ...(await importOriginal<typeof import('@wagmi/core')>()),
    ...walletActions,
    getAccount: () => ({ address: wallet.account, chainId: 1 }),
  }
})
vi.mock('wagmi', async importOriginal => {
  const { wallet, walletHooks } = await import('./support/fake-wallet')
  return {
    ...(await importOriginal<typeof import('wagmi')>()),
    ...walletHooks,
    useAccount: () => ({ address: wallet.account, chainId: 1 }),
    useReadContract: ({ functionName }: { functionName: string }) => ({
      data: functionName === 'controllerOf' ? CONTROLLER : 5n * 10n ** 18n,
      refetch: vi.fn(async () => ({ data: functionName === 'controllerOf' ? CONTROLLER : 5n * 10n ** 18n })),
    }),
  }
})
vi.mock('@/hooks/useWallet', async () => {
  const { useFakeWallet } = await import('./support/fake-wallet')
  return { useWallet: useFakeWallet }
})
vi.mock('@/lib/safe-connector', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/safe-connector')>()),
  isSafeConnection: () => false,
  useSafeConnection: () => false,
}))
vi.mock('next/image', () => ({ default: (props: Record<string, unknown>) => createElement('img', { ...props, src: 'asset' }) }))
vi.mock('next/link', () => ({ default: ({ href, children }: { href: string; children: ReactNode }) => createElement('a', { href }, children) }))
// No fee-buyback reads: the review's notice stays in its unknown state.
vi.mock('@/lib/fee-buyback-client', () => ({
  feeBuybackContext: () => {
    throw new Error('No fee-buyback reads in this test.')
  },
}))
vi.mock('@/hooks/useViewedAccount', async () => {
  const { wallet } = await import('./support/fake-wallet')
  return {
    useViewedAccount: () => {
      const account = wallet.useAccount()
      return { address: account, connectedAddress: account, isViewAs: false }
    },
  }
})
vi.mock('@/hooks/useShop721', async original => ({
  ...(await original<typeof import('@/hooks/useShop721')>()),
  useShop721Media: () => ({ data: undefined }),
  useShop721: () => ({ data: null, isSuccess: true }),
}))
vi.mock('@bananapus/nana-sdk-core', async original => ({
  ...(await original<typeof import('@bananapus/nana-sdk-core')>()),
  resolveSuckers: async () => [],
}))
vi.mock('@/hooks/useTokenBalance', () => ({ useTokenBalance: () => ({ balance: 10n ** 24n }) }))
vi.mock('@/hooks/useTokenBalances', () => ({
  useTokenBalances: () => ({ balances: new Map([['0x7777777777777777777777777777777777777777', 10n ** 24n]]) }),
}))
vi.mock('@/components/GetFunds', () => ({ useOnRamp: () => ({ supported: false, buy: () => {} }) }))
vi.mock('@/components/project/ShopCartProvider', async original => ({
  ...(await original<typeof import('@/components/project/ShopCartProvider')>()),
  useShopCart: () => ({ quantities: {}, items: {}, count: 0, setQuantity: () => {}, registerItem: () => {}, clear: () => {} }),
}))
vi.mock('@/lib/project-token-batch', () => ({
  readClaimCalls: async () => [1, 2].map(index => ({
    id: `claim-${index}`, chainId: 1, projectId: 42, authority: ALICE, target: CONTROLLER, data: `0x123${index}`,
    label: 'Claim credits',
    context: { kind: 'claim-credits', holder: ALICE, amount: `${BigInt(index) * 10n ** 18n}`, token: PROJECT_TOKEN, symbol: 'JBT', beneficiary: ALICE },
  })),
  reverifyClaimCall: async () => {},
}))
vi.mock('@/providers/preload-para', () => ({ preloadParaHost: () => {} }))
vi.mock('@/components/project/Tabs', () => ({ replaceProjectTabHash: () => {} }))
vi.mock('@/hooks/useCashOutFloor', () => ({ useCashOutFloor: () => ({ data: null }) }))
vi.mock('@/components/project/LiquidityRangePreview', () => ({ LiquidityRangePreview: () => null }))
vi.mock('@/components/project/MarketSection', async importOriginal => ({
  ...(await importOriginal<typeof import('@/components/project/MarketSection')>()),
  resolveMarket: async () => POOL,
}))
vi.mock('@/lib/uniswap-v4', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/uniswap-v4')>()),
  solveRangeFromAmounts: () => ({ minPrice: 0.5, maxPrice: 2 }),
  POSITION_MANAGER_BY_CHAIN: { 1: '0x4444444444444444444444444444444444444444' },
}))
vi.mock('@/lib/lp-mint', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/lp-mint')>()),
  buildMint: () => ({
    unlockData: '0xaa', value: 0n, erc20: [{ currency: PROJECT_TOKEN, max: 10n ** 18n }], tickLower: -200, tickUpper: 200,
    liquidity: 1n, need: { amount0: 0n, amount1: 10n ** 18n }, amount0Max: 0n, amount1Max: 10n ** 18n,
  }),
}))
vi.mock('@bananapus/nana-sdk-core/v6', async importOriginal => ({
  ...(await importOriginal<typeof import('@bananapus/nana-sdk-core/v6')>()),
  getTokenAddress: async () => PROJECT_TOKEN,
  getProjectNftInventory: vi.fn(async () => null),
  prepareUserPay: vi.fn(async () => ({
    metadata: `0x${'ab'.repeat(32)}`,
    preview: { beneficiaryTokenCount: 10n ** 21n, reservedTokenCount: 0n },
    minReturnedTokens: 7n * 10n ** 20n,
  })),
  getBorrowableAmount: m.borrowable,
  hasPermissions: m.hasPermissions,
  // The pool still beats the treasury when the sale is built.
  quoteUniswapV4ExactInputSingle: vi.fn(async () => 30_000n),
}))
vi.mock('@tanstack/react-query', async importOriginal => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>()
  return {
  ...actual,
  useQueryClient: () => displayQueries,
  // The cash-out and loan reads answer here; any other query (the liquidity pool's) runs for real.
  useQuery: (options: Parameters<typeof actual.useQuery>[0]) => {
    const { queryKey } = options
    switch (queryKey[0] === 'projectDisplay' ? queryKey[4] : queryKey[0]) {
      case 'prepareUserPay':
        return actual.useQuery(options, prepareQueries)
      case 'payNftProtocol':
        return { data: null, isSuccess: true, isError: false, refetch: vi.fn() }
      case 'paySurface':
        return {
          data: { contexts: [{ token: USDC, decimals: 6, currency: 909516616, symbol: 'USDC', terminal: TERMINAL, viaRouter: false }], rulesetStart: 0, pausePay: false, terminals: [TERMINAL], unknown: [] },
          isError: false,
        }
      case 'payAllowance':
        return { data: 0n, refetch: vi.fn(async () => ({ data: 0n })) }
      case 'payShopCredits':
        return { data: 0n, isLoading: false }
      case 'projectTokenSymbol':
        return { data: { address: PROJECT_TOKEN, symbol: 'JBT' }, isFetching: false, isError: false }
      case 'cashOutContext':
        return { data: { token: RECLAIM_TOKEN, decimals: 6, currency: 2 } }
      case 'cashOutTerminal':
        return { data: { address: TERMINAL, isRouter: false } }
      case 'cashOutQuote': {
        const data = {
          route: 'treasury', expectedReturn: 9_750n, minimumReturn: 9_652n, terminalMinimum: 9_652n,
          metadata: '0x', treasuryGross: 10_000n, treasuryProtocolFee: 250n, treasuryNet: 9_750n, buyback: null,
        }
        return { data, isFetching: false, isError: false, refetch: vi.fn(async () => ({ data, isError: false })) }
      }
      case 'cashOutMarket':
        return {
          data: {
            status: 'pool',
            poolId: `0x${'ab'.repeat(32)}`,
            key: { currency0: PROJECT_TOKEN, currency1: RECLAIM_TOKEN, fee: 10_000, tickSpacing: 200, hooks: CONTROLLER },
            sqrtP: 1n << 96n,
          },
        }
      case 'claimedCashOutBalance':
        return { data: 5n * 10n ** 18n }
      case 'directCashOutSell':
        return { data: 30_000n, isFetching: false }
      case 'cashOutTokenAllowance':
        return { data: 0n, refetch: vi.fn() }
      case 'cashOutPermit2Allowance':
        return { data: [0n, 0n, 0n], refetch: vi.fn() }
      case 'accountingContexts':
        return { data: [{ token: NATIVE, decimals: 18, currency: 61166 }, { token: USDC, decimals: 6, currency: 909516616 }], isLoading: false }
      case 'loans':
        return {
          data: { items: [{ id: '7', borrowAmount: '5000000', collateral: '1000000000000000000', beneficiary: ALICE, owner: ALICE, createdAt: 1, chainId: 1, prepaidFeePercent: 25, prepaidDuration: 0, sourceFeeAmount: '0', token: USDC }], totalCount: 1 },
          isLoading: false, isError: false, isFetching: false, refetch: vi.fn(),
        }
      case 'cashOutDelay':
        return { data: 0n }
      case 'borrowable':
        return { data: { borrowableNow: 10n ** 18n }, isFetching: false }
      case 'market':
        return actual.useQuery({ ...options, retry: false }, displayQueries)
      default:
        return {
          data: undefined, isFetching: false, isFetched: false, isError: false, isLoading: false,
          isPlaceholderData: false, isStale: false, refetch: vi.fn(async () => ({})),
        }
    }
  },
  }
})

const POOL = {
  status: 'pool' as const,
  hook: zeroAddress,
  pair: { addr: zeroAddress, tokenOrig: zeroAddress, decimals: 18, symbol: 'ETH', isNative: true },
  key: { currency0: zeroAddress, currency1: PROJECT_TOKEN, fee: 10_000, tickSpacing: 200, hooks: zeroAddress },
  sqrtP: 2n ** 96n,
  poolId: `0x${'55'.repeat(32)}` as `0x${string}`,
  pairIsC0: true,
  price: 1,
  issuance: 2,
}

import { sentHash, wallet } from './support/fake-wallet'
import { confirmEveryReview, progressConfirms, renderWithReviews } from './support/review-dialogs'
import { CashOutPanel } from '@/components/project/CashOutFlow'
import { GetLoanFlow } from '@/components/project/GetLoanFlow'
import { AddLiquidityFlow } from '@/components/project/AddLiquidityFlow'
import { PayPanel } from '@/components/project/PayPanel'
import { LoansSection } from '@/components/project/LoansSection'
import { ClaimCreditsAcrossChains } from '@/components/project/ProjectTokenBatchFlow'
import { REVIEW_CLOSED_LINE } from '@/hooks/useReviewedAction'

let page: Awaited<ReturnType<typeof renderWithReviews>> | null = null

beforeEach(() => {
  wallet.reset()
  wallet.connect(ALICE)
  m.borrowable.mockResolvedValue({ borrowableNow: 10n ** 18n })
  m.hasPermissions.mockResolvedValue(false)
  wallet.client.readContract.mockImplementation(async ({ functionName, args }) => {
    if (functionName === 'allowance') return args?.length === 3 ? [0n, 0, 0] : 0n
    if (functionName === 'balanceOf') return 10n ** 30n
    if (functionName === 'loanOf') return { amount: 5_000_000n, collateral: 10n ** 18n, createdAt: 1, prepaidFeePercent: 25, prepaidDuration: 0, sourceToken: USDC }
    if (functionName === 'TERMINAL') return TERMINAL
    if (functionName === 'revnetIdOfLoanWith') return 42n
    if (functionName === 'accountingContextForTokenOf') return { token: USDC, decimals: 6, currency: 909516616 }
    if (functionName === 'symbol') return 'USDC'
    if (functionName === 'determineSourceFeeAmount') return 50_000n
    throw new Error(`Unexpected read ${functionName}`)
  })
})

afterEach(() => {
  page?.unmount()
  page = null
  vi.useRealTimers()
})

/** The chain confirms every write that reached the wallet. */
function mine() {
  for (let n = 1; n <= wallet.writeContract.mock.calls.length; n++) {
    if (wallet.awaits(sentHash(n))) wallet.confirm(sentHash(n))
  }
}

function button(label: string): HTMLButtonElement {
  const found = [...page!.host.querySelectorAll('button')].find(item => item.textContent?.includes(label))
  expect(found, label).toBeDefined()
  return found!
}

async function type(find: (input: HTMLInputElement) => boolean, value: string) {
  const input = [...page!.host.querySelectorAll('input')].find(find)!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** Press the action, answer every review the site opens, and mine every send until `steps` reached the wallet. */
async function act1(label: string, steps: number) {
  await act(async () => button(label).click())
  const dialogs = await confirmEveryReview(() => wallet.writeContract.mock.calls.length >= steps && !wallet.awaits(sentHash(steps)), { each: mine })
  return { dialogs, sent: wallet.walletClient.sendTransaction.mock.calls.length }
}

describe('one confirmation per action', () => {
  it('wallet-action:one-confirmation pay with approval: one review for the approval and the payment', async () => {
    page = await renderWithReviews(createElement(PayPanel, { chainId: 1, projectId: 42, projectName: 'Project', isRevnet: false, chains: [[1, 42]] }))
    await type(input => input.getAttribute('aria-label') === 'Amount', '1')
    // The panel debounces the amount, then the real prepareUserPay query settles.
    for (let attempt = 0; attempt < 40 && ![...page.host.querySelectorAll('button')].some(item => item.textContent === 'Pay' && !item.disabled); attempt++) {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)) })
    }
    const { dialogs, sent } = await act1('Pay', 2)

    expect(dialogs).toBe(1)
    expect(sent).toBe(2)
    expect(wallet.writes()).toEqual([{ functionName: 'approve', account: ALICE }, { functionName: 'pay', account: ALICE }])
    expect(progressConfirms()).toEqual([])
  })

  it('wallet-action:one-confirmation cash-out: one review for the pool approvals and the sale', async () => {
    page = await renderWithReviews(createElement(CashOutPanel, { chainId: 1, projectId: 42, accountingToken: RECLAIM_TOKEN, accountingTokenSymbol: 'USDC' }))
    await type(input => String(input.getAttribute('aria-label')).startsWith('Amount of'), '2')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 450)) })
    const { dialogs, sent } = await act1('Sell 2 JBT on the pool', 3)

    expect(dialogs).toBe(1)
    expect(sent).toBe(3)
    // The token's approval for Permit2, Permit2's for the router, then the sale.
    expect(wallet.writes().map(write => write.functionName).slice(0, 2)).toEqual(['approve', 'approve'])
    expect(progressConfirms()).toEqual([])
  })

  it('wallet-action:one-confirmation loan: one review for the permission and the borrow', async () => {
    page = await renderWithReviews(createElement(GetLoanFlow, { chainId: 1, projectId: 42, collateralSymbol: 'JBT' }))
    await type(input => String(input.getAttribute('aria-label')).startsWith('Collateral'), '1')
    const { dialogs, sent } = await act1('Open the loan', 2)

    expect(dialogs).toBe(1)
    expect(sent).toBe(2)
    expect(wallet.writes()).toEqual([
      { functionName: 'setPermissionsFor', account: ALICE },
      { functionName: 'borrowFrom', account: ALICE },
    ])
    expect(progressConfirms()).toEqual([])
  })

  it('offers the action again at once when its review is closed, and sends it once', async () => {
    page = await renderWithReviews(createElement(GetLoanFlow, { chainId: 1, projectId: 42, collateralSymbol: 'JBT' }))
    await type(input => String(input.getAttribute('aria-label')).startsWith('Collateral'), '1')
    await act(async () => button('Open the loan').click())
    let cancel: HTMLButtonElement | undefined
    for (let attempt = 0; attempt < 300 && !cancel; attempt++) {
      cancel = document.querySelector<HTMLButtonElement>('dialog[open] [aria-label="Cancel transaction review"]') ?? undefined
      await act(async () => { await vi.dynamicImportSettled(); await new Promise(resolve => setTimeout(resolve, 5)) })
    }
    await act(async () => cancel!.click())
    for (let attempt = 0; attempt < 100 && !document.body.textContent?.includes(REVIEW_CLOSED_LINE); attempt++) {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) })
    }
    expect(document.body.textContent).toContain(REVIEW_CLOSED_LINE)
    expect(wallet.writes()).toEqual([])

    const retry = [...document.querySelectorAll<HTMLButtonElement>('[data-tx-confirm] button')].find(item => item.textContent === 'Retry')
    expect(retry).toBeDefined()
    await act(async () => retry!.click())
    const dialogs = await confirmEveryReview(() => wallet.writeContract.mock.calls.length >= 2 && !wallet.awaits(sentHash(2)), { each: mine })
    expect(dialogs).toBe(1)
    expect(wallet.writes().map(write => write.functionName)).toEqual(['setPermissionsFor', 'borrowFrom'])
  })

  it('wallet-action:one-confirmation loan repayment: one review for the approval and the repayment', async () => {
    page = await renderWithReviews(createElement(LoansSection, { chainId: 1, projectId: 42 }))
    for (let attempt = 0; attempt < 40 && ![...page.host.querySelectorAll('button')].some(item => item.textContent === 'Repay'); attempt++) {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) })
    }
    const { dialogs, sent } = await act1('Repay', 2)

    expect(dialogs).toBe(1)
    expect(sent).toBe(2)
    expect(wallet.writes()).toEqual([{ functionName: 'approve', account: ALICE }, { functionName: 'repayLoan', account: ALICE }])
    expect(progressConfirms()).toEqual([])
  })

  it('wallet-action:one-confirmation add liquidity: one review for the approvals and the mint', async () => {
    page = await renderWithReviews(createElement(AddLiquidityFlow, { chainId: 1, projectId: 7, tokenSymbol: 'JBT' }))
    for (let attempt = 0; attempt < 50 && !page.host.querySelector('input[aria-label="JBT amount"]'); attempt++) {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    }
    await type(input => input.getAttribute('aria-label') === 'JBT amount', '1')
    const { dialogs, sent } = await act1('Add liquidity', 3)

    expect(dialogs).toBe(1)
    expect(sent).toBe(3)
    expect(wallet.writes().map(write => write.functionName)).toEqual(['approve', 'approve', 'modifyLiquidities'])
    expect(progressConfirms()).toEqual([])
  })

  it('wallet-action:one-confirmation project batch: one review for every call in the batch', async () => {
    // The batch journal locks across tabs.
    // The authority is a plain account.
    Object.assign(wallet.client, { getCode: vi.fn(async () => undefined) })
    Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: async (_key: string, ...rest: unknown[]) => (rest.at(-1) as (lock: object) => Promise<unknown>)({}) } })
    page = await renderWithReviews(createElement(ClaimCreditsAcrossChains, { home: [1, 42], chains: [[1, 42]], holder: ALICE }))
    await act(async () => button('Claim credits as ERC-20').click())
    await act(async () => button('Review selected chains').click())
    for (let attempt = 0; attempt < 40 && !page.host.querySelector('[data-tx-confirm]'); attempt++) {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) })
    }
    const dialogs = await confirmEveryReview(() => wallet.writeContract.mock.calls.length >= 2 && !wallet.awaits(sentHash(2)), { each: mine })

    expect(dialogs).toBe(1)
    expect(wallet.writeContract).toHaveBeenCalledTimes(2)
    expect(progressConfirms()).toEqual([])
  })
})
