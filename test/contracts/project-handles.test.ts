import {
  decodeFunctionData,
  encodeFunctionData,
  encodeFunctionResult,
  type Address,
  type PublicClient,
} from 'viem'
import { namehash } from 'viem/ens'
import { describe, expect, it, vi } from 'vitest'
import {
  MAX_LIVE_REVNET_OPERATOR_CANDIDATES,
  MAX_PERMISSION_HISTORY_LOGS,
  liveProjectAuthorityFrom,
  revnetOperatorFromPermissionHistoryFrom,
} from '@/lib/project-fallback'
import {
  ENS_NAME_WRAPPER_ADDRESS,
  ENS_REGISTRY_ADDRESS,
  PROJECT_HANDLES_ADDRESS,
  PROJECT_HANDLE_READ_GAS,
  PROJECT_HANDLE_RESOLVER_MAX_RETURN_BYTES,
  PROJECT_HANDLE_RESOLVER_READ_GAS,
  PROJECT_HANDLE_TEXT_KEY,
  buildSetEnsProjectRecordCall,
  buildSetProjectHandleCall,
  canonicalProjectHandle,
  continueProjectHandleSetup,
  decodeProjectRouteSegment,
  directEnsTextReadRequest,
  ensTextResolverAbi,
  jbProjectHandlesAbi,
  normalizeProjectHandle,
  parseProjectHandleRecord,
  projectHandleFromRoute,
  projectHandleMatches,
  projectHandleRecord,
  projectHandleSetupPhase,
  projectRouteSegmentFromPathname,
  readDirectEnsProjectRecord,
  readBoundedProjectHandle,
  verifyProjectHandleAuthorityWithFallback,
} from '@/lib/project-handles'

const PROJECTS = '0x1111111111111111111111111111111111111111' as Address
const OWNER = '0x2222222222222222222222222222222222222222' as Address
const OPERATOR = '0x3333333333333333333333333333333333333333' as Address
const REV_OWNER = '0x4444444444444444444444444444444444444444' as Address
const RESOLVER = '0x5555555555555555555555555555555555555555' as Address
const SAFE = '0x6666666666666666666666666666666666666666' as Address
const CURRENT_OPERATOR =
  '0x7777777777777777777777777777777777777777' as Address
const PERMISSIONS = '0x8888888888888888888888888888888888888888' as Address

describe('project handle normalization and routing', () => {
  it('accepts an arbitrary project-controlled .eth name', () => {
    expect(normalizeProjectHandle('banny.eth')).toEqual({
      handle: 'banny',
      ensName: 'banny.eth',
      parts: ['banny'],
    })
  })

  it('normalizes the URL/ENS forms and reverses labels for the contract', () => {
    expect(normalizeProjectHandle('@Design.Juicebox.eth')).toEqual({
      handle: 'design.juicebox',
      ensName: 'design.juicebox.eth',
      parts: ['juicebox', 'design'],
    })
    expect(projectHandleFromRoute('@design.juicebox')).toEqual({
      handle: 'design.juicebox',
      ensName: 'design.juicebox.eth',
      parts: ['juicebox', 'design'],
    })
    expect(projectHandleFromRoute('design.juicebox')).toBeNull()
    expect(
      projectHandleFromRoute(decodeProjectRouteSegment('%40design.juicebox')!),
    ).toEqual({
      handle: 'design.juicebox',
      ensName: 'design.juicebox.eth',
      parts: ['juicebox', 'design'],
    })
    expect(decodeProjectRouteSegment('%2540design.juicebox')).toBe(
      '%40design.juicebox',
    )
    expect(decodeProjectRouteSegment('%E0%A4%A')).toBeNull()
  })

  it('decodes client pathnames once, including Unicode, and rejects double encoding', () => {
    expect(projectRouteSegmentFromPathname('/@design.juicebox')).toBe(
      '@design.juicebox',
    )
    const unicode = projectRouteSegmentFromPathname(
      '/%40caf%C3%A9.juicebox',
    )
    expect(unicode).toBe('@café.juicebox')
    expect(projectHandleFromRoute(unicode!)?.handle).toBe('café.juicebox')
    expect(
      projectRouteSegmentFromPathname('/%2540design.juicebox'),
    ).toBeNull()
    expect(projectRouteSegmentFromPathname('/base:7/owner')).toBeNull()
  })

  it.each(['', '@', 'foo..eth', 'foo.eth.eth', '@foo eth']) (
    'rejects a contract-incompatible handle (%s)',
    value => expect(normalizeProjectHandle(value)).toBeNull(),
  )

  it('parses only exact positive safe-integer ENS project records', () => {
    expect(projectHandleRecord(8453, 42)).toBe('8453:42')
    expect(parseProjectHandleRecord('8453:42')).toEqual({
      chainId: 8453,
      projectId: 42,
    })
    for (const record of [
      ' 8453:42',
      '8453:42 ',
      '8453 :42',
      '0:42',
      '1:0',
      '1:-2',
      '1:2.5',
      '9007199254740992:1',
    ]) {
      expect(parseProjectHandleRecord(record)).toBeNull()
    }
  })

  it('resumes at the first unverified half of the bidirectional claim', () => {
    const state = (textRecord: string | null, verifiedHandle: string | null) =>
      projectHandleSetupPhase({
        expectedRecord: '8453:42',
        textRecord,
        requestedHandle: 'banny',
        verifiedHandle,
      })

    expect(state(null, null)).toBe('ens-record')
    expect(state('1:42', 'banny')).toBe('ens-record')
    expect(state('8453:42', null)).toBe('authority-claim')
    expect(state('8453:42', 'another-name')).toBe('authority-claim')
    expect(state('8453:42', 'banny')).toBe('verified')
  })

  it('runs both phases once and resumes after a queued Safe phase', async () => {
    const ensureEnsRecord = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true)
    const ensureAuthorityClaim = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true)

    await expect(
      continueProjectHandleSetup({
        ensureEnsRecord,
        ensureAuthorityClaim,
      }),
    ).resolves.toBe('ens-pending')
    expect(ensureAuthorityClaim).not.toHaveBeenCalled()

    await expect(
      continueProjectHandleSetup({
        ensureEnsRecord,
        ensureAuthorityClaim,
      }),
    ).resolves.toBe('authority-pending')

    await expect(
      continueProjectHandleSetup({
        ensureEnsRecord,
        ensureAuthorityClaim,
      }),
    ).resolves.toBe('verified')
    expect(ensureEnsRecord).toHaveBeenCalledTimes(3)
    expect(ensureAuthorityClaim).toHaveBeenCalledTimes(2)
  })

  it('rejects an ENS-only spoof without the matching reverse claim', () => {
    // A valid forward record is only a candidate route.
    expect(parseProjectHandleRecord('1:42')).toEqual({ chainId: 1, projectId: 42 })
    expect(projectHandleMatches('design.juicebox', null)).toBe(false)
    expect(projectHandleMatches('design.juicebox', 'other.juicebox')).toBe(false)
    expect(projectHandleMatches('design.juicebox', 'design.juicebox')).toBe(true)
    expect(projectHandleMatches('design.juicebox', 'Design.Juicebox')).toBe(false)
    expect(projectHandleMatches('design.juicebox', 'design.juicebox.eth')).toBe(
      false,
    )
    expect(canonicalProjectHandle('design.juicebox')).toBe('design.juicebox')
    expect(canonicalProjectHandle('Design.Juicebox')).toBeNull()
  })

  it('bounds the raw canonical handle read before ABI decoding', async () => {
    const request = vi.fn().mockResolvedValue(
      encodeFunctionResult({
        abi: jbProjectHandlesAbi,
        functionName: 'handleOf',
        result: 'design.juicebox',
      }),
    )
    await expect(
      readBoundedProjectHandle(
        { request } as unknown as PublicClient,
        { chainId: 8453, projectId: 42, setter: OPERATOR },
      ),
    ).resolves.toBe('design.juicebox')
    expect(request).toHaveBeenCalledWith({
      method: 'eth_call',
      params: [
        expect.objectContaining({
          to: PROJECT_HANDLES_ADDRESS,
          gas: `0x${PROJECT_HANDLE_READ_GAS.toString(16)}`,
        }),
        'latest',
      ],
    })

    request.mockResolvedValueOnce(
      encodeFunctionResult({
        abi: jbProjectHandlesAbi,
        functionName: 'handleOf',
        result: 'x'.repeat(300),
      }),
    )
    await expect(
      readBoundedProjectHandle(
        { request } as unknown as PublicClient,
        { chainId: 8453, projectId: 42, setter: OPERATOR },
      ),
    ).resolves.toBeNull()
  })

  it('does not scan history when a known live authority has another handle', async () => {
    const recoverAuthority = vi.fn()
    await expect(
      verifyProjectHandleAuthorityWithFallback({
        requestedHandle: 'design.juicebox',
        authorityContext: { authority: OPERATOR, isRevnet: true },
        lookupHandle: vi.fn().mockResolvedValue('another.juicebox'),
        recoverAuthority,
      }),
    ).resolves.toBeNull()
    expect(recoverAuthority).not.toHaveBeenCalled()
  })

  it('uses permission history only when no live authority candidate was found', async () => {
    const recoverAuthority = vi.fn().mockResolvedValue({
      authority: CURRENT_OPERATOR,
      isRevnet: true,
    })
    await expect(
      verifyProjectHandleAuthorityWithFallback({
        requestedHandle: 'design.juicebox',
        authorityContext: null,
        lookupHandle: vi.fn().mockResolvedValue('design.juicebox'),
        recoverAuthority,
      }),
    ).resolves.toEqual({ authority: CURRENT_OPERATOR, isRevnet: true })
    expect(recoverAuthority).toHaveBeenCalledTimes(1)
  })
})

describe('project handle transaction payloads', () => {
  it('encodes the exact ENS text record on the exact resolver', () => {
    const call = buildSetEnsProjectRecordCall({
      resolver: RESOLVER,
      ensName: 'banny.eth',
      chainId: 8453,
      projectId: 42,
    })
    expect(call.target).toBe(RESOLVER)
    expect(
      decodeFunctionData({ abi: ensTextResolverAbi, data: call.data }),
    ).toEqual({
      functionName: 'setText',
      args: [
        namehash('banny.eth'),
        PROJECT_HANDLE_TEXT_KEY,
        '8453:42',
      ],
    })
  })

  it('encodes one canonical project tuple and reversed name parts', () => {
    const call = buildSetProjectHandleCall({
      chainId: 8453,
      projectId: 42,
      parts: ['banny'],
    })
    expect(call.target).toBe(PROJECT_HANDLES_ADDRESS)
    expect(
      decodeFunctionData({ abi: jbProjectHandlesAbi, data: call.data }),
    ).toEqual({
      functionName: 'setEnsNamePartsFor',
      args: [8453n, 42n, ['banny']],
    })
  })
})

describe('live handle authorities', () => {
  it('fails closed before live-call fanout on an oversized permission window', async () => {
    const readContract = vi.fn()
    const logs = Array.from(
      { length: MAX_PERMISSION_HISTORY_LOGS + 1 },
      (_, index) => ({
        args: {
          operator: `0x${(index + 10).toString(16).padStart(40, '0')}` as Address,
        },
      }),
    )
    await expect(
      revnetOperatorFromPermissionHistoryFrom({
        client: {
          getBlockNumber: vi.fn().mockResolvedValue(25_700_000n),
          getLogs: vi.fn().mockResolvedValue(logs),
          readContract,
        } as unknown as PublicClient,
        chainId: 1,
        projectId: 42,
        canonicalRevOwner: REV_OWNER,
        permissions: PERMISSIONS,
      }),
    ).resolves.toBeNull()
    expect(readContract).not.toHaveBeenCalled()
  })

  it('rejects an oversized indexed candidate set before operator-call fanout', async () => {
    const readContract = vi.fn().mockResolvedValueOnce(REV_OWNER)
    const candidates = Array.from(
      { length: MAX_LIVE_REVNET_OPERATOR_CANDIDATES + 1 },
      (_, index) =>
        `0x${(index + 10).toString(16).padStart(40, '0')}` as Address,
    )
    await expect(
      liveProjectAuthorityFrom({
        client: { readContract } as unknown as PublicClient,
        projects: PROJECTS,
        canonicalRevOwner: REV_OWNER,
        projectId: 42,
        revnetOperatorCandidates: candidates,
      }),
    ).resolves.toBeNull()
    expect(readContract).toHaveBeenCalledTimes(1)
  })

  it('discovers the live operator from authoritative permission history', async () => {
    const getLogs = vi
      .fn()
      .mockResolvedValueOnce([{ args: { operator: OPERATOR } }])
      .mockResolvedValueOnce([{ args: { operator: CURRENT_OPERATOR } }])
    const readContract = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
    await expect(
      revnetOperatorFromPermissionHistoryFrom({
        client: {
          getBlockNumber: vi.fn().mockResolvedValue(25_700_000n),
          getLogs,
          readContract,
        } as unknown as PublicClient,
        chainId: 1,
        projectId: 42,
        canonicalRevOwner: REV_OWNER,
        permissions: PERMISSIONS,
      }),
    ).resolves.toBe(CURRENT_OPERATOR)
    expect(getLogs).toHaveBeenCalledWith(
      expect.objectContaining({
        address: PERMISSIONS,
        args: { account: REV_OWNER, projectId: 42n },
        fromBlock: 25_450_001n,
        toBlock: 25_700_000n,
        strict: true,
      }),
    )
  })

  it('uses the live custom-project NFT owner without an indexed fallback', async () => {
    const readContract = vi.fn().mockResolvedValue(OWNER)
    const authority = await liveProjectAuthorityFrom({
      client: { readContract } as unknown as PublicClient,
      projects: PROJECTS,
      canonicalRevOwner: REV_OWNER,
      projectId: 42,
      revnetOperatorCandidate: OPERATOR,
    })
    expect(authority).toBe(OWNER)
    expect(readContract).toHaveBeenCalledTimes(1)
  })

  it('rejects a stale revnet operator and accepts only a live one', async () => {
    const staleClient = {
      readContract: vi
        .fn()
        .mockResolvedValueOnce(REV_OWNER)
        .mockResolvedValueOnce(false),
    } as unknown as PublicClient
    await expect(
      liveProjectAuthorityFrom({
        client: staleClient,
        projects: PROJECTS,
        canonicalRevOwner: REV_OWNER,
        projectId: 42,
        revnetOperatorCandidate: OPERATOR,
      }),
    ).resolves.toBeNull()

    const liveClient = {
      readContract: vi
        .fn()
        .mockResolvedValueOnce(REV_OWNER)
        .mockResolvedValueOnce(true),
    } as unknown as PublicClient
    await expect(
      liveProjectAuthorityFrom({
        client: liveClient,
        projects: PROJECTS,
        canonicalRevOwner: REV_OWNER,
        projectId: 42,
        revnetOperatorCandidate: OPERATOR,
      }),
    ).resolves.toBe(OPERATOR)
  })

  it('checks past a stale indexed operator to the one that is live', async () => {
    const client = {
      readContract: vi
        .fn()
        .mockResolvedValueOnce(REV_OWNER)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true),
    } as unknown as PublicClient

    await expect(
      liveProjectAuthorityFrom({
        client,
        projects: PROJECTS,
        canonicalRevOwner: REV_OWNER,
        projectId: 42,
        revnetOperatorCandidates: [OPERATOR, CURRENT_OPERATOR, OPERATOR],
      }),
    ).resolves.toBe(CURRENT_OPERATOR)
  })

  it('derives the Safe controller of a wrapped ENS name', async () => {
    const readContract = vi.fn(async (request: { address: Address; functionName: string }) => {
      if (request.address === ENS_REGISTRY_ADDRESS && request.functionName === 'resolver') {
        return RESOLVER
      }
      if (request.address === ENS_REGISTRY_ADDRESS && request.functionName === 'owner') {
        return ENS_NAME_WRAPPER_ADDRESS
      }
      if (request.address === ENS_NAME_WRAPPER_ADDRESS) return SAFE
      throw new Error('Unexpected read')
    })
    const request = vi.fn().mockResolvedValue(
      encodeFunctionResult({
        abi: ensTextResolverAbi,
        functionName: 'text',
        result: '8453:42',
      }),
    )
    const getBlockNumber = vi.fn().mockResolvedValue(123n)
    await expect(
      readDirectEnsProjectRecord(
        { getBlockNumber, readContract, request } as unknown as PublicClient,
        'design.juicebox.eth',
      ),
    ).resolves.toEqual({
      resolver: RESOLVER,
      controller: SAFE,
      textRecord: '8453:42',
    })

    const node = namehash('design.juicebox.eth')
    expect(directEnsTextReadRequest(RESOLVER, node)).toEqual({
      ccipRead: false,
      account: PROJECT_HANDLES_ADDRESS,
      to: RESOLVER,
      data: encodeFunctionData({
        abi: ensTextResolverAbi,
        functionName: 'text',
        args: [node, PROJECT_HANDLE_TEXT_KEY],
      }),
      gas: PROJECT_HANDLE_RESOLVER_READ_GAS,
      batch: false,
    })
    expect(request).toHaveBeenCalledWith(
      {
        method: 'eth_call',
        params: [
          expect.objectContaining({
            to: RESOLVER,
            from: PROJECT_HANDLES_ADDRESS,
            gas: '0x1e848',
          }),
          '0x7b',
        ],
      },
      undefined,
    )
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({ blockNumber: 123n }),
    )
  })

  it('rejects oversized resolver returndata before ABI decoding', async () => {
    const readContract = vi.fn(async (request: { functionName: string }) => {
      if (request.functionName === 'resolver') return RESOLVER
      if (request.functionName === 'owner') return OWNER
      throw new Error('Unexpected read')
    })
    const request = vi.fn().mockResolvedValue(
      `0x${'00'.repeat(PROJECT_HANDLE_RESOLVER_MAX_RETURN_BYTES + 1)}`,
    )

    await expect(
      readDirectEnsProjectRecord(
        {
          getBlockNumber: vi.fn().mockResolvedValue(123n),
          readContract,
          request,
        } as unknown as PublicClient,
        'design.juicebox.eth',
      ),
    ).resolves.toEqual({
      resolver: RESOLVER,
      controller: OWNER,
      textRecord: null,
    })
  })

  it('rejects a nonstandard ABI offset that Viem would otherwise decode', async () => {
    const readContract = vi.fn(async (request: { functionName: string }) => {
      if (request.functionName === 'resolver') return RESOLVER
      if (request.functionName === 'owner') return OWNER
      throw new Error('Unexpected read')
    })
    const ordinary = encodeFunctionResult({
      abi: ensTextResolverAbi,
      functionName: 'text',
      result: '8453:42',
    })
    const request = vi.fn().mockResolvedValue(
      `0x${'0'.repeat(62)}40${'00'.repeat(32)}${ordinary.slice(66)}`,
    )

    await expect(
      readDirectEnsProjectRecord(
        {
          getBlockNumber: vi.fn().mockResolvedValue(123n),
          readContract,
          request,
        } as unknown as PublicClient,
        'design.juicebox.eth',
      ),
    ).resolves.toMatchObject({ textRecord: null })
  })
})
