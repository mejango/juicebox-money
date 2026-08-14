import {
  decodeFunctionData,
  encodeFunctionData,
  encodeFunctionResult,
  getAddress,
  keccak256,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem'
import { describe, expect, it, vi } from 'vitest'
import {
  authorityIdentitiesMatch,
  isDeployableSafeAuthority,
  MAX_SAFE_OWNERS,
  SAFE_OWNERS_READ_GAS,
  readAuthorityIdentity,
  readMatchingAuthorityIdentities,
  safeCreationMatchesAuthorityIdentity,
  type AuthorityIdentity,
} from '@/lib/cross-chain-authority'
import {
  readBoundedSafeApprovedHash,
  SAFE_READ_ABI,
  SAFE_SCALAR_READ_GAS,
} from '@/lib/safe-reads'

const AUTHORITY = '0x1111111111111111111111111111111111111111' as Address
const ALICE = '0x2222222222222222222222222222222222222222' as Address
const BOB = '0x3333333333333333333333333333333333333333' as Address
const FALLBACK = '0xf48f2B2d2a534e402487b3ee7C18c33Aec0Fe5e4' as Address
const SINGLETON = '0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552' as Address
const OTHER_SINGLETON =
  '0x41675C099F32341bf84BFc5382aF534df5C7461a' as Address
const SENTINEL = '0x0000000000000000000000000000000000000001' as Address
const FACTORY = '0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2' as Address
const SINGLETON_SLOT = `0x${'0'.repeat(64)}` as Hex
const GUARD_SLOT =
  '0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8' as Hex
const FALLBACK_SLOT =
  '0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5' as Hex
const SINGLETON_CODE = '0x60006000' as Hex
const FALLBACK_CODE = '0x60016000' as Hex

const safeSetupAbi = [
  {
    type: 'function',
    name: 'setup',
    stateMutability: 'nonpayable',
    inputs: [
      { name: '_owners', type: 'address[]' },
      { name: '_threshold', type: 'uint256' },
      { name: 'to', type: 'address' },
      { name: 'data', type: 'bytes' },
      { name: 'fallbackHandler', type: 'address' },
      { name: 'paymentToken', type: 'address' },
      { name: 'payment', type: 'uint256' },
      { name: 'paymentReceiver', type: 'address' },
    ],
    outputs: [],
  },
] as const

function safeCreation({
  owners = [ALICE, BOB],
  threshold = 2n,
  to = zeroAddress,
  data = '0x' as Hex,
  factory = FACTORY,
}: {
  owners?: Address[]
  threshold?: bigint
  to?: Address
  data?: Hex
  factory?: Address
} = {}) {
  return {
    factory,
    singleton: SINGLETON,
    saltNonce: 7n,
    initializer: encodeFunctionData({
      abi: safeSetupAbi,
      functionName: 'setup',
      args: [
        owners,
        threshold,
        to,
        data,
        FALLBACK,
        zeroAddress,
        0n,
        zeroAddress,
      ],
    }),
  }
}

// Runtime returned by the canonical Safe v1.3.0 proxy factory's
// proxyCreationCode(). This is deliberately real proxy code: a small fake
// contract must not pass the production recognizer in these tests either.
const SAFE_PROXY_RUNTIME =
  '0x608060405273ffffffffffffffffffffffffffffffffffffffff600054167fa619486e0000000000000000000000000000000000000000000000000000000060003514156050578060005260206000f35b3660008037600080366000845af43d6000803e60008114156070573d6000fd5b3d6000f3fea2646970667358221220d1429297349653a4918076d650332de1a1068c5f3e07c5c82360c277770b955264736f6c63430007060033' as Hex

function storageAddress(address: Address): Hex {
  return `0x${'0'.repeat(24)}${address.slice(2)}` as Hex
}

type SafeClientOptions = {
  owners?: Address[]
  threshold?: bigint
  modules?: Address[]
  moduleNext?: Address
  singleton?: Address
  masterCopy?: Address
  singletonCode?: Hex
  version?: string
  guard?: Address
  fallbackHandler?: Address
  fallbackHandlerCode?: Hex
  proxyCode?: Hex
  contractOwners?: Address[]
  rejectRead?: boolean
  rejectBytecodeFor?: Address
}

function safeClient({
  owners = [ALICE, BOB],
  threshold = 2n,
  modules = [],
  moduleNext = SENTINEL,
  singleton = SINGLETON,
  masterCopy = singleton,
  singletonCode = SINGLETON_CODE,
  version = singleton.toLowerCase() === OTHER_SINGLETON.toLowerCase()
    ? '1.4.1'
    : '1.3.0',
  guard = zeroAddress,
  fallbackHandler = FALLBACK,
  fallbackHandlerCode = FALLBACK_CODE,
  proxyCode = SAFE_PROXY_RUNTIME,
  contractOwners = [],
  rejectRead = false,
  rejectBytecodeFor,
}: SafeClientOptions = {}): PublicClient {
  const contractOwnerSet = new Set(
    contractOwners.map(owner => owner.toLowerCase()),
  )
  return {
    getBytecode: vi.fn(async ({ address }: { address: Address }) => {
      if (
        rejectBytecodeFor &&
        address.toLowerCase() === rejectBytecodeFor.toLowerCase()
      ) {
        throw new Error('RPC unavailable')
      }
      if (address.toLowerCase() === AUTHORITY.toLowerCase()) return proxyCode
      if (address.toLowerCase() === singleton.toLowerCase()) return singletonCode
      if (
        address.toLowerCase() === fallbackHandler.toLowerCase() &&
        fallbackHandler.toLowerCase() !== zeroAddress
      ) {
        return fallbackHandlerCode
      }
      if (contractOwnerSet.has(address.toLowerCase())) return '0x6002'
      return undefined
    }),
    getStorageAt: vi.fn(async ({ slot }: { slot: Hex }) => {
      if (rejectRead) throw new Error('RPC unavailable')
      if (slot === SINGLETON_SLOT) return storageAddress(singleton)
      if (slot === GUARD_SLOT) return storageAddress(guard)
      if (slot === FALLBACK_SLOT) return storageAddress(fallbackHandler)
      throw new Error('Unexpected storage slot')
    }),
    request: vi.fn(async ({ method, params }) => {
      if (rejectRead) throw new Error('RPC unavailable')
      if (method !== 'eth_call') throw new Error('Unexpected RPC method')
      const request = params?.[0] as { data?: Hex }
      if (!request.data) throw new Error('Missing call data')
      const decoded = decodeFunctionData({
        abi: SAFE_READ_ABI,
        data: request.data,
      })
      if (decoded.functionName === 'getThreshold') {
        return encodeFunctionResult({
          abi: SAFE_READ_ABI,
          functionName: 'getThreshold',
          result: threshold,
        })
      }
      if (decoded.functionName === 'getOwners') {
        return encodeFunctionResult({
          abi: SAFE_READ_ABI,
          functionName: 'getOwners',
          result: owners,
        })
      }
      if (decoded.functionName === 'getModulesPaginated') {
        return encodeFunctionResult({
          abi: SAFE_READ_ABI,
          functionName: 'getModulesPaginated',
          result: [modules, moduleNext],
        })
      }
      if (decoded.functionName === 'masterCopy') {
        return encodeFunctionResult({
          abi: SAFE_READ_ABI,
          functionName: 'masterCopy',
          result: masterCopy,
        })
      }
      if (decoded.functionName === 'VERSION') {
        return encodeFunctionResult({
          abi: SAFE_READ_ABI,
          functionName: 'VERSION',
          result: version,
        })
      }
      throw new Error('Unexpected Safe read')
    }),
  } as unknown as PublicClient
}

function safeIdentity(
  overrides: Partial<Extract<AuthorityIdentity, { kind: 'safe' }>> = {},
): Extract<AuthorityIdentity, { kind: 'safe' }> {
  return {
    kind: 'safe',
    owners: [ALICE, BOB],
    threshold: 2,
    ownersAreEoas: true,
    hasModules: false,
    proxyCodeHash: keccak256(SAFE_PROXY_RUNTIME),
    singleton: SINGLETON,
    singletonCodeHash: keccak256(SINGLETON_CODE),
    version: '1.3.0',
    guard: zeroAddress,
    fallbackHandler: FALLBACK,
    fallbackHandlerCodeHash: keccak256(FALLBACK_CODE),
    ...overrides,
  }
}

describe('cross-chain authority identity', () => {
  it('reads Safe approvals through a gas- and returndata-bounded raw call', async () => {
    const hash = `0x${'ab'.repeat(32)}` as Hex
    const request = vi.fn(async () =>
      encodeFunctionResult({
        abi: SAFE_READ_ABI,
        functionName: 'approvedHashes',
        result: 1n,
      }),
    )
    const client = { request } as unknown as PublicClient

    await expect(
      readBoundedSafeApprovedHash(client, AUTHORITY, ALICE, hash),
    ).resolves.toBe(1n)
    expect(request).toHaveBeenCalledWith({
      method: 'eth_call',
      params: [
        expect.objectContaining({
          to: AUTHORITY,
          gas: `0x${SAFE_SCALAR_READ_GAS.toString(16)}`,
        }),
        'latest',
      ],
    })
  })

  it('bounds Safe-owner identity reads before nested bytecode fan-out', async () => {
    const owners = Array.from({ length: MAX_SAFE_OWNERS + 1 }, (_, index) =>
      getAddress(`0x${(index + 10).toString(16).padStart(40, '0')}`),
    )
    const atLimit = safeClient({
      owners: owners.slice(0, MAX_SAFE_OWNERS),
      threshold: 1n,
    })
    const atLimitIdentity = await readAuthorityIdentity(atLimit, AUTHORITY)
    expect(atLimitIdentity).toMatchObject({ kind: 'safe' })
    expect(
      atLimitIdentity?.kind === 'safe' ? atLimitIdentity.owners : [],
    ).toHaveLength(MAX_SAFE_OWNERS)
    expect(atLimit.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'eth_call',
        params: [
          expect.objectContaining({
            gas: `0x${SAFE_OWNERS_READ_GAS.toString(16)}`,
            to: AUTHORITY,
          }),
          'latest',
        ],
      }),
    )

    const overLimit = safeClient({ owners, threshold: 1n })
    await expect(readAuthorityIdentity(overLimit, AUTHORITY)).resolves.toEqual({
      kind: 'contract',
    })
    // Only the authority proxy itself is inspected. The oversized owner list
    // is rejected before singleton/fallback/owner bytecode fan-out begins.
    expect(overLimit.getBytecode).toHaveBeenCalledTimes(2)
  })

  it('replays only a recognized zero-side-effect initializer matching current policy', () => {
    const identity = safeIdentity()
    expect(isDeployableSafeAuthority(identity)).toBe(true)
    expect(safeCreationMatchesAuthorityIdentity(safeCreation(), identity)).toBe(
      true,
    )
    expect(
      safeCreationMatchesAuthorityIdentity(
        safeCreation({ owners: [ALICE], threshold: 1n }),
        identity,
      ),
    ).toBe(false)
    expect(
      safeCreationMatchesAuthorityIdentity(
        safeCreation({ to: AUTHORITY, data: '0x1234' }),
        identity,
      ),
    ).toBe(false)
    expect(
      safeCreationMatchesAuthorityIdentity(
        safeCreation({ factory: AUTHORITY }),
        identity,
      ),
    ).toBe(false)
    expect(
      safeCreationMatchesAuthorityIdentity(
        safeCreation(),
        safeIdentity({ hasModules: true }),
      ),
    ).toBe(false)
  })

  it('matches only EOAs or plain canonical Safes with identical policy', () => {
    const eoa: AuthorityIdentity = { kind: 'eoa' }
    const safe = safeIdentity()
    expect(authorityIdentitiesMatch(eoa, eoa)).toBe(true)
    expect(
      authorityIdentitiesMatch(safe, safeIdentity({ owners: [BOB, ALICE] })),
    ).toBe(true)
    expect(authorityIdentitiesMatch(safe, safeIdentity({ threshold: 1 }))).toBe(
      false,
    )
    expect(
      authorityIdentitiesMatch(safe, safeIdentity({ hasModules: true })),
    ).toBe(false)
    expect(
      authorityIdentitiesMatch(safe, safeIdentity({ ownersAreEoas: false })),
    ).toBe(false)
    expect(
      authorityIdentitiesMatch(safe, safeIdentity({ guard: ALICE })),
    ).toBe(false)
    expect(authorityIdentitiesMatch(safe, eoa)).toBe(false)
    expect(authorityIdentitiesMatch({ kind: 'contract' }, eoa)).toBe(false)
  })

  it('reads the canonical proxy, implementation, guard, fallback, and owner posture', async () => {
    const client = safeClient()
    await expect(readAuthorityIdentity(client, AUTHORITY)).resolves.toEqual(safeIdentity())
    const requestCalls = (
      client.request as unknown as {
        mock: { calls: Array<[{ params?: readonly unknown[] }]> }
      }
    ).mock.calls
    const delegatedReads = requestCalls.map(call =>
      decodeFunctionData({
        abi: SAFE_READ_ABI,
        data: (call[0].params?.[0] as { data: Hex }).data,
      }).functionName,
    )
    expect(delegatedReads[0]).toBe('masterCopy')
  })

  it('does not recognize a contract which only imitates the Safe owner API', async () => {
    await expect(
      readAuthorityIdentity(safeClient({ proxyCode: '0x1234' }), AUTHORITY),
    ).resolves.toEqual({ kind: 'contract' })
    const untrustedSingleton = safeClient({
      singleton: '0x4444444444444444444444444444444444444444',
    })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      readAuthorityIdentity(untrustedSingleton, AUTHORITY),
    ).resolves.toEqual({ kind: 'contract' })
    expect(untrustedSingleton.request).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('treats every failed authority, storage, and nested-code read as unknown', async () => {
    await expect(
      readAuthorityIdentity(
        {
          getBytecode: vi.fn().mockRejectedValue(new Error('RPC unavailable')),
        } as unknown as PublicClient,
        AUTHORITY,
      ),
    ).resolves.toBeNull()
    await expect(
      readAuthorityIdentity(safeClient({ rejectRead: true }), AUTHORITY),
    ).resolves.toBeNull()
    await expect(
      readAuthorityIdentity(
        safeClient({ rejectBytecodeFor: SINGLETON }),
        AUTHORITY,
      ),
    ).resolves.toBeNull()
  })

  it('fails parity for owner rotation, modules, guards, and contract owners', async () => {
    for (const destinationClient of [
      safeClient({ owners: [ALICE], threshold: 1n }),
      safeClient({ modules: [AUTHORITY] }),
      safeClient({ guard: ALICE }),
      safeClient({ contractOwners: [ALICE] }),
    ]) {
      await expect(
        readMatchingAuthorityIdentities({
          sourceClient: safeClient(),
          destinationClient,
          authority: AUTHORITY,
        }),
      ).resolves.toMatchObject({ matches: false })
    }
  })

  it('fails parity for implementation, version, proxy, or fallback divergence', async () => {
    for (const destinationClient of [
      safeClient({ singletonCode: '0x6003' }),
      safeClient({ version: '1.4.1' }),
      safeClient({
        singleton: OTHER_SINGLETON,
        singletonCode: SINGLETON_CODE,
      }),
      safeClient({ fallbackHandler: zeroAddress }),
      safeClient({ fallbackHandlerCode: '0x6004' }),
    ]) {
      await expect(
        readMatchingAuthorityIdentities({
          sourceClient: safeClient(),
          destinationClient,
          authority: AUTHORITY,
        }),
      ).resolves.toMatchObject({ matches: false })
    }
  })

  it('returns unknown instead of a mismatch when either chain cannot be read', async () => {
    await expect(
      readMatchingAuthorityIdentities({
        sourceClient: safeClient(),
        destinationClient: safeClient({ rejectRead: true }),
        authority: AUTHORITY,
      }),
    ).resolves.toBeNull()
  })

  it('accepts the same EOA only when both chains positively report no code', async () => {
    const eoaClient = {
      getBytecode: vi.fn().mockResolvedValue(undefined),
    } as unknown as PublicClient
    await expect(
      readMatchingAuthorityIdentities({
        sourceClient: eoaClient,
        destinationClient: eoaClient,
        authority: getAddress(AUTHORITY),
      }),
    ).resolves.toEqual({
      source: { kind: 'eoa' },
      destination: { kind: 'eoa' },
      matches: true,
    })
  })
})
