// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SAFE_FACTORY } from '@bananapus/nana-sdk-core/safe'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { creationRecord, creationUrl, PROVEN_SAFE, provenSafeChain } from '../support/proven-safe'
import { emptyChain } from '../support/safe-chain'

// The account card's "Deploy Safe on {chain}": the project's Safe exists on
// Ethereum and Optimism, and its address on Base is still empty. Every other
// chain's copy must be proven the same Safe before anything is sent.

const mocks = vi.hoisted(() => ({
  clients: {} as Record<number, unknown>,
  deploySafeSameAddress: vi.fn(),
}))

vi.mock('@/lib/authority', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/authority')>()),
  clientFor: (chainId: number) => mocks.clients[chainId],
  readAuthorityOf: async () => PROVEN_SAFE,
}))
vi.mock('@/lib/safe', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/safe')>()),
  deploySafeSameAddress: mocks.deploySafeSameAddress,
}))
vi.mock('@/lib/wallet-core', { spy: true })
vi.mock('@/lib/bendystraw', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/bendystraw')>()),
  getPermissionHoldersAcrossDeployments: async () => [],
}))
vi.mock('@/components/project/SafeQueueCard', () => ({ SafeQueueCard: () => null }))
vi.mock('@/components/ui/AddressLink', () => ({ AddressLink: () => null }))
vi.mock('@/components/ChainIcon', () => ({ ChainIcon: () => null }))

// The page keeps creation records per chain and Safe; each test starts with none.
let AuthorityOverview: typeof import('@/components/project/AuthorityOverview').AuthorityOverview

const answer = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

let container: HTMLDivElement
let root: Root

beforeEach(async () => {
  vi.resetModules()
  ;({ AuthorityOverview } = await import('@/components/project/AuthorityOverview'))
  mocks.clients = {
    1: provenSafeChain(),
    10: provenSafeChain(),
    8453: Object.assign(emptyChain(), { getBytecode: async () => undefined }),
  }
  mocks.deploySafeSameAddress.mockReset().mockResolvedValue(undefined)
  const { publicClient } = await import('@/lib/wallet-core')
  vi.mocked(publicClient).mockImplementation(chainId => mocks.clients[chainId] as ReturnType<typeof publicClient>)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

/** Clicks "Deploy Safe on Base" with Ethereum's Safe service giving `creation`. */
async function deployOnBase(creation: () => Response) {
  const fetch = vi.fn(async (input: string) =>
    input === creationUrl('eth') ? creation() : answer({}, 404),
  )
  vi.stubGlobal('fetch', fetch)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <AuthorityOverview
          isRevnet={false}
          deployments={([1, 10, 8453] as const).map(chainId => ({
            chainId,
            projectId: 5,
            indexedAuthority: PROVEN_SAFE,
          }))}
        />
      </QueryClientProvider>,
    ),
  )
  const button = await vi.waitFor(() => {
    const found = [...container.querySelectorAll('button')].find(
      element => element.textContent === 'Deploy Safe on Base',
    )
    expect(found, container.textContent ?? '').toBeDefined()
    return found!
  })
  await act(async () => button.click())
  return fetch
}

describe("deploying a project's Safe on another chain", () => {
  it("refuses while another chain's copy can't be proven the same Safe, and sends nothing", async () => {
    const fetch = await deployOnBase(() => answer({}, 404))

    await vi.waitFor(() =>
      expect(container.textContent).toContain("Can't verify this Safe is the same on Optimism."),
    )
    expect(fetch).toHaveBeenCalledExactlyOnceWith(creationUrl('eth'), expect.anything())
    expect(mocks.deploySafeSameAddress).not.toHaveBeenCalled()
  })

  it("deploys once Ethereum's Safe service proves how the Safe was made, asking it once", async () => {
    const fetch = await deployOnBase(() => answer(creationRecord()))

    await vi.waitFor(() => expect(container.textContent).toContain('Safe deployed on Base.'))
    expect(mocks.deploySafeSameAddress).toHaveBeenCalledExactlyOnceWith(
      8453,
      expect.objectContaining({ factory: SAFE_FACTORY, saltNonce: 7n }),
      PROVEN_SAFE,
      expect.objectContaining({ sourceChainId: 1 }),
    )
    // The proof before the deployment and the deployment read one record.
    expect(fetch).toHaveBeenCalledExactlyOnceWith(creationUrl('eth'), expect.anything())
  })
})
