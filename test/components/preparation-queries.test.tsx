import { JBCoreContracts, jbContractAddress, type JBChainId } from '@bananapus/nana-sdk-core'
import { RESERVED_TOKEN_SPLIT_GROUP_ID } from '@bananapus/nana-sdk-core/v6'
import { QueryClient, QueryClientProvider, type FetchQueryOptions } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { zeroAddress, type Address } from 'viem'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  address: '0x1111111111111111111111111111111111111111',
  read: vi.fn(),
  payout: vi.fn(),
  clients: new Map<number, unknown>(),
  failedChains: new Set<number>(),
}))

vi.mock('@/hooks/useWallet', () => ({
  useWallet: () => ({ address: m.address, isConnected: true }),
}))
vi.mock('@/hooks/useEnsName', () => ({ useEnsName: () => ({ data: null }) }))
vi.mock('wagmi', async original => ({
  ...await original<typeof import('wagmi')>(),
  usePublicClient: ({ chainId }: { chainId: number }) => m.clients.get(chainId),
  useReadContract: ({ functionName, chainId }: { functionName: string; chainId: JBChainId }) => ({
    data: functionName === 'ownerOf' ? m.address : jbContractAddress['6'][JBCoreContracts.JBController][chainId],
  }),
}))
vi.mock('@/lib/authority', async original => ({
  ...await original<typeof import('@/lib/authority')>(),
  clientFor: (chainId: number) => m.clients.get(chainId),
}))
vi.mock('@/lib/wallet-core', async original => ({
  ...await original<typeof import('@/lib/wallet-core')>(),
  publicClient: (chainId: number) => m.clients.get(chainId),
}))
vi.mock('@bananapus/nana-sdk-core/safe', async original => ({
  ...await original<typeof import('@bananapus/nana-sdk-core/safe')>(),
  readAuthorityIdentity: async () => ({ kind: 'eoa' }),
}))
vi.mock('@bananapus/nana-sdk-core/v6', async original => ({
  ...await original<typeof import('@bananapus/nana-sdk-core/v6')>(),
  getCurrentRuleset: async () => ({ ruleset: { id: 111 } }),
  getTokenAddress: async () => zeroAddress,
}))
vi.mock('@/components/create/SplitsEditor', async original => ({
  ...await original<typeof import('@/components/create/SplitsEditor')>(),
  SplitsEditor: () => null,
}))
vi.mock('@/lib/project-distributions', async original => ({
  ...await original<typeof import('@/lib/project-distributions')>(),
  readPayoutOptions: m.payout,
}))

import { EditSplitsFlow } from '@/components/project/EditSplitsFlow'
import { DistributionBatchFlow } from '@/components/project/DistributionBatchFlow'
import { invalidateConfirmedPreparation } from '@/lib/preparation-query'
import type { AuthorityResult } from '@/lib/authority'

let client: QueryClient
let renderer: ReactTestRenderer | undefined
let now: number
const chains = [[1, 17], [8453, 303]] as const

beforeEach(() => {
  now = 1_800_000_000_000
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  vi.stubGlobal('window', { localStorage: { getItem: () => null } })
  m.address = '0x1111111111111111111111111111111111111111'
  m.failedChains.clear()
  m.read.mockImplementation(async (chainId: JBChainId, request: { functionName: string }) => {
    if (m.failedChains.has(chainId)) throw new Error('RPC unavailable')
    if (request.functionName === 'ownerOf') return m.address
    if (request.functionName === 'controllerOf') return jbContractAddress['6'][JBCoreContracts.JBController][chainId]
    if (request.functionName === 'splitsOf') return []
    throw new Error(`Unexpected read: ${request.functionName}`)
  })
  for (const chainId of [1, 8453]) {
    m.clients.set(chainId, { readContract: (request: unknown) => m.read(chainId, request) })
  }
  m.payout.mockImplementation(async (project: { chainId: number; projectId: number }) => {
    if (m.failedChains.has(project.chainId)) throw new Error('RPC unavailable')
    return { ...project, terminal: zeroAddress, contexts: [] }
  })
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
})

afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount())
  renderer = undefined
  client.clear()
})

async function flush() {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}

async function render(node: ReactNode) {
  await act(async () => {
    const tree = <QueryClientProvider client={client}>{node}</QueryClientProvider>
    if (renderer) renderer.update(tree)
    else renderer = create(tree)
  })
  await flush()
}

async function click(label: string) {
  const button = renderer!.root.findAllByType('button').find(node => node.children.join('') === label)
  expect(button, label).toBeDefined()
  await act(async () => { await button!.props.onClick() })
  await flush()
}

function options(prefix: string) {
  const query = client.getQueryCache().findAll({ queryKey: [prefix] }).find(item => item.getObserversCount() > 0)
  expect(query, prefix).toBeDefined()
  // Replay the actual component-owned options, including its key and freshness rule.
  return query!.options as FetchQueryOptions
}

function splitEditor(projectId = 17, chainId: JBChainId = 1, groupId = RESERVED_TOKEN_SPLIT_GROUP_ID, rulesetId = 111n) {
  return <EditSplitsFlow chainId={chainId} projectId={projectId} groupId={groupId} title="recipients" rulesetId={rulesetId} chains={chains} />
}

it('reuses split draft reads on reopen for five seconds, then expires or invalidates them', async () => {
  await render(splitEditor())
  await click('Edit recipients')
  const keys = ['editSplitsLive', 'editSplitsFallback', 'editSplitsDestinations']
  const firstReads = m.read.mock.calls.length
  expect(firstReads).toBeGreaterThan(0)
  for (const key of keys) await client.fetchQuery(options(key))
  expect(m.read).toHaveBeenCalledTimes(firstReads)
  await click('Cancel')
  await click('Edit recipients')
  expect(m.read).toHaveBeenCalledTimes(firstReads)

  now += 5_001
  for (const key of keys) await act(async () => { await client.fetchQuery(options(key)) })
  expect(m.read).toHaveBeenCalledTimes(firstReads * 2)
  await client.invalidateQueries({ queryKey: ['editSplitsLive'], refetchType: 'none' })
  await act(async () => { await client.fetchQuery(options('editSplitsLive')) })
  expect(m.read).toHaveBeenCalledTimes(firstReads * 2 + 1)

  await client.invalidateQueries({ queryKey: ['editSplitsLive'], refetchType: 'none' })
  const pending = Promise.withResolvers<[]>()
  m.read.mockImplementationOnce(() => pending.promise)
  await act(async () => {
    const first = client.fetchQuery(options('editSplitsLive'))
    const second = client.fetchQuery(options('editSplitsLive'))
    expect(m.read).toHaveBeenCalledTimes(firstReads * 2 + 2)
    pending.resolve([])
    await Promise.all([first, second])
  })
})

it('does not reuse split data for another chain, project, group, ruleset or account', async () => {
  await render(splitEditor())
  await click('Edit recipients')
  const firstKeys = client.getQueryCache().findAll({ queryKey: ['editSplitsLive'] }).length
  for (const node of [splitEditor(18), splitEditor(18, 8453), splitEditor(18, 8453, 2n), splitEditor(18, 8453, 2n, 112n)]) {
    await render(node)
  }
  expect(client.getQueryCache().findAll({ queryKey: ['editSplitsLive'] })).toHaveLength(firstKeys + 4)
  const before = client.getQueryCache().findAll({ queryKey: ['editSplitsDestinations'] }).length
  m.address = '0x2222222222222222222222222222222222222222'
  await render(splitEditor())
  expect(client.getQueryCache().findAll({ queryKey: ['editSplitsDestinations'] })).toHaveLength(before + 1)
})

it('keeps partial split destination failures immediately retryable', async () => {
  m.failedChains.add(8453)
  await render(splitEditor())
  await click('Edit recipients')
  const query = options('editSplitsDestinations')
  expect((client.getQueryData(query.queryKey) as { error: string | null }[]).some(row => row.error === 'RPC unavailable')).toBe(true)
  const before = m.read.mock.calls.length
  m.failedChains.clear()
  await act(async () => { await client.fetchQuery(query) })
  expect(m.read.mock.calls.length).toBeGreaterThan(before)
  expect(client.getQueryState(query.queryKey)?.status).toBe('success')
  expect((client.getQueryData(query.queryKey) as { error: string | null }[]).every(row => row.error === null)).toBe(true)
})

it('does not lease retained successful split data after a failed refresh', async () => {
  await render(splitEditor())
  await click('Edit recipients')
  const query = options('editSplitsLive')
  m.failedChains.add(1)
  await act(async () => {
    await expect(client.fetchQuery({ ...query, staleTime: 0, retry: false })).rejects.toThrow('RPC unavailable')
  })
  expect(client.getQueryState(query.queryKey)?.status).toBe('error')
  expect(client.getQueryData(query.queryKey)).toEqual([])
  const before = m.read.mock.calls.length
  m.failedChains.clear()
  await act(async () => { await client.fetchQuery(query) })
  expect(m.read).toHaveBeenCalledTimes(before + 1)
  expect(client.getQueryState(query.queryKey)?.status).toBe('success')
})

it('reuses distribution options by exact destinations/account, expires them, and retries partial reads', async () => {
  const flow = (projectId = 17, chainId: JBChainId = 1) => <DistributionBatchFlow kind="payouts" chainId={chainId} projectId={projectId} chains={[]} />
  await render(flow())
  await click('Distribute payouts')
  expect(m.payout).toHaveBeenCalledTimes(1)
  await click('Cancel')
  await click('Distribute payouts')
  expect(m.payout).toHaveBeenCalledTimes(1)
  now += 5_001
  await act(async () => { await client.fetchQuery(options('distributionOptions')) })
  expect(m.payout).toHaveBeenCalledTimes(2)
  await render(flow(18))
  await click('Distribute payouts')
  expect(m.payout).toHaveBeenLastCalledWith({ chainId: 1, projectId: 18 })
  await render(flow(18, 8453))
  await click('Distribute payouts')
  expect(m.payout).toHaveBeenLastCalledWith({ chainId: 8453, projectId: 18 })
  const before = m.payout.mock.calls.length
  m.address = '0x2222222222222222222222222222222222222222'
  await render(flow(18, 8453))
  expect(m.payout).toHaveBeenCalledTimes(before + 1)

  m.failedChains.add(8453)
  await render(<DistributionBatchFlow kind="payouts" chainId={1} projectId={17} chains={chains} />)
  await click('Distribute payouts')
  const partial = client.getQueryCache().findAll({ queryKey: ['distributionOptions'] }).find(query =>
    Array.isArray(query.state.data) && query.state.data.some(row => row.error),
  )!
  expect(partial).toBeDefined()
  const failedReads = m.payout.mock.calls.length
  m.failedChains.clear()
  await act(async () => { await client.fetchQuery(partial.options as FetchQueryOptions) })
  expect(m.payout).toHaveBeenCalledTimes(failedReads + 2)
})

it('invalidates completed authority evidence without treating a queued Safe proposal as execution', () => {
  const preparationKeys = ['editSplitsLive', 'queueRulesetPrefill']
  for (const key of preparationKeys) client.setQueryData([key, 1, 17], 'draft')
  client.setQueryData(['projectDisplay', 6, 1, '17', 'currentRuleset'], 'home')
  client.setQueryData(['projectDisplay', 6, 8453, '303', 'currentRuleset'], 'peer')
  const result: AuthorityResult = {
    directResults: [], relayrGroups: 0, relayrResults: [],
    safeResults: [{ chainId: 1, mode: 'service', status: 'queued', nonce: 0, safeTxHash: zeroAddress as Address }],
  }
  invalidateConfirmedPreparation(client, result, [1], preparationKeys)
  expect(client.getQueryState(['editSplitsLive', 1, 17])?.isInvalidated).toBe(false)
  expect(client.getQueryState(['projectDisplay', 6, 1, '17', 'currentRuleset'])?.isInvalidated).toBe(false)
  invalidateConfirmedPreparation(client, result, [1, 8453], preparationKeys)
  expect(client.getQueryState(['editSplitsLive', 1, 17])?.isInvalidated).toBe(true)
  expect(client.getQueryState(['queueRulesetPrefill', 1, 17])?.isInvalidated).toBe(true)
  expect(client.getQueryState(['projectDisplay', 6, 8453, '303', 'currentRuleset'])?.isInvalidated).toBe(true)
  expect(client.getQueryState(['projectDisplay', 6, 1, '17', 'currentRuleset'])?.isInvalidated).toBe(false)
  result.safeResults[0].status = 'executed'
  invalidateConfirmedPreparation(client, result, [1], preparationKeys)
  expect(client.getQueryState(['projectDisplay', 6, 1, '17', 'currentRuleset'])?.isInvalidated).toBe(true)
})
