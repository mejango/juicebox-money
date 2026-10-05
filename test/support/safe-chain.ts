import {
  decodeFunctionData,
  encodeFunctionResult,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem'
import { vi, type Mock } from 'vitest'

// One chain's view of a Safe, answered through the reads the SDK's
// readAuthorityIdentity makes: eth_getCode, eth_getStorageAt and raw
// eth_calls into the proxy.

/** The Safe getters the SDK calls through the proxy. */
export const SAFE_READ_ABI = [
  { type: 'function', name: 'masterCopy', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'VERSION', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'getThreshold', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'getOwners', stateMutability: 'view', inputs: [], outputs: [{ type: 'address[]' }] },
  {
    type: 'function',
    name: 'getModulesPaginated',
    stateMutability: 'view',
    inputs: [{ type: 'address', name: 'start' }, { type: 'uint256', name: 'pageSize' }],
    outputs: [{ type: 'address[]' }, { type: 'address' }],
  },
  { type: 'function', name: 'nonce', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
] as const

/** Safe 1.3.0's canonical singleton. */
export const SAFE_130_SINGLETON = '0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552' as Address
/** Safe 1.3.0's EIP-155 singleton, which the SDK recognizes and this app does not. */
export const SAFE_130_EIP155_SINGLETON = '0x69f4D1788e39c87893C980c06EdF4b7f686e2938' as Address

/**
 * The runtime the canonical Safe 1.3.0 proxy factory deploys: real proxy code,
 * so a small fake contract cannot pass the recognizer in these tests either.
 */
export const SAFE_130_PROXY_RUNTIME =
  '0x608060405273ffffffffffffffffffffffffffffffffffffffff600054167fa619486e0000000000000000000000000000000000000000000000000000000060003514156050578060005260206000f35b3660008037600080366000845af43d6000803e60008114156070573d6000fd5b3d6000f3fea2646970667358221220d1429297349653a4918076d650332de1a1068c5f3e07c5c82360c277770b955264736f6c63430007060033' as Hex

const SINGLETON_SLOT = `0x${'0'.repeat(64)}`
const GUARD_SLOT = '0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8'
const FALLBACK_SLOT = '0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5'
const SENTINEL = '0x0000000000000000000000000000000000000001' as Address

export type SafeChainOptions = {
  /** The Safe's address. */
  authority: Address
  owners: Address[]
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
  nonce?: bigint
  /** Code at other addresses (an owner's, say); every other address has none. */
  codes?: Readonly<Record<string, Hex>>
  /** Every RPC read fails. */
  unavailable?: boolean
}

export type SafeChain = PublicClient & {
  getCode: Mock
  getStorageAt: Mock
  request: Mock
}

function word(address: Address): Hex {
  return `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}`
}

export function safeChain({
  authority,
  owners,
  threshold = BigInt(owners.length),
  modules = [],
  moduleNext = SENTINEL,
  singleton = SAFE_130_SINGLETON,
  masterCopy = singleton,
  singletonCode = '0x60006000',
  version = '1.3.0',
  guard = zeroAddress,
  fallbackHandler = '0xf48f2B2d2a534e402487b3ee7C18c33Aec0Fe5e4',
  fallbackHandlerCode = '0x60016000',
  proxyCode = SAFE_130_PROXY_RUNTIME,
  nonce = 0n,
  codes = {},
  unavailable = false,
}: SafeChainOptions): SafeChain {
  const codeAt = new Map<string, Hex>(
    Object.entries(codes).map(([address, code]) => [address.toLowerCase(), code]),
  )
  codeAt.set(singleton.toLowerCase(), singletonCode)
  if (fallbackHandler.toLowerCase() !== zeroAddress) {
    codeAt.set(fallbackHandler.toLowerCase(), fallbackHandlerCode)
  }
  codeAt.set(authority.toLowerCase(), proxyCode)
  const failIfUnavailable = () => {
    if (unavailable) throw new Error('RPC unavailable')
  }
  return {
    getCode: vi.fn(async ({ address }: { address: Address }) => {
      failIfUnavailable()
      return codeAt.get(address.toLowerCase())
    }),
    getStorageAt: vi.fn(async ({ slot }: { slot: Hex }) => {
      failIfUnavailable()
      if (slot === SINGLETON_SLOT) return word(singleton)
      if (slot === GUARD_SLOT) return word(guard)
      if (slot === FALLBACK_SLOT) return word(fallbackHandler)
      throw new Error(`Unexpected storage slot ${slot}`)
    }),
    request: vi.fn(async ({ method, params }: { method: string; params: [{ to: Address; data: Hex }] }) => {
      failIfUnavailable()
      if (method !== 'eth_call' || params[0].to.toLowerCase() !== authority.toLowerCase()) {
        throw new Error(`Unexpected ${method}`)
      }
      const { functionName } = decodeFunctionData({ abi: SAFE_READ_ABI, data: params[0].data })
      switch (functionName) {
        case 'masterCopy':
          return encodeFunctionResult({ abi: SAFE_READ_ABI, functionName, result: masterCopy })
        case 'VERSION':
          return encodeFunctionResult({ abi: SAFE_READ_ABI, functionName, result: version })
        case 'getThreshold':
          return encodeFunctionResult({ abi: SAFE_READ_ABI, functionName, result: threshold })
        case 'getOwners':
          return encodeFunctionResult({ abi: SAFE_READ_ABI, functionName, result: owners })
        case 'getModulesPaginated':
          return encodeFunctionResult({ abi: SAFE_READ_ABI, functionName, result: [modules, moduleNext] })
        case 'nonce':
          return encodeFunctionResult({ abi: SAFE_READ_ABI, functionName, result: nonce })
      }
    }),
  } as unknown as SafeChain
}

/** A chain where `address` has no code. */
export function emptyChain(code: Hex | undefined = undefined): SafeChain {
  return {
    getCode: vi.fn(async () => code),
    getStorageAt: vi.fn(),
    request: vi.fn(),
  } as unknown as SafeChain
}
