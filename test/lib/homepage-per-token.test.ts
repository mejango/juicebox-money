// @vitest-environment jsdom
import { createElement, act } from "react"
import { createRoot } from "react-dom/client"
import { NATIVE_TOKEN, USDC_ADDRESSES } from '@bananapus/nana-sdk-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const USDC = USDC_ADDRESSES[1]!.toLowerCase()
const ETH = NATIVE_TOKEN.toLowerCase()
const E18 = 10n ** 18n

function project(projectId: number) {
  return {
    projectId, chainId: 1, version: 6, name: `Project ${projectId}`, logoUri: null,
    projectTagline: null, volume: '0', volumeUsd: '0', balance: '0', paymentsCount: 1,
    contributorsCount: 1, createdAt: 1, suckerGroupId: `g${projectId}`, token: null,
    tokenSymbol: 'USDC', decimals: 6, currency: 1, isRevnet: false, owner: null, metadataUri: null,
  }
}

// eth:12 accepts ETH and USDC: its raw balance adds 0.0001 ETH (1e14 wei) and
// 5 USDC (5e6) as if they were one unit. Only the per-token data is exact.
const groups = [
  { id: 'g7', balanceUsd: String(2_000n * E18), volumeUsd: String(2_000n * E18), projects: { items: [project(7)] } },
  { id: 'g12', balanceUsd: String(5_200_000_000_000_000_000n), volumeUsd: String(5n * E18), projects: { items: [project(12)] } },
]
const balances = [
  { chainId: 1, projectId: 7, token: ETH, tokenSymbol: 'ETH', decimals: 18, balance: String(E18), balanceUsd: String(2_000n * E18) },
  { chainId: 1, projectId: 12, token: ETH, tokenSymbol: 'ETH', decimals: 18, balance: '100000000000000', balanceUsd: String(E18 / 5n) },
  { chainId: 1, projectId: 12, token: USDC, tokenSymbol: null, decimals: 6, balance: '5000000', balanceUsd: String(5n * E18) },
  { chainId: 8453, projectId: 1, token: ETH, tokenSymbol: 'ETH', decimals: 18, balance: '0', balanceUsd: '0' },
]
const tokenMoments = [
  { chainId: 8453, projectId: 1, token: ETH, decimals: 18, balance: String(E18 / 100n), timestamp: 1, tokenUsdRate: String(1_000n * E18) },
  { chainId: 1, projectId: 7, token: ETH, decimals: 18, balance: String(E18), timestamp: 2, tokenUsdRate: String(2_000n * E18) },
  { chainId: 1, projectId: 12, token: USDC, decimals: 6, balance: '5000000', timestamp: 3, tokenUsdRate: String(E18) },
  { chainId: 8453, projectId: 1, token: ETH, decimals: 18, balance: '0', timestamp: 4, tokenUsdRate: String(2_000n * E18) },
  { chainId: 8453, projectId: 1, token: ETH, decimals: 18, balance: String(E18 / 100n), timestamp: 5, tokenUsdRate: String(2_000n * E18) },
]
const volumeMoments = [
  { suckerGroupId: 'g7', timestamp: 2, volumeUsd: String(2_000n * E18) },
  { suckerGroupId: 'g12', timestamp: 3, volumeUsd: String(5n * E18) },
]
const addToBalances = [
  { suckerGroupId: 'g12', timestamp: 3, amount: '1', amountUsd: String(E18) },
  { suckerGroupId: 'g12', timestamp: 9, amount: '1', amountUsd: String(E18) },
]

let volumeHistoryFails = false
let balancesFail = false
let groupsFail = false
let historyFails = false
let inflowsFail = false
let empty = false

vi.mock('next/cache', () => ({ unstable_cache: (fn: unknown) => fn }))
vi.mock('@/lib/project-metadata-fill', () => ({ fillIndexedMetadata: async (items: unknown) => items }))
vi.mock('@/lib/bendystraw', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/bendystraw')>()),
  bendystraw: async () => {
    if (groupsFail) throw new Error('indexer down')
    return { suckerGroups: { items: empty ? [] : groups, totalCount: empty ? 0 : groups.length } }
  },
  getProjectTokenBalances: async () => {
    if (balancesFail) throw new Error('indexer down')
    return empty ? [] : balances
  },
  getProjectTokenBalanceMoments: async () => {
    if (historyFails) throw new Error('indexer down')
    return empty ? [] : tokenMoments
  },
  getGroupVolumeMoments: async () => {
    if (volumeHistoryFails) throw new Error('indexer down')
    return empty ? [] : volumeMoments
  },
  getAddToBalanceInflows: async () => {
    if (inflowsFail) throw new Error('indexer down')
    return empty ? [] : addToBalances
  },
}))

const refresh = vi.hoisted(() => vi.fn())
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))
vi.mock('@/components/ChainIcon', () => ({ ChainIcon: () => null }))
vi.mock('@/components/SecuredReserveChart', () => ({ SecuredReserveChart: () => null }))
import { SecuredReserves } from '@/components/SecuredReserves'
const { getTopBalanceProjects, getHomepageBalanceGroups } = await import('@/lib/top-projects')
const { getHomepageReserves } = await import('@/lib/homepage-reserves')

describe('homepage per-token data', () => {
  beforeEach(() => { volumeHistoryFails = balancesFail = groupsFail = historyFails = inflowsFail = empty = false })
  it('counts a multi-token project in the Secured total, one line per token', async () => {
    const reserves = await getHomepageReserves()
    expect(reserves.totalUsd).toBeCloseTo(2_005.2)
    expect(reserves.chains?.find(chain => chain.chainId === 1)?.tokens).toEqual([
      { symbol: 'ETH', amount: 1.0001 },
      { symbol: 'USDC', amount: 5 },
    ])
    expect(reserves.chains?.find(chain => chain.chainId === 8453)?.tokens).toEqual([])
  })

  it('charts each token at its own rate, split by chain', async () => {
    const reserves = await getHomepageReserves()
    expect(reserves.points?.map(point => point.valueUsd)).toEqual([10, 2_010, 2_015, 2_005, 2_025])
    expect(reserves.points?.at(-1)?.chains).toEqual([
      { chainId: 1, valueUsd: 2_005 },
      { chainId: 42161, valueUsd: 0 },
      { chainId: 8453, valueUsd: 20 },
      { chainId: 10, valueUsd: 0 },
    ])
  })

  it('counts only fee-project balance increases, valued when they arrived', async () => {
    const reserves = await getHomepageReserves()
    expect(reserves.feePoints?.map(point => point.valueUsd)).toEqual([10, 10, 30])
    expect(reserves.feesUsd).toBe(30)
  })

  it('sums USD volume and every addition into the passed-through total', async () => {
    const reserves = await getHomepageReserves()
    expect(reserves.volumePoints?.map(point => point.valueUsd)).toEqual([2_000, 2_005, 2_006, 2_007])
    expect(reserves.passedThroughUsd).toBe(2_007)
  })

  it('keeps the passed-through headline when the volume history fails', async () => {
    volumeHistoryFails = true
    try {
      const reserves = await getHomepageReserves()
      expect(reserves.volumePoints).toBeNull()
      expect(reserves.passedThroughUsd).toBe(2_007)
    } finally {
      volumeHistoryFails = false
    }
  })

  it('keeps both headlines when the per-token balances fail', async () => {
    balancesFail = true
    try {
      const reserves = await getHomepageReserves()
      expect(reserves.totalUsd).toBeCloseTo(2_005.2)
      expect(reserves.passedThroughUsd).toBe(2_007)
      expect(reserves.chains).toBeNull()
    } finally {
      balancesFail = false
    }
  })

  it('keeps a required group failure unavailable without changing legacy fallback', async () => {
    groupsFail = true
    expect(await getHomepageBalanceGroups()).toEqual([])
    await expect(getHomepageBalanceGroups({ strict: true })).rejects.toThrow('indexer down')
    const reserves = await getHomepageReserves()
    expect(reserves.totalUsd).toBeNull()
    expect(reserves.passedThroughUsd).toBeNull()
    expect(reserves.points).toBeNull()
    groupsFail = false
    expect((await getHomepageReserves()).totalUsd).toBeCloseTo(2005.2)
  })

  it('keeps independent headlines when history or inflows fail', async () => {
    historyFails = true
    const history = await getHomepageReserves()
    expect(history.totalUsd).toBeCloseTo(2005.2)
    expect(history.feesUsd).toBeNull()
    expect(history.points).toBeNull()
    historyFails = false
    inflowsFail = true
    const inflows = await getHomepageReserves()
    expect(inflows.totalUsd).toBeCloseTo(2005.2)
    expect(inflows.feesUsd).toBe(30)
    expect(inflows.passedThroughUsd).toBeNull()
    expect(inflows.volumePoints).toBeNull()
  })

  it('preserves valid empty reads as zero', async () => {
    empty = true
    const reserves = await getHomepageReserves()
    expect([reserves.totalUsd, reserves.passedThroughUsd, reserves.feesUsd]).toEqual([0, 0, 0])
    expect([reserves.points, reserves.volumePoints, reserves.feePoints]).toEqual([[], [], []])
  })

  it('ranks Top by the group USD balance', async () => {
    const top = await getTopBalanceProjects()
    expect(top.map(row => [row.key, row.balanceUsd])).toEqual([
      ['g7', 2_000],
      ['g12', 5.2],
    ])
  })
  it("renders failed reads as unavailable, refreshes, and recovers without inventing zero", async () => {
    groupsFail = true
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    try {
      const failed = await getHomepageReserves()
      await act(async () => root.render(createElement(SecuredReserves, { data: failed })))
      expect(host.textContent).toContain('Unavailable')
      expect(host.textContent).not.toContain('$0.00')
      const retry = host.querySelector('button')!
      expect(retry.textContent).toBe('Refresh')
      await act(async () => retry.click())
      expect(refresh).toHaveBeenCalled()
      groupsFail = false
      const recovered = await getHomepageReserves()
      await act(async () => root.render(createElement(SecuredReserves, { data: recovered })))
      expect(host.textContent).toContain('$2,005.20')
      expect(host.textContent).not.toContain('Unavailable')
      empty = true
      const zero = await getHomepageReserves()
      await act(async () => root.render(createElement(SecuredReserves, { data: zero })))
      expect(host.textContent).toContain('$0.00')
      expect(host.textContent).not.toContain('Unavailable')
    } finally {
      await act(async () => root.unmount())
      host.remove()
    }
  })

  it("renders a missing volume input independently from a known secured total", async () => {
    inflowsFail = true
    const data = await getHomepageReserves()
    const host = document.createElement('div')
    const root = createRoot(host)
    try {
      await act(async () => root.render(createElement(SecuredReserves, { data })))
      expect(host.textContent).toContain('$2,005.20')
      const select = host.querySelector('select')!
      await act(async () => {
        select.value = 'passedThrough'
        select.dispatchEvent(new Event('change', { bubbles: true }))
      })
      expect(host.textContent).toContain('Unavailable')
      expect(host.textContent).toContain('Refresh')
    } finally {
      await act(async () => root.unmount())
    }
  })

})
