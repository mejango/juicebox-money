import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { zeroAddress } from 'viem'

const reads = vi.hoisted(() => ({
  contexts: vi.fn(),
  current: vi.fn(),
  all: vi.fn(),
  upcoming: vi.fn(),
  contract: vi.fn(),
}))
vi.mock('@bananapus/nana-sdk-core/v6', async (original) => ({
  ...(await original<typeof import('@bananapus/nana-sdk-core/v6')>()),
  getAccountingContexts: reads.contexts,
  getCurrentRuleset: reads.current,
  getAllRulesets: reads.all,
  getUpcomingRuleset: reads.upcoming,
}))
vi.mock('next/link', () => ({
  default: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}))
vi.mock('wagmi', () => ({
  useConfig: () => ({}),
  usePublicClient: () => ({ readContract: reads.contract }),
  useReadContract: () => ({ data: undefined }),
}))
vi.mock('wagmi/actions', () => ({
  getPublicClient: () => ({ readContract: reads.contract }),
}))
vi.mock('@wagmi/core', () => ({
  getPublicClient: () => ({ readContract: reads.contract }),
}))
vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('@/hooks/useViewedAccount', () => ({
  useViewedAccount: () => ({ address: undefined }),
}))
vi.mock('@/hooks/useProjectTokenSymbol', () => ({
  useProjectTokenSymbol: () => ({ data: { symbol: 'TEST' } }),
}))
vi.mock('@/components/ChainIcon', () => ({
  ChainIcon: ({ chainId }: { chainId: number }) => <span>Chain {chainId}</span>,
}))
vi.mock('@/components/project/DistributionBatchFlow', () => ({
  DistributionBatchFlow: () => <span>Distribution controls</span>,
}))
vi.mock('@/components/project/QueueRulesetFlow', () => ({
  QueueRulesetFlow: () => null,
}))
vi.mock('@/components/project/EditSplitsFlow', () => ({
  EditSplitsFlow: () => null,
}))

import { FundsTab } from '@/components/project/FundsTab'
import { RulesetsTab } from '@/components/project/RulesetsTab'

const context = {
  token: '0x000000000000000000000000000000000000EEEe',
  currency: 1,
  decimals: 18,
}
const current = {
  ruleset: {
    id: 2,
    cycleNumber: 2,
    start: 2,
    duration: 0,
    weight: 1n,
    weightCutPercent: 0,
    approvalHook: zeroAddress,
  },
  metadata: {
    baseCurrency: 1,
    cashOutTaxRate: 0,
    reservedPercent: 0,
    dataHook: zeroAddress,
  },
}
let cache: QueryClient
let renderer: ReactTestRenderer | undefined
const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
const text = () => JSON.stringify(renderer?.toJSON())

beforeEach(() => {
  cache = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  reads.contexts.mockResolvedValue([context])
  reads.current.mockResolvedValue(current)
  reads.all.mockResolvedValue([current])
  reads.upcoming.mockResolvedValue({
    ...current,
    ruleset: { ...current.ruleset, id: 0 },
  })
  reads.contract.mockImplementation(
    async ({ functionName }: { functionName: string }) => {
      if (
        ['payoutLimitsOf', 'surplusAllowancesOf', 'splitsOf'].includes(
          functionName,
        )
      )
        return []
      if (functionName === 'balanceOf') return 10n ** 18n
      if (functionName === 'pricePerUnitOf') return 10n ** 18n
      return 0n
    },
  )
})
afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount())
  renderer = undefined
  cache.clear()
})

describe('project display request dependencies', () => {
  it('renders a ready chain while another chain is still waiting and keeps totals unknown', async () => {
    let finish!: (value: unknown) => void
    const slow = new Promise((resolve) => {
      finish = resolve
    })
    reads.contexts.mockImplementation((_client, args) =>
      args.chainId === 10 ? slow : Promise.resolve([context]),
    )
    await act(async () => {
      renderer = create(
        <QueryClientProvider client={cache}>
          <FundsTab
            chainId={1}
            projectId={1}
            chains={[
              [1, 1],
              [10, 1],
            ]}
          />
        </QueryClientProvider>,
      )
    })
    await flush()
    expect(text()).toContain('1 ETH')
    expect(text()).toContain('Loading…')
    expect(text()).toContain('Verified balance so far')
    expect(text()).toContain('Distribution controls')
    expect(text()).toContain('—')
    // The home contexts used by descriptors and snapshot are fetched once.
    expect(
      reads.contexts.mock.calls.filter(([, args]) => args.chainId === 1),
    ).toHaveLength(1)
    await act(async () => finish([context]))
    await flush()
    expect(text()).not.toContain('Loading…')
    expect(text()).not.toContain('Verified balance so far')
  })

  it('renders the current rules before slow history and keeps the selected rule stable as history arrives', async () => {
    let finish!: (value: unknown) => void
    reads.all.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    reads.upcoming.mockResolvedValue({
      ...current,
      ruleset: { ...current.ruleset, id: 3, cycleNumber: 3, start: 3 },
    })
    await act(async () => {
      renderer = create(
        <QueryClientProvider client={cache}>
          <RulesetsTab chainId={1} projectId={1} chains={[[1, 1]]} />
        </QueryClientProvider>,
      )
    })
    await flush()
    expect(text()).toContain('Current')
    expect(text()).toContain('Loading past and upcoming rules')
    const later = renderer!.root.findByProps({ 'aria-label': 'Later ruleset' })
    await act(async () => later.props.onClick())
    expect(text()).toContain('Upcoming')
    await act(async () =>
      finish([
        {
          ...current,
          ruleset: { ...current.ruleset, id: 1, cycleNumber: 1, start: 1 },
        },
        current,
      ]),
    )
    await flush()
    const heading = renderer!.root.findByType('h2')
    expect(heading.findByType('span').children).toContain('Upcoming')
    expect(text()).not.toContain('Loading past and upcoming rules')
  })
})
