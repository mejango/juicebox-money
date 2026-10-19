import { NATIVE_TOKEN, USDC_ADDRESSES } from '@bananapus/nana-sdk-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// TEMPORARY: remove with indexedAmountsTrusted once Bendystraw records each event's token.

const USDC = USDC_ADDRESSES[1]!
const ETH_PRICE = 2_000

function project(chainId: number, projectId: number, symbol: string, decimals: number, balance: string) {
  return {
    projectId, chainId, version: 6, name: `Project ${projectId}`, logoUri: null,
    projectTagline: null, volume: balance, volumeUsd: '0', balance, paymentsCount: 1,
    contributorsCount: 1, createdAt: 1, suckerGroupId: `g${projectId}`, token: null,
    tokenSymbol: symbol, decimals, currency: 1, isRevnet: false, owner: null, metadataUri: null,
  }
}

// eth:12 accepts ETH and USDC. Bendystraw labels its 0.0001 ETH as 100,000,000 USDC.
const groups = [
  { id: 'g12', balance: '100000000000000', volume: '100000000000000', projects: { items: [project(1, 12, 'USDC', 6, '100000000000000')] } },
  { id: 'g7', balance: '1000000000000000000', volume: '1000000000000000000', projects: { items: [project(1, 7, 'ETH', 18, '1000000000000000000')] } },
]
const contexts: Record<number, { token: string; decimals: number; currency: number }[]> = {
  12: [
    { token: NATIVE_TOKEN, decimals: 18, currency: 1 },
    { token: USDC, decimals: 6, currency: 2 },
  ],
  7: [{ token: NATIVE_TOKEN, decimals: 18, currency: 1 }],
}
const liveBalances: Record<string, bigint> = {
  [`12:${NATIVE_TOKEN.toLowerCase()}`]: 100_000_000_000_000n,
  [`12:${USDC.toLowerCase()}`]: 0n,
}
let rpcFails = false

vi.mock('next/cache', () => ({ unstable_cache: (fn: unknown) => fn }))
vi.mock('@/lib/eth-price', () => ({ readEthUsdPrice: async () => ETH_PRICE }))
vi.mock('@/lib/project-metadata-fill', () => ({ fillIndexedMetadata: async (items: unknown) => items }))
vi.mock('@/lib/bendystraw', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/bendystraw')>()),
  bendystraw: async () => ({ suckerGroups: { items: groups, totalCount: groups.length } }),
  getAddToBalanceInflows: async () => [],
  getSuckerGroupMoments: async (id: string) => [
    { timestamp: 1, balance: groups.find(group => group.id === id)!.balance, volume: '0' },
  ],
  getProjectMoments: async () => [],
  getRecentActivity: async () => [
    { id: 'pay-12', chainId: 1, projectId: 12 },
    { id: 'pay-7', chainId: 1, projectId: 7 },
  ],
}))
vi.mock('viem', async importOriginal => ({
  ...(await importOriginal<typeof import('viem')>()),
  createPublicClient: () => ({
    multicall: async ({ contracts: calls }: { contracts: { functionName: string; args: readonly unknown[] }[] }) => {
      if (rpcFails) throw new Error('RPC down')
      return calls.map(call =>
        call.functionName === 'accountingContextsOf'
          ? { status: 'success', result: contexts[Number(call.args[0])] }
          : { status: 'success', result: liveBalances[`${call.args[1]}:${String(call.args[2]).toLowerCase()}`] },
      )
    },
  }),
}))

const { getHomepageActivity, getTopBalanceProjects } = await import('@/lib/top-projects')
const { getHomepageReserves } = await import('@/lib/homepage-reserves')

beforeEach(() => {
  rpcFails = false
})

describe('homepage indexed-amount trust', () => {
  it('values a multi-context project by its live balance in the Secured total and leaves it out of the chart', async () => {
    const reserves = await getHomepageReserves()
    expect(reserves.eth).toBeCloseTo(1.0001)
    expect(reserves.usdc).toBe(0)
    expect(reserves.totalUsd).toBeCloseTo(1.0001 * ETH_PRICE)
    expect(reserves.points.map(point => point.valueUsd)).toEqual([ETH_PRICE])
    expect(reserves.passedThroughUsd).toBe(ETH_PRICE)
  })

  it('ranks a multi-context project in Top by its live balance', async () => {
    const top = await getTopBalanceProjects()
    expect(top.map(row => [row.key, row.balanceUsd])).toEqual([
      ['g7', ETH_PRICE],
      ['g12', 0.0001 * ETH_PRICE],
    ])
  })

  it('hides Latest amounts for a multi-context project only', async () => {
    const events = await getHomepageActivity(8)
    expect(events.map(event => [event.id, event.hideAmounts ?? false])).toEqual([
      ['pay-12', true],
      ['pay-7', false],
    ])
  })

  it('trusts nothing when the contexts cannot be read', async () => {
    rpcFails = true
    const [top, events] = await Promise.all([getTopBalanceProjects(), getHomepageActivity(8)])
    expect(top).toEqual([])
    expect(events.every(event => event.hideAmounts)).toBe(true)
  })
})
