import { QueryClient } from '@tanstack/react-query'
import { readFileSync } from 'node:fs'
import type { PublicClient } from 'viem'
import { describe, expect, it, vi } from 'vitest'
import {
  HISTORY_REFRESH,
  PRICE_REFRESH_MS,
  readPriceReferenceRow,
} from '@/lib/price-references'

const sdk = vi.hoisted(() => ({ current: vi.fn(), contexts: vi.fn() }))
vi.mock('@bananapus/nana-sdk-core/v6', () => ({
  getCurrentRuleset: sdk.current,
  getAccountingContexts: sdk.contexts,
  getUpcomingRuleset: vi.fn(),
  getAllRulesets: vi.fn(),
}))

const TOKEN = '0x00000000000000000000000000000000000000aa'
const CONTROLLER = '0x00000000000000000000000000000000000000cc'

function fakeClient() {
  const readContract = vi.fn(async ({ functionName }: { functionName: string }) =>
    functionName === 'controllerOf' ? CONTROLLER : 'TKN',
  )
  const multicall = vi.fn(async () => [1_000n, 500n])
  return { client: { readContract, multicall } as unknown as PublicClient, readContract, multicall }
}

describe('price reference reads', () => {
  it('refreshes every 30 seconds, the history included', () => {
    expect(PRICE_REFRESH_MS).toBe(30_000)
    expect(HISTORY_REFRESH.refetchInterval).toBe(PRICE_REFRESH_MS)
    for (const file of ['RevnetPriceCard', 'MarketPriceChart']) {
      const source = readFileSync(`src/components/project/${file}.tsx`, 'utf8')
      expect(source).not.toMatch(/const PRICE_REFRESH_MS/)
      expect(source).toContain('priceHistoryRead(suckerGroupId, chainId)')
    }
  })

  it('reads the controller and the token symbol once, and the moving numbers in one call per refresh', async () => {
    sdk.contexts.mockResolvedValue([{ token: TOKEN, decimals: 18, currency: 7 }])
    sdk.current.mockResolvedValue({
      metadata: { baseCurrency: 1, cashOutTaxRate: 1000, scopeCashOutsToLocalBalances: false },
    })
    const cache = new QueryClient()
    const { client, readContract, multicall } = fakeClient()

    const first = await readPriceReferenceRow(client, cache, 1, 5n)
    const second = await readPriceReferenceRow(client, cache, 1, 5n)

    expect(first).toMatchObject({ supply: 1_000n, balance: 500n, contextSymbol: 'TKN', isNative: false })
    expect(second).toEqual(first)
    expect(readContract.mock.calls.map(([call]) => call.functionName).sort()).toEqual(['controllerOf', 'symbol'])
    expect(multicall).toHaveBeenCalledTimes(2)
    const batch = multicall.mock.calls[0] as unknown as [{ allowFailure: boolean; contracts: { address: string; functionName: string }[] }]
    expect(batch[0].allowFailure).toBe(false)
    expect(batch[0].contracts.map(call => call.functionName)).toEqual([
      'totalTokenSupplyWithReservedTokensOf',
      'currentSurplusOf',
    ])
    // The accepted token is third party: it is never part of the protocol batch.
    expect(batch[0].contracts.some(call => call.address === TOKEN)).toBe(false)
    expect(batch[0].contracts[0].address).toBe(CONTROLLER)
    cache.clear()
  })

  it('does not cache a failed symbol read as an answer', async () => {
    sdk.contexts.mockResolvedValue([{ token: TOKEN, decimals: 18, currency: 7 }])
    sdk.current.mockResolvedValue({ metadata: {} })
    const cache = new QueryClient()
    const { client, readContract } = fakeClient()
    readContract.mockImplementation(async ({ functionName }) => {
      if (functionName === 'symbol') throw new Error('reverted')
      return CONTROLLER
    })
    await expect(readPriceReferenceRow(client, { fetchQuery: options => cache.fetchQuery({ ...options, retry: false }) } as QueryClient, 1, 5n)).rejects.toThrow('reverted')
    cache.clear()
  })

  it('reads the pool through the Market tab key instead of a second copy', () => {
    const source = readFileSync('src/components/project/RevnetPriceCard.tsx', 'utf8')
    expect(source).not.toContain('resolveMarket')
    expect(source).toMatch(/fetchQuery\(\{\s*\.\.\.marketQuery\(/)
  })
})
