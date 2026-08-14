import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer'
import type { Address } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const OWNER = '0x1111111111111111111111111111111111111111' as Address
const RESOLVER = '0x2222222222222222222222222222222222222222' as Address
let liveTextRecord: string | null = null
let liveHandle: string | null = null
let liveParts: readonly string[] | null = null

const mocks = vi.hoisted(() => ({
  openSignIn: vi.fn(),
  readAuthorityOf: vi.fn(),
  runAuthorityCalls: vi.fn(),
  readDirectEnsProjectRecord: vi.fn(),
  readBoundedProjectHandle: vi.fn(),
  readBoundedProjectHandleParts: vi.fn(),
  simulateStateChangingTransaction: vi.fn(),
}))

vi.mock('@/hooks/useWallet', () => ({
  useWallet: () => ({ address: OWNER, openSignIn: mocks.openSignIn }),
}))

vi.mock('@/lib/authority', () => ({
  clientFor: () => ({}),
  readAuthorityOf: mocks.readAuthorityOf,
  runAuthorityCalls: mocks.runAuthorityCalls,
  safeOutcomeMessage: () => 'Queued in Safe.',
}))

vi.mock('@/lib/project-handles', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/project-handles')>()),
  readDirectEnsProjectRecord: mocks.readDirectEnsProjectRecord,
  readBoundedProjectHandle: mocks.readBoundedProjectHandle,
  readBoundedProjectHandleParts: mocks.readBoundedProjectHandleParts,
}))

vi.mock('@/lib/transaction-simulation', () => ({
  simulateStateChangingTransaction: mocks.simulateStateChangingTransaction,
}))

vi.mock('@/lib/project-fallback', () => ({
  revnetOperatorFromPermissionHistory: vi.fn().mockResolvedValue(null),
}))

vi.mock('@/lib/cross-chain-authority', () => ({
  isDeployableSafeAuthority: () => false,
  readMatchingAuthorityIdentities: vi.fn(),
  safeCreationMatchesAuthorityIdentity: () => false,
}))

vi.mock('@/lib/safe', () => ({
  deploySafeSameAddress: vi.fn(),
  fetchSafeCreation: vi.fn(),
  safeQueueLink: (_chainId: number, safe: Address) =>
    `https://app.safe.global/transactions/queue?safe=eth:${safe}`,
}))

import { ProjectHandleCard } from '@/components/project/ProjectHandleCard'

function textOf(node: ReactTestInstance): string {
  return node.children
    .map(child => (typeof child === 'string' ? child : textOf(child)))
    .join('')
}

async function flushQueries() {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

beforeEach(() => {
  liveTextRecord = null
  liveHandle = null
  liveParts = null

  mocks.openSignIn.mockReset()
  mocks.readAuthorityOf.mockReset().mockResolvedValue(OWNER)
  mocks.readDirectEnsProjectRecord.mockReset().mockImplementation(async () => ({
    resolver: RESOLVER,
    controller: OWNER,
    textRecord: liveTextRecord,
  }))
  mocks.readBoundedProjectHandle.mockReset().mockImplementation(async () => liveHandle)
  mocks.readBoundedProjectHandleParts.mockReset().mockImplementation(async () => liveParts)
  mocks.simulateStateChangingTransaction.mockReset().mockResolvedValue('0x')
  mocks.runAuthorityCalls.mockReset().mockImplementation(async ({ calls }) => {
    const call = calls[0]
    await call.reverifyAuthority?.()
    if (call.functionName === 'setText') liveTextRecord = '1:42'
    if (call.functionName === 'setEnsNamePartsFor') {
      liveParts = ['banny']
      liveHandle = 'banny'
    }
    return { safeResults: [] }
  })
})

describe('ProjectHandleCard', () => {
  it('sets an arbitrary ENS pointer, then publishes the exact viewed tuple', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(ProjectHandleCard, {
            deployment: {
              chainId: 1,
              projectId: 42,
              indexedAuthority: OWNER,
            },
            isRevnet: false,
          }),
        ),
      )
    })
    await flushQueries()

    const open = renderer.root
      .findAllByType('button')
      .find(button => textOf(button) === 'Set handle')
    expect(open).toBeDefined()
    act(() => open!.props.onClick())

    const input = renderer.root.findByProps({ placeholder: 'banny.eth' })
    act(() => input.props.onChange({ target: { value: 'banny.eth' } }))
    await flushQueries()

    const setup = renderer.root
      .findAllByType('button')
      .find(button => textOf(button) === 'Set verified handle')
    expect(setup).toBeDefined()
    act(() => setup!.props.onClick())
    for (let attempt = 0; attempt < 20 && mocks.runAuthorityCalls.mock.calls.length < 2; attempt += 1) {
      await flushQueries()
    }

    expect(mocks.runAuthorityCalls).toHaveBeenCalledTimes(2)
    expect(mocks.runAuthorityCalls).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        calls: [
          expect.objectContaining({
            functionName: 'setText',
            args: [expect.any(String), 'juicebox', '1:42'],
          }),
        ],
      }),
    )
    expect(mocks.runAuthorityCalls).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        calls: [
          expect.objectContaining({
            functionName: 'setEnsNamePartsFor',
            args: [1n, 42n, ['banny']],
            authority: OWNER,
            gas: 1_000_000n,
          }),
        ],
      }),
    )
    expect(
      renderer.root.findAllByType('button').some(button =>
        ['1. Set ENS record', '2. Publish handle'].includes(textOf(button)),
      ),
    ).toBe(false)
  })

  it('accepts an externally completed ENS step without submitting it again', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    mocks.runAuthorityCalls.mockImplementationOnce(async ({ calls }) => {
      liveTextRecord = '1:42'
      await calls[0].reverifyAuthority?.()
      throw new Error('The external-completion guard should have stopped this call.')
    })

    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(ProjectHandleCard, {
            deployment: {
              chainId: 1,
              projectId: 42,
              indexedAuthority: OWNER,
            },
            isRevnet: false,
          }),
        ),
      )
    })
    await flushQueries()
    act(() =>
      renderer.root
        .findAllByType('button')
        .find(button => textOf(button) === 'Set handle')!
        .props.onClick(),
    )
    act(() =>
      renderer.root
        .findByProps({ placeholder: 'banny.eth' })
        .props.onChange({ target: { value: 'banny.eth' } }),
    )
    await flushQueries()
    act(() =>
      renderer.root
        .findAllByType('button')
        .find(button => textOf(button) === 'Set verified handle')!
        .props.onClick(),
    )
    for (let attempt = 0; attempt < 20 && mocks.runAuthorityCalls.mock.calls.length < 2; attempt += 1) {
      await flushQueries()
    }

    expect(mocks.runAuthorityCalls).toHaveBeenCalledTimes(2)
    expect(mocks.runAuthorityCalls.mock.calls[1][0].calls[0]).toMatchObject({
      functionName: 'setEnsNamePartsFor',
      args: [1n, 42n, ['banny']],
    })
  })

  it('stops on a queued ENS Safe action and links to that Safe', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    mocks.runAuthorityCalls.mockResolvedValueOnce({
      safeResults: [
        {
          chainId: 1,
          mode: 'service',
          status: 'queued',
          nonce: 1,
          safeTxHash: `0x${'12'.repeat(32)}`,
        },
      ],
    })

    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(ProjectHandleCard, {
            deployment: {
              chainId: 1,
              projectId: 42,
              indexedAuthority: OWNER,
            },
            isRevnet: false,
          }),
        ),
      )
    })
    await flushQueries()
    act(() =>
      renderer.root
        .findAllByType('button')
        .find(button => textOf(button) === 'Set handle')!
        .props.onClick(),
    )
    act(() =>
      renderer.root
        .findByProps({ placeholder: 'banny.eth' })
        .props.onChange({ target: { value: 'banny.eth' } }),
    )
    await flushQueries()
    act(() =>
      renderer.root
        .findAllByType('button')
        .find(button => textOf(button) === 'Set verified handle')!
        .props.onClick(),
    )
    for (let attempt = 0; attempt < 20 && mocks.runAuthorityCalls.mock.calls.length < 1; attempt += 1) {
      await flushQueries()
    }
    await flushQueries()

    expect(mocks.runAuthorityCalls).toHaveBeenCalledTimes(1)
    expect(
      renderer.root.findByProps({
        href: `https://app.safe.global/transactions/queue?safe=eth:${OWNER}`,
      }),
    ).toBeDefined()
  })

  it('accepts an externally completed Handles claim without reproposing it', async () => {
    liveTextRecord = '1:42'
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    mocks.runAuthorityCalls.mockImplementationOnce(async ({ calls }) => {
      liveParts = ['banny']
      liveHandle = 'banny'
      await calls[0].reverifyAuthority?.()
      throw new Error('The external-completion guard should have stopped this call.')
    })

    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(ProjectHandleCard, {
            deployment: {
              chainId: 1,
              projectId: 42,
              indexedAuthority: OWNER,
            },
            isRevnet: false,
          }),
        ),
      )
    })
    await flushQueries()
    act(() =>
      renderer.root
        .findAllByType('button')
        .find(button => textOf(button) === 'Set handle')!
        .props.onClick(),
    )
    act(() =>
      renderer.root
        .findByProps({ placeholder: 'banny.eth' })
        .props.onChange({ target: { value: 'banny.eth' } }),
    )
    await flushQueries()
    act(() =>
      renderer.root
        .findAllByType('button')
        .find(button => textOf(button) === 'Resume: publish handle')!
        .props.onClick(),
    )
    for (let attempt = 0; attempt < 20 && mocks.runAuthorityCalls.mock.calls.length < 1; attempt += 1) {
      await flushQueries()
    }
    await flushQueries()

    expect(mocks.runAuthorityCalls).toHaveBeenCalledTimes(1)
    expect(
      renderer.root.findAllByType('p').some(node =>
        textOf(node).includes('@banny was completed externally and is verified'),
      ),
    ).toBe(true)
  })
})
