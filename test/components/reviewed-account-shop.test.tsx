/**
 * Redeeming shop items freezes the holder at review: its items' token IDs, the
 * holder whose items are burned and the beneficiary of the surplus. The shop
 * hands the modal a frozen item list, so a wallet switch does not close it.
 * When the wallet switches to another account before the confirm, nothing
 * reaches the wallet, and the dialog says why.
 */

import { QueryClient } from '@tanstack/react-query'
import { createElement, type ReactNode } from 'react'
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer'
import type { Address } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const displayQueries = new QueryClient()

const ALICE = '0x1111111111111111111111111111111111111111' as Address
const BOB = '0x2222222222222222222222222222222222222222' as Address
const NATIVE = '0x000000000000000000000000000000000000EEEe' as Address
const HOOK = '0x3333333333333333333333333333333333333333' as Address
const TERMINAL = '0x5555555555555555555555555555555555555555' as Address
const CHANGED = 'The connected account changed. Review again.'

vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('@wagmi/core', async importOriginal => {
  const { wallet } = await import('../support/fake-wallet')
  return {
    ...(await importOriginal<typeof import('@wagmi/core')>()),
    getAccount: () => ({ address: wallet.account, chainId: 1 }),
  }
})
vi.mock('wagmi/actions', async importOriginal => {
  const { wallet } = await import('../support/fake-wallet')
  return {
    ...(await importOriginal<typeof import('wagmi/actions')>()),
    getAccount: () => ({ address: wallet.account, chainId: 1 }),
    getPublicClient: () => wallet.client,
  }
})
vi.mock('wagmi', async () => {
  const { walletHooks } = await import('../support/fake-wallet')
  return { ...walletHooks, useConfig: () => ({}) }
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
vi.mock('@/components/ui/ModalShell', () => ({
  ModalShell: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  ModalDialog: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  ModalCloseButton: (props: Record<string, unknown>) => createElement('button', props),
  useEnclosingModalCard: () => null,
  useHoldEnclosingModal: () => {},
}))
vi.mock('@tanstack/react-query', async importOriginal => {
  const { wallet } = await import('../support/fake-wallet')
  /** The fresh quote the modal reads for whichever account is connected. */
  const quote = () => ({
    chainId: 1,
    holder: wallet.account,
    terminal: TERMINAL,
    token: NATIVE,
    decimals: 18,
    symbol: 'ETH',
    gross: 10n ** 18n,
    net: 9n * 10n ** 17n,
    cashOutTaxRate: 0n,
    metadata: '0x',
    tokenIdsKey: '7',
  })
  return {
    ...(await importOriginal<typeof import('@tanstack/react-query')>()),
    useQueryClient: () => displayQueries,
    useQuery: () => ({
      data: quote(),
      isFetching: false,
      error: null,
      refetch: async () => ({ data: quote(), error: null }),
    }),
  }
})

import { wallet } from '../support/fake-wallet'
import { RedeemShopItemsModal } from '@/components/project/RedeemShopItemsModal'

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

const modal = createElement(RedeemShopItemsModal, {
  targets: [{ chainId: 1, projectId: 42, hook: HOOK, idTarget: HOOK, items: [{ tokenId: '7', tierId: 1 }] }],
  names: { 1: 'Banny' },
  onClose: () => {},
})

let renderer: TestRenderer.ReactTestRenderer

beforeEach(async () => {
  wallet.reset()
  wallet.connect(ALICE)
  await act(async () => {
    renderer = TestRenderer.create(modal)
  })
})

afterEach(async () => {
  await act(async () => renderer.unmount())
})

describe('a shop redemption reviewed for one account', () => {
  it('wallet-action:redeem-shop-nfts never redeems from an account switched to before confirming', async () => {
    await click(renderer, 'Redeem 1 item')
    expect(text(renderer.root)).toContain('Confirm redemption')

    await act(async () => wallet.connect(BOB))
    await click(renderer, 'Confirm & redeem')

    expect(wallet.writeContract).not.toHaveBeenCalled()
    expect(wallet.requestReview).not.toHaveBeenCalled()
    expect(text(renderer.root)).toContain(CHANGED)
  })

  it('redeems from the account that reviewed it, to that account', async () => {
    await click(renderer, 'Redeem 1 item')
    await click(renderer, 'Confirm & redeem')

    expect(wallet.writes()).toEqual([{ functionName: 'cashOutTokensOf', account: ALICE }])
    const [request] = wallet.writeContract.mock.calls[0] as unknown as [{ args: readonly unknown[] }]
    expect(request.args[0]).toBe(ALICE)
    expect(request.args[5]).toBe(ALICE)
  })
})
