// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ShopTab } from '@/components/project/ShopTab'
import { ShopCartProvider } from '@/components/project/ShopCartProvider'
import { shop721QueryKey, type Shop } from '@/hooks/useShop721'

const mocks = vi.hoisted(() => ({ readShop: vi.fn(), resolveShopMedia: vi.fn() }))
vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('wagmi', async original => ({
  ...await original<typeof import('wagmi')>(),
  usePublicClient: () => ({}),
  useReadContract: () => ({ data: undefined }),
  useReadContracts: () => ({ data: undefined }),
}))
vi.mock('@/hooks/useViewedAccount', () => ({ useViewedAccount: () => ({ address: undefined }) }))
vi.mock('@/lib/sucker-group', async original => ({
  ...await original<typeof import('@/lib/sucker-group')>(),
  useLinkedDeployments: (_home: unknown, deployments: unknown) => ({ deployments, line: null }),
}))
vi.mock('@/lib/shop-read', () => ({ readShop: mocks.readShop, resolveShopMedia: mocks.resolveShopMedia, resolveNativeShopMedia: vi.fn() }))

const shop = {
  protocol: 'jb721', hook: `0x${'1'.repeat(40)}`, cashOutEnabled: false, transfersPaused: null,
  transferPauseByStage: null, configFlags: null, pricing: { currency: 1, decimals: 18, symbol: 'ETH' },
  tiers: [{
    id: 5, price: 10n ** 16n, initial: 50, remaining: 50, category: 1, discountPercent: 0, reserveFrequency: 0,
    votingUnits: 0n, splitPercent: 0, encodedIpfsUri: `0x${'a'.repeat(64)}`, resolvedUri: '',
  }],
} as Shop

let host: HTMLDivElement
let root: Root | undefined
let queries: QueryClient
async function mount() {
  await act(async () => {
    root = createRoot(host)
    root.render(
      <QueryClientProvider client={queries}>
        <ShopCartProvider><ShopTab chainId={1} projectId={4} isRevnet={false} chains={[[1, 4]]} /></ShopCartProvider>
      </QueryClientProvider>,
    )
  })
}
const retry = () => [...host.querySelectorAll('button')].find(button => button.textContent === 'Retry')

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no network in tests')))
  host = document.createElement('div')
  document.body.append(host)
  queries = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } })
  mocks.resolveShopMedia.mockResolvedValue({ media: { 5: { name: 'Work Station' } }, failedTierIds: [] })
})
afterEach(async () => {
  await act(async () => { root?.unmount() })
  host.remove()
  queries.clear()
  vi.unstubAllGlobals()
})

describe('a failed shop read', () => {
  it('offers Retry, and Retry reads again and shows the inventory', async () => {
    mocks.readShop.mockRejectedValue(new Error('fetch failed'))
    await mount()
    await vi.waitFor(() => expect(retry()).toBeTruthy())
    expect(host.textContent).toContain("Couldn't load the shop.")

    mocks.readShop.mockResolvedValue(shop)
    await act(async () => { retry()!.click() })
    await vi.waitFor(() => expect(host.textContent).toContain('Work Station'))
    expect(host.textContent).not.toContain("Couldn't load the shop")
    expect(retry()).toBeUndefined()
  })

  it('keeps the inventory it has when a refresh fails', async () => {
    queries.setQueryData(shop721QueryKey(1, 4, false), shop, { updatedAt: 1 })
    mocks.readShop.mockRejectedValue(new Error('fetch failed'))
    await mount()
    await vi.waitFor(() => expect(retry()).toBeTruthy())
    expect(host.textContent).toContain("Couldn't refresh the shop.")
    expect(host.textContent).toContain('0.01 ETH')
    expect(host.textContent).toContain('50 left')
  })
})
