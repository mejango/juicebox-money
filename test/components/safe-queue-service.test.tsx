import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer'
import { safeProposalFor, safeTransactionHash } from '@bananapus/nana-sdk-core/safe-service'
import type { JBChainId } from '@bananapus/nana-sdk-core'
import type { Address, Hex } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The queue card's own reads, through React Query: which chains it asks
// Safe's transaction service about, and how it counts confirmations.

const SAFE = '0x1111111111111111111111111111111111111111' as Address
const OWNER = '0x2222222222222222222222222222222222222222' as Address
const CO_OWNER = '0x3333333333333333333333333333333333333333' as Address
const STRANGER = '0x4444444444444444444444444444444444444444' as Address
const TARGET = '0x5555555555555555555555555555555555555555' as Address

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  info: { owners: [] as Address[], threshold: 1 },
}))

vi.mock('@/hooks/useWallet', () => ({ useWallet: () => ({ address: OWNER }) }))
vi.mock('@/components/ChainIcon', () => ({ ChainIcon: () => null }))
vi.mock('@/hooks/useEnsName', () => ({ useEnsName: () => ({ data: undefined }) }))
vi.mock('@/lib/authority', () => ({
  clientFor: () => ({ readContract: async () => SAFE }),
}))
vi.mock('@/lib/safe', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/safe')>()),
  fetchSafeInfo: async () => mocks.info,
}))
vi.mock('@/lib/wallet-core', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/wallet-core')>()),
  publicClient: () => ({}),
}))
vi.mock('@bananapus/nana-sdk-core/safe', async importOriginal => ({
  ...(await importOriginal<typeof import('@bananapus/nana-sdk-core/safe')>()),
  readBoundedSafeNonce: async () => 5n,
}))

import { SafeQueueCard } from '@/components/project/SafeQueueCard'

function textOf(node: ReactTestInstance): string {
  return node.children.map(child => (typeof child === 'string' ? child : textOf(child))).join('')
}

let renderer: TestRenderer.ReactTestRenderer

async function renderQueue(chainId: JBChainId, name: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    renderer = TestRenderer.create(
      createElement(
        QueryClientProvider,
        { client },
        createElement(SafeQueueCard, {
          safe: SAFE,
          chains: [{ chainId, name, projectId: 42, isRevnet: false, handleTuples: [{ chainId, projectId: 42 }] }],
          authorityLabel: 'Project owner',
        }),
      ),
      // The card loads once its section has a node to observe.
      { createNodeMock: () => ({}) },
    )
  })
  await vi.waitFor(() => {
    expect(textOf(renderer.root)).not.toContain('Loading multisig transactions')
  })
}

beforeEach(() => {
  mocks.info = { owners: [OWNER], threshold: 1 }
  mocks.fetch.mockReset().mockRejectedValue(new Error('No Safe service in this test'))
  vi.stubGlobal('fetch', mocks.fetch)
})

afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount())
})

describe('Safe queue and the transaction service', () => {
  it("shows one line on a chain without Safe's service, and asks it nothing", async () => {
    await renderQueue(11155420, 'Optimism Sepolia')

    expect(textOf(renderer.root)).toContain("Safe queue isn't available on Optimism Sepolia.")
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it("counts only the Safe's current owners' confirmations", async () => {
    mocks.info = { owners: [OWNER, CO_OWNER], threshold: 2 }
    const proposal = safeProposalFor({ to: TARGET, data: '0x1234' }, 5)
    const signature = (byte: string) => `0x${byte.repeat(64)}1b` as Hex
    const row = {
      ...proposal,
      safe: SAFE,
      safeTxHash: safeTransactionHash(11155111, SAFE, proposal),
      confirmationsRequired: 2,
      confirmations: [
        { owner: OWNER, signature: signature('11') },
        { owner: STRANGER, signature: signature('22') },
      ],
      isExecuted: false,
    }
    mocks.fetch.mockImplementation(async (input: string) =>
      String(input).startsWith(`https://api.safe.global/tx-service/sep/api/v1/safes/${SAFE}/multisig-transactions/`)
        ? new Response(JSON.stringify({ results: [row], next: null }), { status: 200 })
        : new Response('{}', { status: 404 }),
    )

    await renderQueue(11155111, 'Sepolia')

    const text = textOf(renderer.root)
    expect(text).toContain('1/2 signatures')
    expect(text).not.toContain('| ready')
    expect(text).toContain('Still needs 1 of:')
  })
})
