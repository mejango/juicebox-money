import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer'
import { safeProposalFor, safeTransactionHash } from '@bananapus/nana-sdk-core/safe-service'
import type { JBChainId } from '@bananapus/nana-sdk-core'
import { encodeFunctionData, type Address, type Hex } from 'viem'
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
  readIdentity: vi.fn(),
  readAuthority: vi.fn(),
  readMatchingAuthorityIdentities: vi.fn(),
}))

vi.mock('@/hooks/useWallet', () => ({ useWallet: () => ({ address: OWNER }) }))
vi.mock('@/components/ChainIcon', () => ({ ChainIcon: () => null }))
vi.mock('@/hooks/useEnsName', () => ({ useEnsName: () => ({ data: undefined }) }))
vi.mock('@/lib/authority', () => ({
  clientFor: (chainId: number) => ({ readContract: () => mocks.readAuthority(chainId) }),
}))
vi.mock('@/lib/wallet-core', { spy: true })
vi.mock('@/lib/cross-chain-authority', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/cross-chain-authority')>()),
  readMatchingAuthorityIdentities: mocks.readMatchingAuthorityIdentities,
}))
vi.mock('@bananapus/nana-sdk-core/safe', { spy: true })

import { SafeQueueCard, type SafeQueueChain } from '@/components/project/SafeQueueCard'
import { safeAccountQueryOptions } from '@/lib/safe-account-query'
import { publicClient } from '@/lib/wallet-core'
import { readAuthorityIdentity, readBoundedSafeNonce } from '@bananapus/nana-sdk-core/safe'
import { jbProjectHandlesAbi, PROJECT_HANDLES_ADDRESS } from '@/lib/project-handles'

function textOf(node: ReactTestInstance): string {
  return node.children.map(child => (typeof child === 'string' ? child : textOf(child))).join('')
}

let renderer: TestRenderer.ReactTestRenderer

async function renderQueue(
  chainId: JBChainId,
  name: string,
  chains: SafeQueueChain[] = [
    { chainId, name, projectId: 42, isRevnet: false, handleTuples: [{ chainId, projectId: 42 }] },
  ],
  waitForAll = true,
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  await act(async () => {
    renderer = TestRenderer.create(
      createElement(
        QueryClientProvider,
        { client },
        createElement(SafeQueueCard, {
          safe: SAFE,
          chains,
          authorityLabel: 'Project owner',
        }),
      ),
    )
  })
  if (waitForAll) await vi.waitFor(() => {
    expect(textOf(renderer.root)).not.toContain('Loading multisig transactions')
  })
}

beforeEach(() => {
  mocks.info = { owners: [OWNER], threshold: 1 }
  mocks.readIdentity.mockReset().mockImplementation(async () => ({ kind: 'safe', ...mocks.info }))
  vi.mocked(readAuthorityIdentity).mockImplementation(mocks.readIdentity)
  vi.mocked(readBoundedSafeNonce).mockResolvedValue(5n)
  vi.mocked(publicClient).mockImplementation(chainId => ({ chain: { id: chainId } }) as unknown as ReturnType<typeof publicClient>)
  mocks.readAuthority.mockReset().mockResolvedValue(SAFE)
  mocks.fetch.mockReset().mockRejectedValue(new Error('No Safe service in this test'))
  vi.stubGlobal('fetch', mocks.fetch)
})

afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount())
})

describe('Safe queue and the transaction service', () => {
  it('loads offscreen and renders a verified chain while another identity is still pending', async () => {
    const slow = Promise.withResolvers<{ kind: 'safe'; owners: Address[]; threshold: number }>()
    mocks.readIdentity.mockImplementation((client: { chain: { id: number } }) =>
      client.chain.id === 10 ? slow.promise : Promise.resolve({ kind: 'safe', ...mocks.info }),
    )
    const observe = vi.fn()
    vi.stubGlobal('IntersectionObserver', class { observe = observe; disconnect() {} })
    mocks.fetch.mockImplementation(async () => new Response(JSON.stringify({ results: [], next: null })))
    await renderQueue(1, 'Ethereum', [
      { chainId: 1, name: 'Ethereum', projectId: 42, isRevnet: false, handleTuples: [] },
      { chainId: 10, name: 'Optimism', projectId: 42, isRevnet: false, handleTuples: [] },
    ], false)

    await vi.waitFor(() => expect(textOf(renderer.root)).toContain('No pending transactions.'))
    expect(textOf(renderer.root)).toContain('Loading multisig transactions')
    expect(mocks.fetch.mock.calls.some(([url]) => String(url).includes('/oeth/'))).toBe(true)
    expect(mocks.readIdentity).toHaveBeenCalledTimes(2)
    expect(observe).not.toHaveBeenCalled()

    await act(async () => slow.resolve({ kind: 'safe', ...mocks.info }))
    await vi.waitFor(() => expect(textOf(renderer.root)).not.toContain('Loading multisig transactions'))
  })

  it('shares an in-flight Account proof while fetching proposals, withholding rows until that proof resolves', async () => {
    const identity = Promise.withResolvers<{ kind: 'safe'; owners: Address[]; threshold: number }>()
    mocks.readIdentity.mockReturnValue(identity.promise)
    mocks.fetch.mockImplementation(async () => new Response(JSON.stringify({ results: [], next: null })))
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const account = client.fetchQuery(safeAccountQueryOptions(1, SAFE))
    await renderQueue(1, 'Ethereum', undefined, false, client)

    await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalled())
    expect(mocks.readIdentity).toHaveBeenCalledTimes(1)
    expect(textOf(renderer.root)).toContain('Loading multisig transactions')
    expect(textOf(renderer.root)).not.toContain('No pending transactions.')
    await act(async () => identity.resolve({ kind: 'safe', ...mocks.info }))
    await account
    await vi.waitFor(() => expect(textOf(renderer.root)).toContain('No pending transactions.'))
  })

  it('offers a chain retry after an unreadable identity and recovers without a reload', async () => {
    mocks.readIdentity.mockResolvedValueOnce(null)
    mocks.fetch.mockImplementation(async () => new Response(JSON.stringify({ results: [], next: null })))
    await renderQueue(1, 'Ethereum')
    expect(textOf(renderer.root)).toContain('Could not verify this account.')
    expect(textOf(renderer.root)).not.toContain('No pending transactions.')
    const retry = renderer.root.findAllByType('button').find(button => textOf(button) === 'Retry Ethereum')!
    expect(retry).toBeDefined()
    await act(async () => retry.props.onClick())
    await vi.waitFor(() => expect(textOf(renderer.root)).toContain('No pending transactions.'))
    expect(mocks.readIdentity).toHaveBeenCalledTimes(2)
  })

  it('does not publish a queue until the parallel live authority check succeeds', async () => {
    const authority = Promise.withResolvers<Address>()
    mocks.readAuthority.mockReturnValue(authority.promise)
    mocks.fetch.mockImplementation(async () => new Response(JSON.stringify({ results: [], next: null })))
    await renderQueue(1, 'Ethereum', undefined, false)
    await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalled())
    expect(textOf(renderer.root)).toContain('Loading multisig transactions')
    await act(async () => authority.resolve(TARGET))
    await vi.waitFor(() => expect(textOf(renderer.root)).toContain('This Safe is no longer the project owner'))
    expect(textOf(renderer.root)).not.toContain('No pending transactions.')
  })

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

describe("a queued handle claim on Ethereum", () => {
  it("shows the line for a Safe it can't prove is the same there, with nothing to sign or execute", async () => {
    // The project is on Base; its Safe's claim of the Ethereum handle is queued there.
    mocks.readMatchingAuthorityIdentities.mockResolvedValue({
      source: { kind: 'safe' },
      destination: { kind: 'safe' },
      matches: false,
      creationUnproven: true,
    })
    const claim = safeProposalFor(
      {
        to: PROJECT_HANDLES_ADDRESS,
        data: encodeFunctionData({
          abi: jbProjectHandlesAbi,
          functionName: 'setEnsNamePartsFor',
          args: [8453n, 42n, ['myproject']],
        }),
      },
      5,
    )
    const row = {
      ...claim,
      safe: SAFE,
      safeTxHash: safeTransactionHash(1, SAFE, claim),
      confirmationsRequired: 1,
      confirmations: [],
      isExecuted: false,
    }
    mocks.fetch.mockImplementation(async (input: string) =>
      String(input).startsWith(`https://api.safe.global/tx-service/eth/api/v1/safes/${SAFE}/multisig-transactions/`)
        ? new Response(JSON.stringify({ results: [row], next: null }), { status: 200 })
        : new Response('{}', { status: 404 }),
    )

    await renderQueue(1, 'Ethereum', [
      {
        chainId: 1,
        name: 'Ethereum',
        projectId: 42,
        isRevnet: false,
        handleOnly: true,
        handleTuples: [{ chainId: 8453, projectId: 42 }],
      },
    ])

    const text = textOf(renderer.root)
    expect(text).toContain('#5')
    expect(text).toContain("Can't verify this Safe is the same on Ethereum.")
    const labels = renderer.root.findAllByType('button').map(button => textOf(button))
    expect(labels).not.toContain('Sign')
    expect(labels).not.toContain('Execute')
  })
})
