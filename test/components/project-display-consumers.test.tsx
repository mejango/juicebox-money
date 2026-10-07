// @vitest-environment jsdom
import { JBBuybackHookContracts } from '@bananapus/nana-sdk-core'
import { getAccountingContexts, getAllRulesets, getAmountToAutoIssue } from '@bananapus/nana-sdk-core/v6'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { type Address, type PublicClient } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AutoIssuanceSection } from '@/components/project/AutoIssuanceSection'
import { LoansSection } from '@/components/project/LoansSection'
import { resolveMarket } from '@/components/project/MarketSection'
import { addrOf } from '@/lib/contracts'
import { accountingContextsQuery, allRulesetsQuery, projectTokenQuery, projectDisplayQuery } from '@/lib/project-display-queries'

const mocks = vi.hoisted(() => ({ client: { readContract: vi.fn() } }))
vi.mock('wagmi', () => ({ usePublicClient: () => mocks.client }))
vi.mock('@/hooks/useSafeTx', () => ({ useSafeTx: () => ({}), txPhaseLabel: () => '' }))
vi.mock('@/hooks/useWallet', () => ({ useWallet: () => ({}) }))
vi.mock('@/hooks/useViewedAccount', () => ({ useViewedAccount: () => ({}) }))
vi.mock('@/components/ui/AddressLink', () => ({ AddressLink: ({ address }: { address: string }) => address }))
vi.mock('@/components/project/ProjectTokenBatchFlow', () => ({ AutoIssueAcrossChains: () => null, AutoIssueAllocation: () => null }))
vi.mock('@bananapus/nana-sdk-core/v6', async importOriginal => ({
  ...await importOriginal<typeof import('@bananapus/nana-sdk-core/v6')>(),
  getAccountingContexts: vi.fn(),
  getAllRulesets: vi.fn(),
  getAmountToAutoIssue: vi.fn(),
}))

const client = mocks.client as unknown as PublicClient
const project = { chainId: 1, projectId: 7n } as const
const controller = '0x1111111111111111111111111111111111111111' as Address
const token = '0x2222222222222222222222222222222222222222' as Address
let queryClient: QueryClient
let container: HTMLDivElement
let root: Root

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  mocks.client.readContract.mockImplementation(async ({ functionName }: { functionName: string }) => {
    if (functionName === 'controllerOf') return controller
    if (functionName === 'currentRulesetOf') return [{ id: 1n, weight: 1n }, {
      dataHook: addrOf(JBBuybackHookContracts.JBBuybackHook, 1), baseCurrency: 1,
    }]
    throw new Error(`Unexpected contract read: ${functionName}`)
  })
  vi.mocked(getAccountingContexts).mockResolvedValue([])
  vi.mocked(getAmountToAutoIssue).mockResolvedValue(1n)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  queryClient.clear()
})

describe('shared display consumers', () => {
  it('reuses market accounting observations while omitted display clients still read live', async () => {
    await Promise.all([
      resolveMarket(client, 1, 7, 'ETH', queryClient),
      resolveMarket(client, 1, 7, 'ETH', queryClient),
    ])
    expect(getAccountingContexts).toHaveBeenCalledTimes(1)

    await resolveMarket(client, 1, 7, 'ETH', queryClient)
    expect(getAccountingContexts).toHaveBeenCalledTimes(1)
    await resolveMarket(client, 1, 7, 'ETH')
    expect(getAccountingContexts).toHaveBeenCalledTimes(2)
    expect(mocks.client.readContract).toHaveBeenCalledWith(expect.objectContaining({
      functionName: 'currentRulesetOf', address: controller,
    }))

    vi.mocked(getAccountingContexts).mockRejectedValueOnce(new Error('Fresh context unavailable'))
    await expect(resolveMarket(client, 1, 7, 'ETH')).rejects.toThrow('Fresh context unavailable')
  })

  it('gives verified no-hook markets a nonzero lease without making context failures fresh', async () => {
    mocks.client.readContract.mockImplementation(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'controllerOf') return controller
      if (functionName === 'currentRulesetOf') return [{ id: 1n }, { dataHook: '0x0000000000000000000000000000000000000000' }]
      throw new Error(`Unexpected contract read: ${functionName}`)
    })
    const queryFn = vi.fn(reader => resolveMarket(client, 1, 7, 'ETH', reader))
    const options = projectDisplayQuery(queryClient, { queryKey: ['market', 1, 7], staleTime: 60_000, queryFn })
    const result = await queryClient.fetchQuery(options)
    expect(result.value.status).toBe('none')
    expect(result.expiresAt).toBeGreaterThan(Date.now())
    await queryClient.fetchQuery(options)
    expect(queryFn).toHaveBeenCalledTimes(1)
    expect(getAccountingContexts).not.toHaveBeenCalled()

  })

  it('refreshes an expired market observation without renewing the raw timestamp on a cache hit', async () => {
    const options = accountingContextsQuery(client, project)
    const updatedAt = Date.now() - options.staleTime + 1_000
    queryClient.setQueryData(options.queryKey, [], { updatedAt })
    await resolveMarket(client, 1, 7, 'ETH', queryClient)
    expect(getAccountingContexts).not.toHaveBeenCalled()
    expect(queryClient.getQueryState(options.queryKey)?.dataUpdatedAt).toBe(updatedAt)

    queryClient.setQueryData(options.queryKey, [], { updatedAt: Date.now() - options.staleTime - 1 })
    await resolveMarket(client, 1, 7, 'ETH', queryClient)
    expect(getAccountingContexts).toHaveBeenCalledTimes(1)
  })

  it('uses already loaded rulesets for every allocation row and token/context facts in Loans', async () => {
    const rulesets = [{ ruleset: { id: 11n, start: 1_000 } }, { ruleset: { id: 12n, start: 2_000 } }]
    queryClient.setQueryData(allRulesetsQuery(client, { ...project, size: 50n }).queryKey, rulesets)
    queryClient.setQueryData(projectTokenQuery(client, 1, 7).queryKey, { address: token, symbol: 'TEST' })
    queryClient.setQueryData(accountingContextsQuery(client, project).queryKey, [])
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(
      url.startsWith('/api/auto-issuances') ? {
        stored: [{ stageId: '11', beneficiary: controller, count: '100' }, { stageId: '12', beneficiary: token, count: '200' }],
        issued: [],
      } : { items: [], totalCount: 0 },
    ))))

    await act(async () => root.render(<QueryClientProvider client={queryClient}>
      <AutoIssuanceSection chains={[[1, 7]]} />
      <LoansSection chainId={1} projectId={7} />
    </QueryClientProvider>))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
    expect(container.textContent).toContain('Stage 1')
    expect(container.textContent).toContain('Stage 2')
    expect(container.textContent).toContain('Amount (TEST)')
    expect(getAllRulesets).not.toHaveBeenCalled()
    expect(getAccountingContexts).not.toHaveBeenCalled()
    expect(mocks.client.readContract).not.toHaveBeenCalled()
  })
})
