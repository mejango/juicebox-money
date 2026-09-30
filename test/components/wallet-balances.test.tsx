// @vitest-environment jsdom

import { createElement } from 'react'
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  account: '0x1111111111111111111111111111111111111111',
  balance: undefined as { value: bigint } | undefined,
  usdc: undefined as bigint | undefined,
}))

vi.mock('@/hooks/useWallet', () => ({
  useWallet: () => ({
    isConnected: true,
    address: mocks.account,
    connectors: [],
    connectWith: vi.fn(),
    openSignIn: vi.fn(),
    disconnect: vi.fn(),
  }),
}))
vi.mock('next/navigation', () => ({ usePathname: () => '/' }))
vi.mock('next/link', () => ({
  default: ({
    children,
    ...props
  }: {
    children: React.ReactNode
    [key: string]: unknown
  }) => createElement('a', props, children),
}))
// The connected wallet's chain, with no project in view, gives the one-chain balances.
vi.mock('wagmi', () => ({
  useAccount: () => ({ chainId: 1 }),
  useBalance: () => ({ data: mocks.balance }),
  useReadContract: () => ({ data: mocks.usdc }),
}))
vi.mock('@/hooks/useEnsName', () => ({ useEnsName: () => ({ data: null }) }))
vi.mock('@/components/GetFunds', () => ({ GetFunds: () => null }))

import { WalletButton } from '@/components/WalletButton'

beforeEach(() => {
  mocks.balance = undefined
  mocks.usdc = undefined
})

const rowValues = (renderer: TestRenderer.ReactTestRenderer) =>
  renderer.root
    .findAllByType('dd')
    .map((row: ReactTestInstance) => row.children.join(''))

async function menuRows() {
  let renderer!: TestRenderer.ReactTestRenderer
  await act(async () => {
    renderer = TestRenderer.create(createElement(WalletButton))
  })
  const trigger = renderer.root.find(
    (node: ReactTestInstance) =>
      node.type === 'button' && node.props['aria-expanded'] === false,
  )
  await act(async () => trigger.props.onClick())
  return rowValues(renderer)
}

describe('the wallet balances in the account menu', () => {
  it.each([
    ['nothing', '0', 0n],
    ['dust, to its first significant figure', '0.00003', 30_000_000_000_000n],
    [
      'a tiny amount, cut to its first significant figure',
      '0.00001',
      12_300_000_000_000n,
    ],
    ['a single wei', '0.000000000000000001', 1n],
    ['the smallest amount that is not dust', '0.0001', 10n ** 14n],
    ['a whole amount', '1', 10n ** 18n],
    ['more decimals than four, rounded', '1.2346', 1_234_567_890_000_000_000n],
    ['a decimal tie in the fifth place, rounded up', '0.0002', 150_000_000_000_000n],
    [
      'a decimal tie in the fifth place of a larger amount, rounded up',
      '12.3457',
      12_345_650_000_000_000_000n,
    ],
    ['thousands, grouped', '1,234.5', 1_234_500_000_000_000_000_000n],
    ['millions, grouped', '1,000,000', 10n ** 24n],
  ])('reads %s as %s ETH', async (_name, expected, wei) => {
    mocks.balance = { value: wei }

    expect((await menuRows())[0]).toBe(`${expected} ETH`)
  })

  it('reads the same in every locale', async () => {
    const toLocaleString = Number.prototype.toLocaleString
    vi.spyOn(Number.prototype, 'toLocaleString').mockImplementation(function (
      this: number,
      locales?: never,
      options?: never,
    ) {
      return toLocaleString.call(this, locales ?? 'de-DE', options)
    } as never)
    mocks.balance = { value: 1_234_500_000_000_000_000_000n }
    mocks.usdc = 12_500_000n

    expect(await menuRows()).toEqual(['1,234.5 ETH', '12.5 USDC'])
  })

  it('shows a balance that is still loading as loading', async () => {
    expect(await menuRows()).toEqual(['Loading…', 'Loading…'])
  })
})
