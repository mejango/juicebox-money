import { SAFE_SETUP_ABI } from '@bananapus/nana-sdk-core/safe'
import {
  concatHex,
  encodeFunctionData,
  encodePacked,
  getAddress,
  getContractAddress,
  keccak256,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem'
import { describe, expect, it, vi } from 'vitest'
import {
  isCanonicalSafeCreation,
  readAuthorityIdentity,
  readCrossChainHandleAuthority,
  readMatchingAuthorityIdentities,
  unprovenSafeLine,
} from '@/lib/cross-chain-authority'
import {
  creationRecord,
  creationUrl,
  OWNERS,
  PROVEN_SAFE,
  provenSafeChain,
} from '../support/proven-safe'
import {
  emptyChain,
  SAFE_130_EIP155_SINGLETON,
  SAFE_130_PROXY_RUNTIME,
  SAFE_130_SINGLETON,
  safeChain,
} from '../support/safe-chain'

// The SDK's own tests prove each identity rule; these prove this app's layer
// over it: the reads reach the SDK, and a Safe outside the canonical releases
// stays an unsupported contract here.

const AUTHORITY = '0x1111111111111111111111111111111111111111' as Address
const ALICE = '0x2222222222222222222222222222222222222222' as Address
const BOB = '0x3333333333333333333333333333333333333333' as Address
const FALLBACK = '0xf48f2B2d2a534e402487b3ee7C18c33Aec0Fe5e4' as Address
const DELEGATION = getAddress('0x63c0c19a282a1b52b07dd5a65b58948a07dae32b')
const EIP_7702_CODE = `0xef0100${DELEGATION.slice(2)}` as Hex

const safe = (options: Partial<Parameters<typeof safeChain>[0]> = {}) =>
  safeChain({ authority: AUTHORITY, owners: [ALICE, BOB], ...options })

describe('authority identity through the SDK', () => {
  it('reads a canonical Safe and its live policy', async () => {
    await expect(readAuthorityIdentity(safe(), AUTHORITY)).resolves.toEqual({
      kind: 'safe',
      owners: [ALICE, BOB],
      threshold: 2,
      ownersAreEoas: true,
      hasModules: false,
      modules: [],
      proxyCodeHash: keccak256(SAFE_130_PROXY_RUNTIME),
      singleton: SAFE_130_SINGLETON,
      singletonCodeHash: keccak256('0x60006000'),
      version: '1.3.0',
      guard: '0x0000000000000000000000000000000000000000',
      fallbackHandler: FALLBACK,
      fallbackHandlerCodeHash: keccak256('0x60016000'),
    })
  })

  it("reads a Safe on Safe 1.3.0's EIP-155 singleton as an unsupported contract", async () => {
    await expect(
      readAuthorityIdentity(safe({ singleton: SAFE_130_EIP155_SINGLETON }), AUTHORITY),
    ).resolves.toEqual({ kind: 'contract' })
  })

  it('does not recognize a contract that only imitates the Safe owner API', async () => {
    const imitation = safe({ proxyCode: '0x1234' })
    await expect(readAuthorityIdentity(imitation, AUTHORITY)).resolves.toEqual({
      kind: 'contract',
    })
    expect(imitation.request).not.toHaveBeenCalled()
  })

  it('reads an exact EIP-7702 designator as a delegated EOA, never a Safe', async () => {
    await expect(
      readAuthorityIdentity(emptyChain(EIP_7702_CODE), AUTHORITY),
    ).resolves.toEqual({ kind: 'delegated-eoa', delegation: DELEGATION })
  })

  it('reads a failed RPC as unknown', async () => {
    await expect(
      readAuthorityIdentity(safe({ unavailable: true }), AUTHORITY),
    ).resolves.toBeNull()
  })
})

describe('authority matching across chains', () => {
  it('matches the same EOA, plain or delegated, on both chains', async () => {
    for (const [sourceClient, destinationClient] of [
      [emptyChain(), emptyChain()],
      [emptyChain('0x'), emptyChain(EIP_7702_CODE)],
      [emptyChain(EIP_7702_CODE), emptyChain()],
    ]) {
      await expect(
        readMatchingAuthorityIdentities({
          sourceChainId: 8453,
          sourceClient,
          destinationClient,
          authority: AUTHORITY,
        }),
      ).resolves.toMatchObject({ matches: true })
    }
  })

  it('never matches a Safe to a delegated EOA at its address', async () => {
    await expect(
      readMatchingAuthorityIdentities({
        sourceChainId: 8453,
        sourceClient: safe(),
        destinationClient: emptyChain(EIP_7702_CODE),
        authority: AUTHORITY,
      }),
    ).resolves.toMatchObject({
      source: { kind: 'safe' },
      destination: { kind: 'delegated-eoa', delegation: DELEGATION },
      matches: false,
    })
  })

  it('does not match Safes whose live policies differ', async () => {
    for (const destinationClient of [
      safe({ owners: [ALICE], threshold: 1n }),
      safe({ modules: [BOB] }),
      safe({ guard: ALICE }),
      safe({ codes: { [ALICE]: '0x6002' } }),
      safe({ fallbackHandlerCode: '0x6004' }),
    ]) {
      await expect(
        readMatchingAuthorityIdentities({
          sourceChainId: 8453,
          sourceClient: safe(),
          destinationClient,
          authority: AUTHORITY,
        }),
      ).resolves.toMatchObject({ matches: false })
    }
  })

  it('does not match a Safe on a non-canonical release', async () => {
    await expect(
      readMatchingAuthorityIdentities({
        sourceChainId: 8453,
        sourceClient: safe({ singleton: SAFE_130_EIP155_SINGLETON }),
        destinationClient: safe({ singleton: SAFE_130_EIP155_SINGLETON }),
        authority: AUTHORITY,
      }),
    ).resolves.toEqual({
      source: { kind: 'contract' },
      destination: { kind: 'contract' },
      matches: false,
      creationUnproven: false,
    })
  })

  it('returns unknown rather than a mismatch when either chain cannot be read', async () => {
    await expect(
      readMatchingAuthorityIdentities({
        sourceChainId: 8453,
        sourceClient: safe(),
        destinationClient: safe({ unavailable: true }),
        authority: AUTHORITY,
      }),
    ).resolves.toBeNull()
  })
})

describe('canonical Safe creations', () => {
  const creation = {
    singleton: SAFE_130_SINGLETON,
    initializer: '0x' as Hex,
    saltNonce: 0n,
  }

  it("accepts the canonical factories and refuses Safe 1.3.0's EIP-155 deployment", () => {
    expect(
      isCanonicalSafeCreation({ ...creation, factory: '0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2' }),
    ).toBe(true)
    expect(
      isCanonicalSafeCreation({
        ...creation,
        factory: '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67',
        singleton: '0x29fcB43b46531BcA003ddC8FCB67FFE91900C762',
      }),
    ).toBe(true)
    expect(
      isCanonicalSafeCreation({ ...creation, factory: '0xC22834581EbC8527d974F8a1c97E1bEA4EF910BC' }),
    ).toBe(false)
    expect(
      isCanonicalSafeCreation({
        ...creation,
        factory: '0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2',
        singleton: SAFE_130_EIP155_SINGLETON,
      }),
    ).toBe(false)
  })
})

const answer = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('the creation proof cross-chain trust needs', () => {
  it("matches a Safe once its source chain's Safe service proves how it was made", async () => {
    const fetch = vi.fn(async () => answer(creationRecord()))

    await expect(
      readMatchingAuthorityIdentities({
        sourceChainId: 8453,
        sourceClient: provenSafeChain(),
        destinationClient: provenSafeChain(),
        authority: PROVEN_SAFE,
        service: { fetch },
      }),
    ).resolves.toMatchObject({ matches: true, creationUnproven: false })
    expect(fetch).toHaveBeenCalledExactlyOnceWith(creationUrl('base'), expect.anything())
  })

  it.each([
    ['its chain has no Safe service', 11155420, () => answer(creationRecord())],
    ['the service fails', 8453, () => answer({}, 500)],
    ['the service has no record', 8453, () => answer({}, 404)],
    ['the record makes another address', 8453, () => answer(creationRecord(8n))],
  ] as const)('never matches a Safe whose creation is unproven: %s', async (_, sourceChainId, reply) => {
    const fetch = vi.fn(async () => reply())

    await expect(
      readMatchingAuthorityIdentities({
        sourceChainId,
        sourceClient: provenSafeChain(),
        destinationClient: provenSafeChain(),
        authority: PROVEN_SAFE,
        service: { fetch },
      }),
    ).resolves.toMatchObject({
      source: { kind: 'safe' },
      destination: { kind: 'safe' },
      matches: false,
      creationUnproven: true,
    })
    if (sourceChainId === 11155420) expect(fetch).not.toHaveBeenCalled()
  })

  it("never takes a record from Safe 1.3.0's EIP-155 factory as proof", async () => {
    // A Safe on the canonical 1.3.0 singleton that the EIP-155 factory made:
    // the SDK proves it, and this app does not take that factory's word.
    const eip155Factory = '0xC22834581EbC8527d974F8a1c97E1bEA4EF910BC' as Address
    const initializer = encodeFunctionData({
      abi: SAFE_SETUP_ABI,
      functionName: 'setup',
      args: [OWNERS, 2n, zeroAddress, '0x', FALLBACK, zeroAddress, 0n, zeroAddress],
    })
    const safe130 = getContractAddress({
      opcode: 'CREATE2',
      from: eip155Factory,
      salt: keccak256(encodePacked(['bytes32', 'uint256'], [keccak256(initializer), 7n])),
      bytecode: concatHex([SAFE_130_PROXY_CREATION_CODE, toHex(BigInt(SAFE_130_SINGLETON), { size: 32 })]),
    })
    const chain = () => safeChain({ authority: safe130, owners: OWNERS })
    const fetch = vi.fn(async () =>
      answer({ factoryAddress: eip155Factory, masterCopy: SAFE_130_SINGLETON, setupData: initializer, saltNonce: '7' }),
    )

    await expect(
      readMatchingAuthorityIdentities({
        sourceChainId: 8453,
        sourceClient: chain(),
        destinationClient: chain(),
        authority: safe130,
        service: { fetch },
      }),
    ).resolves.toMatchObject({ matches: false, creationUnproven: true })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('asks no Safe service about an EOA', async () => {
    const fetch = vi.fn()

    await expect(
      readMatchingAuthorityIdentities({
        sourceChainId: 8453,
        sourceClient: emptyChain(),
        destinationClient: emptyChain(EIP_7702_CODE),
        authority: AUTHORITY,
        service: { fetch },
      }),
    ).resolves.toMatchObject({ matches: true, creationUnproven: false })
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('cross-chain handle authority', () => {
  const handleAuthority = (fetch: typeof globalThis.fetch, sourceClient = provenSafeChain()) =>
    readCrossChainHandleAuthority({
      sourceChainId: 8453,
      sourceClient,
      mainnetClient: provenSafeChain(),
      authority: PROVEN_SAFE,
      service: { fetch },
    })

  it('trusts a Safe on Ethereum only with the proof of how it was made', async () => {
    await expect(handleAuthority(vi.fn(async () => answer(creationRecord())))).resolves.toMatchObject({
      status: 'valid-safe',
      allowed: true,
    })
    await expect(handleAuthority(vi.fn(async () => answer({}, 404))).then(result => result.status)).resolves.toBe(
      'unproven-creation',
    )
  })

  it("reads a source Safe on Safe 1.3.0's EIP-155 singleton as an unsupported contract", async () => {
    await expect(
      handleAuthority(
        vi.fn(async () => answer(creationRecord())),
        provenSafeChain({ singleton: SAFE_130_EIP155_SINGLETON, version: '1.3.0' }),
      ),
    ).resolves.toMatchObject({ status: 'source-contract', allowed: false })
  })

  it("says it can't verify the Safe on the chain that would trust it", () => {
    expect(unprovenSafeLine(1)).toBe("Can't verify this Safe is the same on Ethereum.")
    expect(unprovenSafeLine(8453)).toBe("Can't verify this Safe is the same on Base.")
  })
})

// `GnosisSafeProxyFactory.proxyCreationCode()` of the 1.3.0 factories.
const SAFE_130_PROXY_CREATION_CODE =
  '0x608060405234801561001057600080fd5b506040516101e63803806101e68339818101604052602081101561003357600080fd5b8101908080519060200190929190505050600073ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff1614156100ca576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004018080602001828103825260228152602001806101c46022913960400191505060405180910390fd5b806000806101000a81548173ffffffffffffffffffffffffffffffffffffffff021916908373ffffffffffffffffffffffffffffffffffffffff1602179055505060ab806101196000396000f3fe608060405273ffffffffffffffffffffffffffffffffffffffff600054167fa619486e0000000000000000000000000000000000000000000000000000000060003514156050578060005260206000f35b3660008037600080366000845af43d6000803e60008114156070573d6000fd5b3d6000f3fea2646970667358221220d1429297349653a4918076d650332de1a1068c5f3e07c5c82360c277770b955264736f6c63430007060033496e76616c69642073696e676c65746f6e20616464726573732070726f7669646564' as Hex

// The fake chains are plain objects; only an explicit `service.fetch` answers.
vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('No network in this test'))))
