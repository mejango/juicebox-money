// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Address } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SafeQueueChain } from '@/components/project/SafeQueueCard'

const SAFE = '0x1111111111111111111111111111111111111111' as Address
const OWNER = '0x2222222222222222222222222222222222222222' as Address
const CURRENT = '0x3333333333333333333333333333333333333333' as Address
const safeIdentity = { kind: 'safe', owners: [OWNER], threshold: 1 }

const mocks = vi.hoisted(() => ({
  authority: vi.fn(),
  identity: vi.fn(),
  queue: vi.fn(),
}))

vi.mock('@/lib/authority', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/authority')>()),
  clientFor: (chainId: number) => ({ chain: { id: chainId } }),
  readAuthorityOf: mocks.authority,
}))
// Module spies stay consistent across simultaneous lazy imports for each chain.
vi.mock('@/lib/wallet-core', { spy: true })
vi.mock('@bananapus/nana-sdk-core/safe', { spy: true })
vi.mock('@/lib/bendystraw', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/bendystraw')>()),
  getPermissionHoldersAcrossDeployments: async () => [],
}))
vi.mock('@/components/project/SafeQueueCard', () => ({
  SafeQueueCard: (props: { safe: Address; chains: SafeQueueChain[] }) => {
    mocks.queue(props)
    return <div data-safe-queue={props.safe} />
  },
}))
vi.mock('@/components/ui/AddressLink', () => ({
  AddressLink: ({ address }: { address: string }) => <span>{address}</span>,
}))
vi.mock('@/components/ui/SafeAddressLink', () => ({
  SafeAddressLink: ({ address }: { address: string }) => <span>{address}</span>,
}))
vi.mock('@/components/ChainIcon', () => ({ ChainIcon: () => null }))

import { AuthorityOverview } from '@/components/project/AuthorityOverview'
import { SafeBadge } from '@/components/SafeBadge'
import { readAuthorityIdentity } from '@bananapus/nana-sdk-core/safe'
import { publicClient } from '@/lib/wallet-core'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

let container: HTMLDivElement
let root: Root
let client: QueryClient

beforeEach(() => {
  mocks.authority.mockReset().mockResolvedValue(SAFE)
  mocks.identity.mockReset().mockResolvedValue(safeIdentity)
  mocks.queue.mockReset()
  vi.mocked(readAuthorityIdentity).mockImplementation(mocks.identity)
  vi.mocked(publicClient).mockImplementation(chainId => ({ chain: { id: chainId } }) as unknown as ReturnType<typeof publicClient>)
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  client.clear()
  container.remove()
})

async function render(chains: readonly (1 | 10 | 8453)[] = [1], badge = false) {
  await act(async () => root.render(
    <QueryClientProvider client={client}>
      <AuthorityOverview isRevnet deployments={chains.map(chainId => ({
        chainId, projectId: 42, indexedAuthority: SAFE,
      }))} />
      {badge ? <SafeBadge address={SAFE} chainId={1} /> : null}
    </QueryClientProvider>,
  ))
}

function account() {
  return container.querySelector('section')!
}

function accountActions() {
  return [...account().querySelectorAll('button')].filter(button =>
    /Transfer revnet operator|Deploy Safe/.test(button.textContent ?? ''),
  )
}

function latestQueue() {
  return mocks.queue.mock.calls.at(-1)?.[0] as { safe: Address; chains: SafeQueueChain[] } | undefined
}

describe('progressive project authority loading', () => {
  it('shows completed authority and queue chains while another authority and account identity are pending', async () => {
    const authority = deferred<Address>()
    const identity = deferred<typeof safeIdentity>()
    mocks.authority.mockImplementation(async (_client, deployment: { chainId: number }) =>
      deployment.chainId === 8453 ? authority.promise : SAFE,
    )
    mocks.identity.mockImplementation(async (chainClient: { chain: { id: number } }) =>
      chainClient.chain.id === 10 ? identity.promise : safeIdentity,
    )
    await render([1, 10, 8453])
    await vi.waitFor(() => {
      expect(account().textContent).toContain(SAFE)
      expect(account().textContent).toContain('Requires 1 of 1 signatures')
      expect(latestQueue()?.chains.map(chain => chain.chainId)).toEqual([1, 10])
      expect(mocks.identity.mock.calls.map(([chainClient]) => chainClient.chain.id)).toEqual([1, 10])
    })
    expect(account().textContent).toMatch(/Checking/)
    expect(mocks.authority.mock.calls.every(([, , options]) => options.strict === true)).toBe(true)
    // The completed Safe may expose its own control; the pending chain may not.
    expect(accountActions()).toHaveLength(1)
    await act(async () => { identity.resolve(safeIdentity); authority.resolve(SAFE) })
    await vi.waitFor(() => expect(latestQueue()?.chains.map(chain => chain.chainId)).toEqual([1, 10, 8453]))
    expect(mocks.identity.mock.calls.map(([chainClient]) => chainClient.chain.id)).toEqual([1, 10, 8453])
  })

  it('mounts the verified account queue before classification while withholding transfer and deployment controls', async () => {
    const identity = deferred<typeof safeIdentity>()
    mocks.identity.mockReturnValue(identity.promise)
    await render()
    await vi.waitFor(() => expect(latestQueue()?.safe).toBe(SAFE))
    expect(account().textContent).toContain(SAFE)
    expect(account().textContent).toMatch(/Checking/)
    expect(account().textContent).not.toMatch(/Safe Multisig|EOA|Contract|Requires .* signatures/)
    expect(accountActions()).toHaveLength(0)
    await act(async () => identity.resolve(safeIdentity))
    await vi.waitFor(() => expect(accountActions()).toHaveLength(1))
    expect(account().textContent).toContain('Safe Multisig')
  })

  it('shares the pending account identity read with its Safe badge', async () => {
    const identity = deferred<typeof safeIdentity>()
    mocks.identity.mockReturnValue(identity.promise)
    await render()
    await vi.waitFor(() => expect(mocks.identity).toHaveBeenCalledTimes(1))
    await render([1], true)
    expect(mocks.identity).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[aria-label="Open wallet in Safe"]')).toBeNull()
    await act(async () => identity.resolve(safeIdentity))
    await vi.waitFor(() => {
      expect(account().textContent).toContain('Requires 1 of 1 signatures')
      expect(container.querySelector('[aria-label="Open wallet in Safe"]')).not.toBeNull()
    })
    expect(mocks.identity).toHaveBeenCalledTimes(1)
  })

  it.each(['null', 'error'] as const)('keeps a %s account identity unknown and retries it without guessing an EOA or contract', async failure => {
    if (failure === 'null') mocks.identity.mockResolvedValueOnce(null)
    else mocks.identity.mockRejectedValueOnce(new Error('Identity RPC unavailable'))
    await render()
    const retry = await vi.waitFor(() => {
      const button = [...account().querySelectorAll('button')].find(item => /Retry/.test(item.textContent ?? ''))
      expect(button).toBeDefined()
      return button!
    })
    expect(account().textContent).toContain(SAFE)
    expect(account().textContent).not.toMatch(/Safe Multisig|EOA|Contract|Requires .* signatures/)
    expect(accountActions()).toHaveLength(0)
    expect(latestQueue()?.safe).toBe(SAFE)
    await act(async () => retry.click())
    await vi.waitFor(() => expect(account().textContent).toContain('Requires 1 of 1 signatures'))
    expect(mocks.identity).toHaveBeenCalledTimes(2)
    expect(accountActions()).toHaveLength(1)
  })

  it('uses live authority for the queue and never classifies the stale indexed candidate', async () => {
    const authority = deferred<Address>()
    mocks.authority.mockReturnValue(authority.promise)
    await render()
    expect(mocks.identity).not.toHaveBeenCalled()
    expect(mocks.queue).not.toHaveBeenCalled()
    expect(accountActions()).toHaveLength(0)
    await act(async () => authority.resolve(CURRENT))
    await vi.waitFor(() => expect(latestQueue()?.safe).toBe(CURRENT))
    expect(mocks.identity).toHaveBeenCalledWith(expect.anything(), CURRENT)
    expect(mocks.identity.mock.calls.some(([, address]) => address === SAFE)).toBe(false)
    expect(account().textContent).not.toContain(SAFE)
  })

  it('keeps an unreadable live authority unknown until retry verifies it', async () => {
    mocks.authority.mockResolvedValueOnce(null)
    await render()
    const retry = await vi.waitFor(() => {
      expect(account().textContent).toContain('Could not read project control')
      const button = [...account().querySelectorAll('button')].find(item => item.textContent === 'Retry')
      expect(button).toBeDefined()
      return button!
    })
    expect(account().textContent).not.toContain(SAFE)
    expect(mocks.identity).not.toHaveBeenCalled()
    expect(mocks.queue).not.toHaveBeenCalled()
    expect(accountActions()).toHaveLength(0)
    await act(async () => retry.click())
    await vi.waitFor(() => expect(account().textContent).toContain('Requires 1 of 1 signatures'))
    expect(mocks.authority).toHaveBeenCalledTimes(2)
    expect(latestQueue()?.safe).toBe(SAFE)
  })
})
