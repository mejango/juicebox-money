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

function localStorageStub() {
  const values = new Map<string, string>()
  return {
    values,
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    removeItem: vi.fn((key: string) => values.delete(key)),
  }
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
  it('shows the current site URL with the normalized current or draft handle', async () => {
    liveParts = ['current']
    liveHandle = 'current'
    vi.stubGlobal('window', {
      location: { origin: 'https://juicebox.example' },
    })
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

    const urlCopy = () =>
      renderer.root
        .findAllByType('p')
        .map(textOf)
        .find(text => text.startsWith('You’ll be able to find your project at'))

    expect(urlCopy()).toBe(
      'You’ll be able to find your project at https://juicebox.example/@current',
    )
    expect(textOf(renderer.root)).not.toContain('Use any .eth name')

    act(() =>
      renderer.root
        .findAllByType('button')
        .find(button => textOf(button) === 'Edit handle')!
        .props.onClick(),
    )
    expect(renderer.root.findByType('dialog')).toBeDefined()
    expect(renderer.root.findByProps({ 'data-modal-body': true })).toBeDefined()
    expect(renderer.root.findByProps({ 'data-modal-footer': true })).toBeDefined()
    act(() =>
      renderer.root
        .findByProps({ placeholder: 'banny.eth' })
        .props.onChange({ target: { value: '@Design.Juicebox.eth' } }),
    )

    expect(urlCopy()).toBe(
      'You’ll be able to find your project at https://juicebox.example/@design.juicebox',
    )
    const cardText = textOf(renderer.root)
    expect(cardText).not.toContain('URL: /@design.juicebox')
    expect(cardText).not.toContain('JBProjectHandles performs')
    expect(cardText).not.toContain('same button resumes')
  })

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
    const setupProgress = renderer.root.findByProps({
      'aria-label': 'Project handle setup progress',
    })
    const setupSteps = setupProgress.findAllByType('li')
    expect(setupSteps).toHaveLength(2)
    expect(textOf(setupSteps[0])).toContain(
      'Step 1 of 2: Set the ENS juicebox text record to 1:42',
    )
    expect(textOf(setupSteps[1])).toContain(
      'Step 2 of 2: Publish the JBProjectHandles reverse claim on Ethereum',
    )
    expect(setupSteps.map(step => step.props['data-state'])).toEqual([
      'active',
      'pending',
    ])
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
  })

  it('shows completed ENS progress before the reverse claim without submitting', async () => {
    liveTextRecord = '1:42'
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
    let stepStates: string[] = []
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await flushQueries()
      const setupProgress = renderer.root.findByProps({
        'aria-label': 'Project handle setup progress',
      })
      stepStates = setupProgress
        .findAllByType('li')
        .map(step => step.props['data-state'])
      if (stepStates[0] === 'complete') break
    }

    expect(stepStates).toEqual(['complete', 'active'])
    expect(mocks.runAuthorityCalls).not.toHaveBeenCalled()
  })

  it('locks every modal close path while a setup step is running', async () => {
    let releaseEns!: () => void
    mocks.runAuthorityCalls.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          releaseEns = () => {
            liveTextRecord = '1:42'
            resolve({ safeResults: [] })
          }
        }),
    )
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
    for (let attempt = 0; attempt < 20 && !releaseEns; attempt += 1) {
      await flushQueries()
    }

    expect(renderer.root.findByProps({ 'aria-label': 'Close' }).props.disabled).toBe(
      true,
    )
    expect(
      renderer.root
        .findAllByType('button')
        .find(button => textOf(button) === 'Cancel')!.props.disabled,
    ).toBe(true)
    expect(
      renderer.root.findByProps({ placeholder: 'banny.eth' }).props.disabled,
    ).toBe(true)
    expect(
      renderer.root
        .findAllByType('button')
        .find(button => textOf(button).includes('Step 1 of 2'))!.props.disabled,
    ).toBe(true)
    const dialog = renderer.root.findByType('dialog')
    const preventDefault = vi.fn()
    act(() => dialog.props.onCancel({ preventDefault }))
    expect(preventDefault).toHaveBeenCalled()
    const backdrop = {}
    act(() =>
      dialog.props.onMouseDown({ target: backdrop, currentTarget: backdrop }),
    )
    expect(renderer.root.findByType('dialog')).toBeDefined()

    act(() => releaseEns())
    for (
      let attempt = 0;
      attempt < 20 && mocks.runAuthorityCalls.mock.calls.length < 2;
      attempt += 1
    ) {
      await flushQueries()
    }
    await flushQueries()
    expect(mocks.runAuthorityCalls).toHaveBeenCalledTimes(2)
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

  it('persists an authority-scoped normalized draft across close and reload', async () => {
    const storage = localStorageStub()
    vi.stubGlobal('window', {
      location: { origin: 'https://juicebox.example' },
      localStorage: storage,
    })
    liveParts = ['old']
    liveHandle = 'old'
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

    const renderFor = async (projectId: number) => {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      })
      let next!: TestRenderer.ReactTestRenderer
      await act(async () => {
        next = TestRenderer.create(
          createElement(
            QueryClientProvider,
            { client: queryClient },
            createElement(ProjectHandleCard, {
              deployment: {
                chainId: 1,
                projectId,
                indexedAuthority: OWNER,
              },
              isRevnet: false,
            }),
          ),
        )
      })
      await flushQueries()
      return next
    }
    const open = (renderer: TestRenderer.ReactTestRenderer) =>
      act(() =>
        renderer.root
          .findAllByType('button')
          .find(button => ['Set handle', 'Edit handle'].includes(textOf(button)))!
          .props.onClick(),
      )

    let renderer = await renderFor(42)
    open(renderer)
    act(() =>
      renderer.root
        .findByProps({ placeholder: 'banny.eth' })
        .props.onChange({ target: { value: '@Banny.ETH' } }),
    )
    await flushQueries()

    const [draftKey] = [...storage.values.keys()]
    expect(draftKey).toBe(
      `jbm-project-handle-draft-v1:1:42:${OWNER.toLowerCase()}`,
    )
    expect(storage.values.get(draftKey)).toBe('banny.eth')

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

    act(() =>
      renderer.root
        .findAllByType('button')
        .find(button => textOf(button) === 'Close')!
        .props.onClick(),
    )
    open(renderer)
    await flushQueries()
    expect(
      renderer.root.findByProps({ placeholder: 'banny.eth' }).props.value,
    ).toBe('banny.eth')

    // Invalid transient edits never destroy the last resume-safe normalized
    // value. Closing and reopening restores the exact persisted draft.
    act(() =>
      renderer.root
        .findByProps({ placeholder: 'banny.eth' })
        .props.onChange({ target: { value: 'not a valid ENS name' } }),
    )
    expect(storage.values.get(draftKey)).toBe('banny.eth')
    act(() =>
      renderer.root
        .findAllByType('button')
        .find(button => textOf(button) === 'Cancel')!
        .props.onClick(),
    )
    open(renderer)
    await flushQueries()
    expect(
      renderer.root.findByProps({ placeholder: 'banny.eth' }).props.value,
    ).toBe('banny.eth')

    await act(async () => renderer.unmount())
    renderer = await renderFor(42)
    open(renderer)
    await flushQueries()
    expect(
      renderer.root.findByProps({ placeholder: 'banny.eth' }).props.value,
    ).toBe('banny.eth')

    await act(async () => renderer.unmount())
    liveParts = null
    liveHandle = null
    renderer = await renderFor(43)
    open(renderer)
    await flushQueries()
    expect(
      renderer.root.findByProps({ placeholder: 'banny.eth' }).props.value,
    ).toBe('')

    await act(async () => renderer.unmount())
    liveParts = ['banny']
    liveHandle = 'banny'
    liveTextRecord = '1:42'
    renderer = await renderFor(42)
    await flushQueries()
    expect(storage.values.has(draftKey)).toBe(false)
    await act(async () => renderer.unmount())
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
    let resume: ReactTestInstance | undefined
    for (let attempt = 0; attempt < 20 && !resume; attempt += 1) {
      await flushQueries()
      resume = renderer.root
        .findAllByType('button')
        .find(button => textOf(button) === 'Resume: publish handle')
    }
    expect(resume).toBeDefined()
    act(() => resume!.props.onClick())
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
