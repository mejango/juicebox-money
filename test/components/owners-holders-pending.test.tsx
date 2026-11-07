// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import TestRenderer, { act } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'

const group = vi.hoisted(() => {
  let settle!: (pairs: { peerChainId: number; projectId: bigint }[]) => void
  const pending = new Promise<{ peerChainId: number; projectId: bigint }[]>(resolve => { settle = resolve })
  return { pending, settle: (pairs: { peerChainId: number; projectId: bigint }[]) => settle(pairs) }
})

vi.mock('@bananapus/nana-sdk-core', async importOriginal => ({
  ...(await importOriginal<typeof import('@bananapus/nana-sdk-core')>()),
  resolveSuckers: () => group.pending,
}))
vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('@/hooks/useWallet', () => ({ useWallet: () => ({ openSignIn: vi.fn() }) }))
vi.mock('@/hooks/useViewedAccount', () => ({ useViewedAccount: () => ({}) }))
vi.mock('@/hooks/useProjectTokenSymbol', () => ({
  useProjectTokenSymbol: () => ({ data: { symbol: 'TEST' } }),
}))
vi.mock('@/components/project/TokenPanel', () => ({ TokenPanel: () => null }))
vi.mock('@/components/project/ProjectTokenBatchFlow', () => ({ ClaimCreditsAcrossChains: () => null }))

import { OwnersTab } from '@/components/project/OwnersTab'

let renderer: TestRenderer.ReactTestRenderer | undefined
afterEach(async () => { if (renderer) await act(async () => renderer!.unmount()) })

const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })

it('holds the holder card on its skeleton, unfetched, until the group check lands', async () => {
  const fetchMock = vi.fn(async (_input: string) => Response.json({
    items: [{ address: `0x${'1'.repeat(40)}`, chainId: 1, balance: '1000', volumeUsd: '0' }],
    totalCount: 1,
  }))
  vi.stubGlobal('fetch', fetchMock)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    renderer = TestRenderer.create(
      <QueryClientProvider client={client}>
        <OwnersTab chainId={1} projectId={3} isRevnet suckerGroupId="group" chains={[[1, 3], [8453, 3]]} />
      </QueryClientProvider>,
    )
  })
  await flush()
  const participantCalls = () => fetchMock.mock.calls.map(([url]) => String(url)).filter(url => url.startsWith('/api/participants'))
  expect(participantCalls()).toEqual([])
  expect(JSON.stringify(renderer!.toJSON())).not.toContain('TEST owner distribution')

  await act(async () => { group.settle([{ peerChainId: 1, projectId: 3n }, { peerChainId: 8453, projectId: 3n }]) })
  await flush()
  await flush()
  expect(participantCalls()).toHaveLength(1)
  expect(decodeURIComponent(participantCalls()[0])).toContain('refs=1:3,8453:3')
  expect(JSON.stringify(renderer!.toJSON())).toContain('TEST owner distribution')
})
