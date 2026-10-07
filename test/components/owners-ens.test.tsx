// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('@/hooks/useWallet', () => ({ useWallet: () => ({ openSignIn: vi.fn() }) }))
vi.mock('@/hooks/useViewedAccount', () => ({ useViewedAccount: () => ({}) }))
vi.mock('@/hooks/useProjectTokenSymbol', () => ({
  useProjectTokenSymbol: () => ({ data: { symbol: 'TEST' } }),
}))
vi.mock('@/components/project/TokenPanel', () => ({ TokenPanel: () => null }))
vi.mock('@/lib/ens', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/ens')>()),
  lookupEnsName: vi.fn(async (address: string) => `owner-${address.slice(-4)}.eth`),
}))

import { OwnersTab } from '@/components/project/OwnersTab'
import { AddressText } from '@/components/ui/AddressLabel'
import { lookupEnsName } from '@/lib/ens'

const holders = Array.from({ length: 240 }, (_, index) => ({
  address: `0x${(index + 1).toString(16).padStart(40, '0')}`,
  chainId: 1,
  balance: String(1_000n * 10n ** 18n),
  volumeUsd: '0',
}))

let renderer: TestRenderer.ReactTestRenderer | undefined
let client: QueryClient

afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount())
  renderer = undefined
  client?.clear()
})

function textOf(node: ReactTestInstance): string {
  return node.children.map(child => typeof child === 'string' ? child : textOf(child)).join('')
}

async function flushQueries() {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}

it('resolves only visible holder names and the active donut tooltip, reusing cached names', async () => {
  vi.stubGlobal('fetch', vi.fn(async input => {
    expect(String(input)).toMatch(/^\/api\/participants\?/)
    return Response.json({ items: holders, totalCount: holders.length })
  }))
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    renderer = TestRenderer.create(
      <QueryClientProvider client={client}>
        <OwnersTab chainId={1} projectId={6} isRevnet={false} suckerGroupId={null} chains={[[1, 6]]} />
      </QueryClientProvider>,
    )
  })
  await flushQueries()
  await flushQueries()

  const root = renderer!.root
  const chart = root.findByProps({ 'aria-label': 'TEST owner distribution' })
  const slices = chart.findAllByType('path')
  expect(slices).toHaveLength(240)
  expect(chart.findAllByType(AddressText)).toHaveLength(0)
  expect(root.findAllByType(AddressText)).toHaveLength(30)
  expect(vi.mocked(lookupEnsName).mock.calls.map(([address]) => address)).toEqual(
    holders.slice(0, 30).map(holder => holder.address),
  )
  expect(textOf(root)).toContain('owner-0001.eth')
  for (const slice of slices) {
    expect(slice.props.tabIndex).toBe(0)
    expect(slice.props['aria-label']).toMatch(/^0x[0-9a-f]{40}, 1,000 TEST, 0\.4166%$/)
    expect(textOf(slice.findByType('title'))).toMatch(/^0x[0-9a-f]{40} — 0\.4166%$/)
  }

  // Reversed drawing order puts these holders outside the first table page.
  await act(async () => slices[0].props.onPointerEnter())
  await flushQueries()
  expect(root.findAllByType(AddressText)).toHaveLength(31)
  expect(lookupEnsName).toHaveBeenCalledTimes(31)
  expect(lookupEnsName).toHaveBeenLastCalledWith(holders[239].address)
  expect(textOf(root.findByProps({ role: 'tooltip' }))).toContain('owner-00f0.eth')
  await act(async () => slices[0].props.onPointerLeave())
  expect(root.findAllByType(AddressText)).toHaveLength(30)
  expect(root.findAllByProps({ role: 'tooltip' })).toHaveLength(0)

  await act(async () => slices[1].props.onFocus())
  await flushQueries()
  expect(root.findAllByType(AddressText)).toHaveLength(31)
  expect(lookupEnsName).toHaveBeenCalledTimes(32)
  expect(lookupEnsName).toHaveBeenLastCalledWith(holders[238].address)
  expect(textOf(root.findByProps({ role: 'tooltip' }))).toContain('owner-00ef.eth')
  await act(async () => slices[1].props.onBlur())
  expect(root.findAllByType(AddressText)).toHaveLength(30)

  await act(async () => slices[0].props.onFocus())
  await flushQueries()
  expect(lookupEnsName).toHaveBeenCalledTimes(32)
  expect(textOf(root.findByProps({ role: 'tooltip' }))).toContain('owner-00f0.eth')
  await act(async () => slices[0].props.onBlur())

  const pages = root.findByProps({ 'aria-label': 'Owners table pages' })
  const next = pages.findAllByType('button').find(button => textOf(button) === 'Next ›')!
  await act(async () => next.props.onClick())
  await flushQueries()
  expect(root.findAllByType(AddressText)).toHaveLength(30)
  expect(lookupEnsName).toHaveBeenCalledTimes(62)
  expect(vi.mocked(lookupEnsName).mock.calls.slice(32).map(([address]) => address)).toEqual(
    holders.slice(30, 60).map(holder => holder.address),
  )

  const previous = pages.findAllByType('button').find(button => textOf(button) === '‹ Prev')!
  await act(async () => previous.props.onClick())
  await flushQueries()
  expect(root.findAllByType(AddressText)).toHaveLength(30)
  expect(lookupEnsName).toHaveBeenCalledTimes(62)
  expect(textOf(root)).toContain('owner-0001.eth')

  // A visible table row and its active tooltip share the same ENS query.
  await act(async () => slices.at(-1)!.props.onFocus())
  await flushQueries()
  expect(root.findAllByType(AddressText)).toHaveLength(31)
  expect(lookupEnsName).toHaveBeenCalledTimes(62)
  expect(textOf(root.findByProps({ role: 'tooltip' }))).toContain('owner-0001.eth')
})
