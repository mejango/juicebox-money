import { beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeErrorResult, encodeFunctionResult } from 'viem'
import {
  JBCoreContracts,
  jbContractAddress,
  jbControllerAbi,
  jbDirectoryAbi,
  jbProjectsAbi,
} from '@bananapus/nana-sdk-core'
import type { BsProject } from '@/lib/bendystraw'
import {
  getProjectPageData,
  readOnChainProject,
} from '@/lib/project-fallback'
import {
  creationRecord,
  creationUrl,
  PROVEN_SAFE,
  provenSafeChain,
} from '../support/proven-safe'
import { rpcAnswer } from '../support/safe-chain'

// Digit-only addresses so viem's checksumming round-trips them verbatim.
const OWNER = '0x1111111111111111111111111111111111111111'
const CONTROLLER = '0x2222222222222222222222222222222222222222'

function indexedProject(overrides: Partial<BsProject> = {}): BsProject {
  return {
    projectId: 7,
    chainId: 1,
    version: 6,
    name: 'Home',
    logoUri: null,
    projectTagline: null,
    volume: '0',
    volumeUsd: '0',
    balance: '0',
    paymentsCount: 0,
    contributorsCount: 0,
    createdAt: 1,
    suckerGroupId: 'group-a',
    token: null,
    tokenSymbol: null,
    decimals: null,
    currency: null,
    isRevnet: false,
    owner: OWNER,
    metadataUri: null,
    ...overrides,
  }
}

describe('project page data with on-chain fallback', () => {
  it('keeps indexed fields while reconciling current on-chain identity', async () => {
    const deps = {
      getProject: vi.fn().mockResolvedValue(indexedProject()),
      readOnChainProject: vi.fn().mockResolvedValue({
        owner: OWNER,
        metadataUri: 'ipfs://QmCurrent',
        metadataUriResolved: true,
      }),
    }

    await expect(getProjectPageData(1, 7, deps)).resolves.toEqual({
      project: indexedProject({ metadataUri: 'ipfs://QmCurrent' }),
      degraded: false,
    })
    expect(deps.readOnChainProject).toHaveBeenCalledWith(1, 7)
  })

  it('retains indexed metadata when the live metadata read is unavailable', async () => {
    const deps = {
      getProject: vi
        .fn()
        .mockResolvedValue(indexedProject({ metadataUri: 'ipfs://QmIndexed' })),
      readOnChainProject: vi.fn().mockResolvedValue({
        owner: OWNER,
        metadataUri: null,
        metadataUriResolved: false,
      }),
    }

    await expect(getProjectPageData(1, 7, deps)).resolves.toEqual({
      project: indexedProject({ metadataUri: 'ipfs://QmIndexed' }),
      degraded: false,
    })
  })

  it('falls back to on-chain identity when the project is not indexed yet', async () => {
    const deps = {
      getProject: vi.fn().mockResolvedValue(null),
      readOnChainProject: vi
        .fn()
        .mockResolvedValue({
          owner: OWNER,
          metadataUri: 'ipfs://QmShell',
          metadataUriResolved: true,
        }),
    }

    const result = await getProjectPageData(8453, 42, deps)

    expect(deps.readOnChainProject).toHaveBeenCalledWith(8453, 42)
    expect(result).toEqual({
      project: expect.objectContaining({
        chainId: 8453,
        projectId: 42,
        version: 6,
        owner: OWNER,
        metadataUri: 'ipfs://QmShell',
        name: null,
        suckerGroupId: null,
      }),
      degraded: true,
      reason: 'not-indexed',
    })
  })

  it('degrades instead of throwing when the indexer request fails', async () => {
    const deps = {
      getProject: vi.fn().mockRejectedValue(new Error('bendystraw 503')),
      readOnChainProject: vi
        .fn()
        .mockResolvedValue({
          owner: OWNER,
          metadataUri: null,
          metadataUriResolved: false,
        }),
    }

    await expect(getProjectPageData(1, 7, deps)).resolves.toEqual({
      project: expect.objectContaining({ owner: OWNER, metadataUri: null }),
      degraded: true,
      reason: 'indexer-error',
    })
  })

  it('returns null when neither the indexer nor the chain knows the project', async () => {
    const deps = {
      getProject: vi.fn().mockResolvedValue(null),
      readOnChainProject: vi.fn().mockResolvedValue(null),
    }

    await expect(getProjectPageData(1, 999_999, deps)).resolves.toBeNull()
  })

  it('keeps a dual outage distinguishable from a nonexistent project', async () => {
    const deps = {
      getProject: vi.fn().mockRejectedValue(new Error('bendystraw 503')),
      readOnChainProject: vi.fn().mockRejectedValue(new Error('rpc down')),
    }

    await expect(getProjectPageData(1, 7, deps)).rejects.toThrow('Project details are temporarily unavailable')
  })

  it('does not call a missing indexer record nonexistent when RPC is unavailable', async () => {
    await expect(getProjectPageData(1, 7, {
      getProject: vi.fn().mockResolvedValue(null),
      readOnChainProject: vi.fn().mockRejectedValue(new Error('RPC timeout with secret key')),
    })).rejects.toThrow('Project details are temporarily unavailable')
  })

  it('keeps indexed identity usable if only RPC reads fail', async () => {
    await expect(getProjectPageData(1, 7, {
      getProject: vi.fn().mockResolvedValue(indexedProject()),
      readOnChainProject: vi.fn().mockRejectedValue(new Error('RPC timeout')),
    })).resolves.toEqual({ project: indexedProject(), degraded: false })
  })
})

describe('on-chain project shell read', () => {
  const projectsAddress =
    jbContractAddress['6'][JBCoreContracts.JBProjects][1].toLowerCase()
  const directoryAddress =
    jbContractAddress['6'][JBCoreContracts.JBDirectory][1].toLowerCase()

  function rpcResponse(id: unknown, payload: Record<string, unknown>): Response {
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, ...payload }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  it('reads ownerOf, controllerOf, and uriOf over JSON-RPC', async () => {
    const fetchMock = vi.fn().mockImplementation(
      async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          id: unknown
          params: [{ to: string }]
        }
        const to = body.params[0].to.toLowerCase()
        const result =
          to === projectsAddress
            ? encodeFunctionResult({
                abi: jbProjectsAbi,
                functionName: 'ownerOf',
                result: OWNER,
              })
            : to === directoryAddress
              ? encodeFunctionResult({
                  abi: jbDirectoryAbi,
                  functionName: 'controllerOf',
                  result: CONTROLLER,
                })
              : encodeFunctionResult({
                  abi: jbControllerAbi,
                  functionName: 'uriOf',
                  result: 'ipfs://QmShell',
                })
        return rpcResponse(body.id, { result })
      },
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(readOnChainProject(1, 7)).resolves.toEqual({
      owner: OWNER,
      metadataUri: 'ipfs://QmShell',
      metadataUriResolved: true,
    })
    const targets = fetchMock.mock.calls.map(call =>
      (
        JSON.parse(String((call[1] as RequestInit).body)) as {
          params: [{ to: string }]
        }
      ).params[0].to.toLowerCase(),
    )
    expect(targets).toEqual([
      projectsAddress,
      directoryAddress,
      CONTROLLER.toLowerCase(),
    ])
  })

  it('treats an explicit nonexistent-token revert as project-not-found', async () => {
    const fetchMock = vi.fn().mockImplementation(
      async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { id: unknown }
        return rpcResponse(body.id, {
          error: { code: 3, message: 'execution reverted', data: encodeErrorResult({ abi: jbProjectsAbi, errorName: 'ERC721NonexistentToken', args: [999_999n] }) },
        })
      },
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(readOnChainProject(1, 999_999)).resolves.toBeNull()
  })

  it.each([
    { code: 3, message: 'execution reverted', data: '0x' },
    { code: -32603, message: 'RPC endpoint unavailable' },
  ])('keeps generic reverts and RPC failures as unknown identity', async error => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const { id } = JSON.parse(String(init?.body)) as { id: unknown }
      return rpcResponse(id, { error })
    }))
    await expect(readOnChainProject(1, 7)).rejects.toThrow('Project identity is temporarily unavailable')
  })

  it('keeps the project shell when only the metadata reads fail', async () => {
    const fetchMock = vi.fn().mockImplementation(
      async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          id: unknown
          params: [{ to: string }]
        }
        const to = body.params[0].to.toLowerCase()
        if (to === projectsAddress) {
          return rpcResponse(body.id, {
            result: encodeFunctionResult({
              abi: jbProjectsAbi,
              functionName: 'ownerOf',
              result: OWNER,
            }),
          })
        }
        return rpcResponse(body.id, {
          error: { code: 3, message: 'execution reverted', data: '0x' },
        })
      },
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(readOnChainProject(1, 7)).resolves.toEqual({
      owner: OWNER,
      metadataUri: null,
      metadataUriResolved: false,
    })
  })
})

describe('handle authority on the server', () => {
  // Ethereum and the project's chain show PROVEN_SAFE with one policy, read
  // over JSON-RPC; only its creation record from the Safe service decides.
  // The server keeps creation records per chain and Safe; each test starts with none.
  let projectAuthorityMatchesMainnet: typeof import('@/lib/project-fallback').projectAuthorityMatchesMainnet
  beforeEach(async () => {
    vi.resetModules()
    ;({ projectAuthorityMatchesMainnet } = await import('@/lib/project-fallback'))
  })
  function serve(service: (url: string) => Response) {
    const chains = { 1: provenSafeChain(), 8453: provenSafeChain(), 11155420: provenSafeChain() }
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
      (await rpcAnswer(chains, input, init)) ?? service(String(input)),
    )
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }
  const answer = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

  it("trusts a Safe on another chain once its chain's Safe service proves how it was made", async () => {
    const fetchMock = serve(url => (url === creationUrl('base') ? answer(creationRecord()) : answer({}, 404)))

    await expect(
      projectAuthorityMatchesMainnet({ chainId: 8453, authority: PROVEN_SAFE }),
    ).resolves.toBe(true)
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toContain(creationUrl('base'))
  })

  it.each([
    ['its chain has no Safe service', 11155420, () => answer(creationRecord())],
    ['the Safe service fails', 8453, () => answer({}, 503)],
    ['the request to the Safe service fails', 8453, () => { throw new TypeError('fetch failed') }],
    ['the Safe service is rate limited', 8453, () => answer({}, 429, { 'retry-after': '60' })],
    ['the Safe service asks for a second', 8453, () => answer({}, 429, { 'retry-after': '1' })],
    ['the Safe service is rate limited without saying for how long', 8453, () => answer({}, 429)],
  ] as const)('returns unproven, never trusted, when %s', async (_, chainId, service) => {
    const fetchMock = serve(service)

    await expect(
      projectAuthorityMatchesMainnet({ chainId, authority: PROVEN_SAFE }),
    ).resolves.toBe(false)
    // The Safe was read on both chains: the creation proof alone refused it.
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith(`/v1/rpc/${chainId}`))).toBe(true)
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/v1/rpc/1'))).toBe(true)
    // A page render asks the service once and never waits for it.
    expect(fetchMock.mock.calls.filter(([input]) => String(input).includes('/creation/')).length)
      .toBeLessThanOrEqual(1)
  })

  it("asks Safe's service once across renders for a record that proves the Safe, and again after a minute for a missing one", async () => {
    vi.useFakeTimers()
    let record = true
    const fetchMock = serve(url =>
      url === creationUrl('base') && record ? answer(creationRecord()) : answer({}, 404),
    )
    const creationReads = () =>
      fetchMock.mock.calls.filter(([input]) => String(input) === creationUrl('base')).length

    for (let render = 0; render < 3; render += 1) {
      await expect(
        projectAuthorityMatchesMainnet({ chainId: 8453, authority: PROVEN_SAFE }),
      ).resolves.toBe(true)
    }
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    await projectAuthorityMatchesMainnet({ chainId: 8453, authority: PROVEN_SAFE })
    expect(creationReads()).toBe(1)

    vi.resetModules()
    ;({ projectAuthorityMatchesMainnet } = await import('@/lib/project-fallback'))
    record = false
    await expect(
      projectAuthorityMatchesMainnet({ chainId: 8453, authority: PROVEN_SAFE }),
    ).resolves.toBe(false)
    await projectAuthorityMatchesMainnet({ chainId: 8453, authority: PROVEN_SAFE })
    expect(creationReads()).toBe(2)
    await vi.advanceTimersByTimeAsync(61_000)
    await projectAuthorityMatchesMainnet({ chainId: 8453, authority: PROVEN_SAFE })
    expect(creationReads()).toBe(3)
  })
})
