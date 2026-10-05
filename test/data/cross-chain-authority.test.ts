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
  SAFE_130_SINGLETON,
  safeChain,
} from '../support/safe-chain'

// The SDK's own tests prove each identity rule; these prove this app's layer
// over it: both chains reach the SDK, with the creation record from the
// source chain's Safe service, for every Safe release the SDK recognizes.

const AUTHORITY = '0x1111111111111111111111111111111111111111' as Address
const ALICE = '0x2222222222222222222222222222222222222222' as Address
const BOB = '0x3333333333333333333333333333333333333333' as Address
const FALLBACK = '0xf48f2B2d2a534e402487b3ee7C18c33Aec0Fe5e4' as Address
const DELEGATION = getAddress('0x63c0c19a282a1b52b07dd5a65b58948a07dae32b')
const EIP_7702_CODE = `0xef0100${DELEGATION.slice(2)}` as Hex

const safe = (options: Partial<Parameters<typeof safeChain>[0]> = {}) =>
  safeChain({ authority: AUTHORITY, owners: [ALICE, BOB], ...options })

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

  it.each([
    ['the canonical singleton', SAFE_130_SINGLETON],
    ['its own EIP-155 singleton', SAFE_130_EIP155_SINGLETON],
  ])("takes a record from Safe 1.3.0's EIP-155 factory on %s as proof", async (_, singleton) => {
    const safe130 = eip155Safe(singleton)
    const fetch = vi.fn(async () => answer(safe130.record))

    await expect(
      readMatchingAuthorityIdentities({
        sourceChainId: 8453,
        sourceClient: safe130.chain(),
        destinationClient: safe130.chain(),
        authority: safe130.address,
        service: { fetch },
      }),
    ).resolves.toMatchObject({
      source: { kind: 'safe', singleton },
      matches: true,
      creationUnproven: false,
    })
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

  it("trusts a Safe from Safe 1.3.0's EIP-155 deployment on Ethereum once its creation is proven", async () => {
    const safe130 = eip155Safe(SAFE_130_EIP155_SINGLETON)

    await expect(
      readCrossChainHandleAuthority({
        sourceChainId: 8453,
        sourceClient: safe130.chain(),
        mainnetClient: safe130.chain(),
        authority: safe130.address,
        service: { fetch: vi.fn(async () => answer(safe130.record)) },
      }),
    ).resolves.toMatchObject({ status: 'valid-safe', allowed: true })
  })

  it("says it can't verify the Safe on the chain that would trust it", () => {
    expect(unprovenSafeLine(1)).toBe("Can't verify this Safe is the same on Ethereum.")
    expect(unprovenSafeLine(8453)).toBe("Can't verify this Safe is the same on Base.")
  })
})

/**
 * A Safe 1.3.0 that the EIP-155 factory made on `singleton`, owned by OWNERS
 * 2 of 2, with the creation record that proves its address.
 */
function eip155Safe(singleton: Address) {
  const factory = '0xC22834581EbC8527d974F8a1c97E1bEA4EF910BC' as Address
  const initializer = encodeFunctionData({
    abi: SAFE_SETUP_ABI,
    functionName: 'setup',
    args: [OWNERS, 2n, zeroAddress, '0x', FALLBACK, zeroAddress, 0n, zeroAddress],
  })
  const address = getContractAddress({
    opcode: 'CREATE2',
    from: factory,
    salt: keccak256(encodePacked(['bytes32', 'uint256'], [keccak256(initializer), 7n])),
    bytecode: concatHex([SAFE_130_PROXY_CREATION_CODE, toHex(BigInt(singleton), { size: 32 })]),
  })
  return {
    address,
    chain: () => safeChain({ authority: address, owners: OWNERS, singleton }),
    record: { factoryAddress: factory, masterCopy: singleton, setupData: initializer, saltNonce: '7' },
  }
}

// `GnosisSafeProxyFactory.proxyCreationCode()` of the 1.3.0 factories.
const SAFE_130_PROXY_CREATION_CODE =
  '0x608060405234801561001057600080fd5b506040516101e63803806101e68339818101604052602081101561003357600080fd5b8101908080519060200190929190505050600073ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff1614156100ca576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004018080602001828103825260228152602001806101c46022913960400191505060405180910390fd5b806000806101000a81548173ffffffffffffffffffffffffffffffffffffffff021916908373ffffffffffffffffffffffffffffffffffffffff1602179055505060ab806101196000396000f3fe608060405273ffffffffffffffffffffffffffffffffffffffff600054167fa619486e0000000000000000000000000000000000000000000000000000000060003514156050578060005260206000f35b3660008037600080366000845af43d6000803e60008114156070573d6000fd5b3d6000f3fea2646970667358221220d1429297349653a4918076d650332de1a1068c5f3e07c5c82360c277770b955264736f6c63430007060033496e76616c69642073696e676c65746f6e20616464726573732070726f7669646564' as Hex

// The fake chains are plain objects; only an explicit `service.fetch` answers.
vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('No network in this test'))))
