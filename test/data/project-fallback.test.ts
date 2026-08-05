import { describe, expect, it, vi } from 'vitest'
import { encodeFunctionResult } from 'viem'
import {
  JBCoreContracts,
  jbContractAddress,
  jbControllerAbi,
  jbDirectoryAbi,
  jbProjectsAbi,
} from '@bananapus/nana-sdk-core'
import type { BsProject } from '@/lib/bendystraw'
import { getProjectPageData, readOnChainProject } from '@/lib/project-fallback'

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

  it('never throws even when the indexer and the RPC read both fail', async () => {
    const deps = {
      getProject: vi.fn().mockRejectedValue(new Error('bendystraw 503')),
      readOnChainProject: vi.fn().mockRejectedValue(new Error('rpc down')),
    }

    await expect(getProjectPageData(1, 7, deps)).resolves.toBeNull()
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

  it('treats an ownerOf revert as project-not-found', async () => {
    const fetchMock = vi.fn().mockImplementation(
      async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { id: unknown }
        return rpcResponse(body.id, {
          error: { code: 3, message: 'execution reverted', data: '0x' },
        })
      },
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(readOnChainProject(1, 999_999)).resolves.toBeNull()
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
