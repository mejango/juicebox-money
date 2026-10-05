import { getAddress, keccak256, type Address, type Hex } from 'viem'
import { describe, expect, it, vi } from 'vitest'
import {
  isCanonicalSafeCreation,
  readAuthorityIdentity,
  readMatchingAuthorityIdentities,
} from '@/lib/cross-chain-authority'
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
        sourceClient: safe({ singleton: SAFE_130_EIP155_SINGLETON }),
        destinationClient: safe({ singleton: SAFE_130_EIP155_SINGLETON }),
        authority: AUTHORITY,
      }),
    ).resolves.toEqual({
      source: { kind: 'contract' },
      destination: { kind: 'contract' },
      matches: false,
    })
  })

  it('returns unknown rather than a mismatch when either chain cannot be read', async () => {
    await expect(
      readMatchingAuthorityIdentities({
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

// The fake chains are plain objects; no global fetch should ever run.
vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('No network in this test'))))
