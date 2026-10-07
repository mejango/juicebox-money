/**
 * Cash out, burn and borrow freeze the holder (and the beneficiary of what
 * comes back) at review, from the connected account. When the wallet switches
 * to another account before the confirm, or between a loan's permission and
 * its borrow, nothing more reaches the wallet: the real useSafeTx and the
 * SDK's reviewed write refuse the send, and the dialog says why.
 */

import { QueryClient } from '@tanstack/react-query'
import { createElement, type ReactNode } from 'react'
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer'
import type { Address } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const displayQueries = new QueryClient()

const ALICE = '0x1111111111111111111111111111111111111111' as Address
const BOB = '0x2222222222222222222222222222222222222222' as Address
const PROJECT_TOKEN = '0x3333333333333333333333333333333333333333' as Address
const RECLAIM_TOKEN = '0x4444444444444444444444444444444444444444' as Address
const TERMINAL = '0x5555555555555555555555555555555555555555' as Address
const CONTROLLER = '0x6666666666666666666666666666666666666666' as Address
const NATIVE = '0x000000000000000000000000000000000000EEEe' as Address
const CHANGED = 'The connected account changed. Review again.'

const m = vi.hoisted(() => ({
  directSell: false,
  prepareCashOut: vi.fn(),
  borrowable: vi.fn(),
  hasPermissions: vi.fn(),
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
    // The holder's balance, the project's controller: both live reads.
    useReadContract: ({ functionName }: { functionName: string }) => ({
      data: functionName === 'controllerOf' ? CONTROLLER : 5n * 10n ** 18n,
      refetch: vi.fn(async () => ({ data: functionName === 'controllerOf' ? CONTROLLER : 5n * 10n ** 18n })),
    }),
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
  isSafeConnection: () => false,
  useSafeConnection: () => false,
}))
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => createElement('a', { href }, children),
}))
vi.mock('@/components/ui/ModalShell', () => ({
  ModalShell: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  ModalDialog: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  ModalCloseButton: (props: Record<string, unknown>) => createElement('button', props),
  useEnclosingModalCard: () => null,
  useHoldEnclosingModal: () => {},
}))
vi.mock('@/components/project/MarketSection', () => ({ resolveMarket: vi.fn() }))
vi.mock('@bananapus/nana-sdk-core/v6', async importOriginal => ({
  ...(await importOriginal<typeof import('@bananapus/nana-sdk-core/v6')>()),
  prepareHookAwareCashOut: m.prepareCashOut,
  getBorrowableAmount: m.borrowable,
  hasPermissions: m.hasPermissions,
}))
vi.mock('@tanstack/react-query', async importOriginal => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useQueryClient: () => displayQueries,
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => {
    switch (queryKey[0]) {
      case 'projectTokenSymbol':
        return { data: { address: PROJECT_TOKEN, symbol: 'JBT' }, isFetching: false, isError: false }
      case 'cashOutContext':
        return { data: { token: RECLAIM_TOKEN, decimals: 6, currency: 2 } }
      case 'cashOutTerminal':
        return { data: { address: TERMINAL, isRouter: false } }
      case 'cashOutQuote':
        return {
          data: {
            route: 'treasury', expectedReturn: 9_750n, minimumReturn: 9_652n, terminalMinimum: 9_652n,
            metadata: '0x', treasuryGross: 10_000n, treasuryProtocolFee: 250n, treasuryNet: 9_750n, buyback: null,
          },
          isFetching: false,
          isError: false,
          refetch: vi.fn(),
        }
      case 'cashOutMarket':
        return {
          data: m.directSell
            ? {
                status: 'pool',
                poolId: `0x${'ab'.repeat(32)}`,
                key: { currency0: PROJECT_TOKEN, currency1: RECLAIM_TOKEN, fee: 10_000, tickSpacing: 200, hooks: CONTROLLER },
                sqrtP: 1n << 96n,
              }
            : { status: 'none' },
        }
      case 'claimedCashOutBalance':
        return { data: m.directSell ? 5n * 10n ** 18n : 0n }
      case 'directCashOutSell':
        return { data: m.directSell ? 30_000n : undefined, isFetching: false }
      case 'cashOutTokenAllowance':
        return { data: 0n, refetch: vi.fn() }
      case 'cashOutPermit2Allowance':
        return { data: [0n, 0n, 0n], refetch: vi.fn() }
      case 'accountingContexts':
        return { data: [{ token: NATIVE, decimals: 18, currency: 61166 }], isLoading: false }
      case 'cashOutDelay':
        return { data: 0n }
      case 'borrowable':
        return { data: { borrowableNow: 10n ** 18n }, isFetching: false }
      default:
        return { data: undefined, isFetching: false, isError: false }
    }
  },
}))

import { sentHash, wallet } from '../support/fake-wallet'
import { BurnTokensFlow } from '@/components/project/BurnTokensFlow'
import { CashOutPanel } from '@/components/project/CashOutFlow'
import { GetLoanFlow } from '@/components/project/GetLoanFlow'

function text(instance: ReactTestInstance): string {
  return instance.children
    .map(child => (typeof child === 'string' ? child : typeof child === 'number' ? String(child) : text(child)))
    .join('')
}

async function click(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const button = renderer.root.findAllByType('button').find(item => text(item).includes(label))
  expect(button, label).toBeDefined()
  await act(async () => button!.props.onClick())
}

async function type(renderer: TestRenderer.ReactTestRenderer, find: (input: ReactTestInstance) => boolean, value: string) {
  const input = renderer.root.findAllByType('input').find(find)!
  await act(async () => input.props.onChange({ target: { value } }))
}

const rendered: TestRenderer.ReactTestRenderer[] = []

async function render(element: ReturnType<typeof createElement>) {
  let renderer!: TestRenderer.ReactTestRenderer
  await act(async () => {
    renderer = TestRenderer.create(element)
  })
  rendered.push(renderer)
  return renderer
}

/** Let the effects and async sends a confirmation starts run out. */
async function settle() {
  for (let attempt = 0; attempt < 5; attempt++) {
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0))
    })
  }
}

afterEach(async () => {
  for (const renderer of rendered.splice(0)) await act(async () => renderer.unmount())
})

/** The wallet switches to `account`; every hook reading it re-renders. */
async function switchTo(account: Address) {
  await act(async () => wallet.connect(account))
}

beforeEach(() => {
  wallet.reset()
  wallet.connect(ALICE)
  m.directSell = false
  m.borrowable.mockResolvedValue({ borrowableNow: 10n ** 18n })
  m.hasPermissions.mockResolvedValue(false)
  m.prepareCashOut.mockResolvedValue({
    route: {
      route: 'treasury', expectedReturn: 9_750n, minimumReturn: 9_652n, terminalMinimum: 9_652n,
      metadata: '0x', treasuryGross: 10_000n, treasuryProtocolFee: 250n, treasuryNet: 9_750n, buyback: null,
    },
    transaction: {
      chainId: 1,
      address: TERMINAL,
      abi: [
        {
          type: 'function', name: 'cashOutTokensOf', stateMutability: 'nonpayable',
          inputs: [
            { name: 'holder', type: 'address' }, { name: 'projectId', type: 'uint256' },
            { name: 'cashOutCount', type: 'uint256' }, { name: 'tokenToReclaim', type: 'address' },
            { name: 'minTokensReclaimed', type: 'uint256' }, { name: 'beneficiary', type: 'address' },
            { name: 'metadata', type: 'bytes' },
          ],
          outputs: [{ name: 'reclaimAmount', type: 'uint256' }],
        },
      ],
      functionName: 'cashOutTokensOf',
      args: [ALICE, 42n, 2n * 10n ** 18n, RECLAIM_TOKEN, 9_652n, ALICE, '0x'],
    },
  })
})

const amountInput = (input: ReactTestInstance) => String(input.props['aria-label']).startsWith('Amount of')

describe('a cash out reviewed for one account', () => {
  it('wallet-action:cash-out-project-tokens never sends from an account switched to before confirming', async () => {
    vi.useFakeTimers()
    const renderer = await render(createElement(CashOutPanel, { chainId: 1, projectId: 42, accountingToken: RECLAIM_TOKEN, accountingTokenSymbol: 'USDC' }))
    await type(renderer, amountInput, '2')
    await act(async () => {
      vi.advanceTimersByTime(400)
    })
    await click(renderer, 'Cash out 2 JBT')
    expect(text(renderer.root)).toContain('Confirm cash out')

    await switchTo(BOB)
    await click(renderer, 'Confirm & cash out')

    expect(wallet.writeContract).not.toHaveBeenCalled()
    expect(wallet.requestReview).not.toHaveBeenCalled()
    expect(text(renderer.root)).toContain(CHANGED)
  })

  it('wallet-action:approve-an-erc-20 never approves a pool sale from an account switched to before confirming', async () => {
    vi.useFakeTimers()
    m.directSell = true
    const renderer = await render(createElement(CashOutPanel, { chainId: 1, projectId: 42, accountingToken: RECLAIM_TOKEN, accountingTokenSymbol: 'USDC' }))
    await type(renderer, amountInput, '2')
    await act(async () => {
      vi.advanceTimersByTime(400)
    })
    await click(renderer, 'Sell 2 JBT on the pool')
    expect(text(renderer.root)).toContain('Confirm pool sale')

    await switchTo(BOB)
    await click(renderer, 'Approve tokens for this sale')

    expect(wallet.writeContract).not.toHaveBeenCalled()
    expect(text(renderer.root)).toContain(CHANGED)
  })

  it('cashes out from the account that reviewed it, to that account', async () => {
    vi.useFakeTimers()
    const renderer = await render(createElement(CashOutPanel, { chainId: 1, projectId: 42, accountingToken: RECLAIM_TOKEN, accountingTokenSymbol: 'USDC' }))
    await type(renderer, amountInput, '2')
    await act(async () => {
      vi.advanceTimersByTime(400)
    })
    await click(renderer, 'Cash out 2 JBT')
    await click(renderer, 'Confirm & cash out')

    expect(wallet.writes()).toEqual([{ functionName: 'cashOutTokensOf', account: ALICE }])
  })
})

describe('a burn reviewed for one account', () => {
  const props = { chainId: 1 as const, projectId: 42, tokenSymbol: 'JBT' }

  it('wallet-action:burn-project-tokens never burns from an account switched to before confirming', async () => {
    const renderer = await render(createElement(BurnTokensFlow, props))
    await type(renderer, input => input.props.inputMode === 'decimal', '1')
    await click(renderer, 'Burn tokens permanently')
    expect(text(renderer.root)).toContain('Confirm burn')

    await switchTo(BOB)
    await click(renderer, 'Confirm & burn')

    expect(wallet.writeContract).not.toHaveBeenCalled()
    expect(wallet.requestReview).not.toHaveBeenCalled()
    expect(text(renderer.root)).toContain(CHANGED)
  })

  it('burns from the account that reviewed it', async () => {
    const renderer = await render(createElement(BurnTokensFlow, props))
    await type(renderer, input => input.props.inputMode === 'decimal', '1')
    await click(renderer, 'Burn tokens permanently')
    await click(renderer, 'Confirm & burn')

    expect(wallet.writes()).toEqual([{ functionName: 'burnTokensOf', account: ALICE }])
  })
})

describe('a loan reviewed for one account', () => {
  const props = { chainId: 1 as const, projectId: 42, collateralSymbol: 'JBT' }
  const collateral = (input: ReactTestInstance) => String(input.props['aria-label']).startsWith('Collateral')

  it('wallet-action:borrow-or-repay never borrows from an account switched to after its permission', async () => {
    const renderer = await render(createElement(GetLoanFlow, props))
    await type(renderer, collateral, '1')
    await click(renderer, 'Open the loan')
    expect(text(renderer.root)).toContain('Confirm loan')
    await click(renderer, 'Confirm loan')
    // Alice's permission for REVLoans to burn her collateral reached her wallet.
    expect(wallet.writes()).toEqual([{ functionName: 'setPermissionsFor', account: ALICE }])

    await switchTo(BOB)
    await act(async () => wallet.confirm(sentHash(1)))
    await settle()

    expect(wallet.writes()).toEqual([{ functionName: 'setPermissionsFor', account: ALICE }])
    expect(text(renderer.root)).toContain(CHANGED)
  })

  it('never asks for the permission from an account switched to before confirming', async () => {
    const renderer = await render(createElement(GetLoanFlow, props))
    await type(renderer, collateral, '1')
    await click(renderer, 'Open the loan')

    await switchTo(BOB)
    await click(renderer, 'Confirm loan')
    await settle()

    expect(wallet.writeContract).not.toHaveBeenCalled()
    expect(text(renderer.root)).toContain(CHANGED)
  })

  it('borrows for the account that reviewed it once its permission lands', async () => {
    const renderer = await render(createElement(GetLoanFlow, props))
    await type(renderer, collateral, '1')
    await click(renderer, 'Open the loan')
    await click(renderer, 'Confirm loan')
    await act(async () => wallet.confirm(sentHash(1)))
    await settle()

    expect(wallet.writes()).toEqual([
      { functionName: 'setPermissionsFor', account: ALICE },
      { functionName: 'borrowFrom', account: ALICE },
    ])
  })
})
