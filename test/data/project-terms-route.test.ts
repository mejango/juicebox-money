import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ current: vi.fn(), upcoming: vi.fn(), read: vi.fn() }))
vi.mock('@bananapus/nana-sdk-core/v6', async original => ({
  ...await original<typeof import('@bananapus/nana-sdk-core/v6')>(),
  getCurrentRuleset: mocks.current,
  getUpcomingRuleset: mocks.upcoming,
}))
vi.mock('viem', async original => ({
  ...await original<typeof import('viem')>(),
  createPublicClient: () => ({ getBlockNumber: async () => 1234n, readContract: mocks.read }),
}))

import { v6Address } from '@bananapus/nana-sdk-core/v6'
import { GET } from '@/app/api/project-terms/route'
import { GET as llms } from '@/app/llms.txt/route'

const HOOK = '0x00000000000000000000000000000000000000aa'
const ruleset = (id: number, overrides: Record<string, unknown> = {}) => ({
  ruleset: { id, cycleNumber: 3, start: 1_800_000_000, duration: 604_800, weight: 6_200n * 10n ** 18n, weightCutPercent: 380_000_000 },
  metadata: {
    baseCurrency: 1, reservedPercent: 6_200, cashOutTaxRate: 1_000, pausePay: false,
    dataHook: HOOK, useDataHookForPay: true, ...overrides,
  },
})
const read = (params = 'chainId=84532&projectId=1') =>
  GET(new Request(`https://juicebox.money/api/project-terms?${params}`))

describe('project terms endpoint', () => {
  beforeEach(() => {
    mocks.current.mockReset().mockResolvedValue(ruleset(7))
    mocks.upcoming.mockReset().mockResolvedValue(ruleset(7))
    mocks.read.mockReset().mockResolvedValue(v6Address('REVOwner', 84532))
  })

  it('states the live rules in the units the Rules tab shows, beside the onchain values', async () => {
    const response = await read()
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('public, s-maxage=30, stale-while-revalidate=86400')
    expect(body).toMatchObject({ chainId: 84532, projectId: 1, blockNumber: '1234', isRevnet: true, upcoming: null })
    expect(body.current).toEqual({
      rulesetId: 7,
      cycleNumber: 3,
      start: { value: '2027-01-15T08:00:00.000Z', raw: 1_800_000_000 },
      duration: { value: '7 days', raw: 604_800 },
      tokensPerUnit: { value: '6,200', raw: '6200000000000000000000' },
      issuanceCutPercent: { value: '38%', raw: 380_000_000 },
      baseCurrency: { value: 'ETH', raw: 1 },
      reservedPercent: { value: '62%', raw: 6_200 },
      cashOutTax: { value: '0.1', raw: 1_000 },
      paymentsPaused: false,
      dataHook: HOOK,
      dataHookUsedForPayments: true,
    })
    expect(Object.keys(body.units)).toEqual(expect.arrayContaining(['tokensPerUnit', 'reservedPercent', 'cashOutTax']))
    // The owner read answers for the same block the response names.
    expect(mocks.read).toHaveBeenCalledWith(expect.objectContaining({ functionName: 'ownerOf', blockNumber: 1234n }))
  })

  it('is the terms source /llms.txt points agents at', async () => {
    const map = await llms().text()
    expect(map).toContain('`GET /api/project-terms?chainId=<id>&projectId=<id>`')
    expect(map).not.toContain('Terms are not in the page HTML or these')
  })

  it('adds a queued ruleset and reports an owner-run project and a missing hook plainly', async () => {
    mocks.upcoming.mockResolvedValue(ruleset(9, {
      baseCurrency: 2, cashOutTaxRate: 0, pausePay: true,
      dataHook: '0x0000000000000000000000000000000000000000', useDataHookForPay: false,
    }))
    mocks.read.mockResolvedValue('0x00000000000000000000000000000000000000bb')
    const body = await (await read()).json()
    expect(body.isRevnet).toBe(false)
    expect(body.upcoming).toMatchObject({
      rulesetId: 9, baseCurrency: { value: 'USD', raw: 2 }, cashOutTax: { value: '0', raw: 0 },
      paymentsPaused: true, dataHook: null,
    })
  })

  it('answers 404 for a project with no rules, 400 for a bad scope and 502 when reads fail, uncached', async () => {
    mocks.current.mockResolvedValue(ruleset(0))
    mocks.upcoming.mockResolvedValue(ruleset(0))
    mocks.read.mockRejectedValue(new Error('ERC721NonexistentToken'))
    const missing = await read('chainId=84532&projectId=999999')
    expect(missing.status).toBe(404)
    expect(missing.headers.get('cache-control')).toBeNull()

    for (const params of ['', 'chainId=84532', 'chainId=84532&projectId=0', 'chainId=5&projectId=1']) {
      expect((await read(params)).status).toBe(400)
    }

    mocks.current.mockRejectedValue(new Error('rpc API_KEY=secret'))
    const failed = await read()
    expect(failed.status).toBe(502)
    expect(failed.headers.get('cache-control')).toBeNull()
    expect(JSON.stringify(await failed.json())).not.toMatch(/API_KEY|secret/)
  })
})
