// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { getAmountToAutoIssue } from '@bananapus/nana-sdk-core/v6'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { PublicClient } from 'viem'

const mocks = vi.hoisted(() => ({ client: { chain: { id: 1 } } }))

vi.mock('wagmi', () => ({ usePublicClient: () => mocks.client }))
vi.mock('@/components/ui/AddressLink', () => ({ AddressLink: ({ address }: { address: string }) => address }))
vi.mock('@/components/project/ProjectTokenBatchFlow', () => ({
  AutoIssueAcrossChains: () => null,
  AutoIssueAllocation: ({ stageId }: { stageId: string }) => <button data-live={stageId}>Distribute</button>,
}))
vi.mock('@bananapus/nana-sdk-core/v6', async importOriginal => ({
  ...await importOriginal<typeof import('@bananapus/nana-sdk-core/v6')>(),
  getAmountToAutoIssue: vi.fn(),
}))

import { AutoIssuanceSection } from '@/components/project/AutoIssuanceSection'
import { allRulesetsQuery } from '@/lib/project-display-queries'
import { projectTokenQuery } from '@/lib/project-token-query'

it('disables Distribute until the stage starts, and leaves a started stage live', async () => {
  const client = mocks.client as unknown as PublicClient
  const future = Math.floor(Date.now() / 1000) + 86_400
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(allRulesetsQuery(client, { chainId: 1, projectId: 7n, size: 50n }).queryKey, [
    { ruleset: { id: 11n, start: 1_000 } },
    { ruleset: { id: 12n, start: future } },
  ])
  queryClient.setQueryData(projectTokenQuery(client, 1, 7).queryKey, { address: `0x${'2'.repeat(40)}`, symbol: 'TEST' })
  vi.mocked(getAmountToAutoIssue).mockResolvedValue(100n)
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({
    stored: [
      { stageId: '11', beneficiary: `0x${'1'.repeat(40)}`, count: '100' },
      { stageId: '12', beneficiary: `0x${'1'.repeat(40)}`, count: '100' },
    ],
    issued: [],
  })))
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => root.render(
    <QueryClientProvider client={queryClient}>
      <AutoIssuanceSection home={[1, 7]} chains={[[1, 7]]} />
    </QueryClientProvider>,
  ))
  const row = (label: string) => [...container.querySelectorAll('tr')].find(tr => tr.textContent?.includes(label))!
  await act(async () => {
    await vi.waitFor(() => expect(row('Stage 1').querySelector('button[data-live="11"]')).not.toBeNull())
  })
  expect(row('Stage 2').querySelector('button[data-live]')).toBeNull()
  expect((row('Stage 2').querySelector('button') as HTMLButtonElement).disabled).toBe(true)
  expect(row('Stage 2').textContent).toContain(new Date(future * 1000).getFullYear().toString())
  await act(async () => root.unmount())
})
